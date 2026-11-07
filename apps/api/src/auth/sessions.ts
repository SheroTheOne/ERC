import type { Kysely } from 'kysely';
import type { DB } from '../db/types.ts';
import { generateToken, hashToken, isWellFormedToken } from '../shared/tokens.ts';
import { toIso } from '../shared/time.ts';

export type Role = 'customer' | 'staff' | 'admin';

export interface Actor {
  readonly userId: string;
  readonly email: string;
  readonly role: Role;
  /** Satt för personal och administratörer som också arbetar. */
  readonly staffId: string | null;
  /** Satt för kunder som har loggat in med e-postlänk. */
  readonly customerId: string | null;
}

export interface ValidatedSession {
  readonly actor: Actor;
  readonly idHash: Buffer;
  /** Satt när sessionen förlängdes och cookien ska skickas på nytt. */
  readonly renewedUntil: Temporal.Instant | undefined;
}

/** Glidande livslängd: 30 dagar för kunder, 12 timmar för personal (ADR-0008). */
export function sessionLifetime(role: Role): Temporal.Duration {
  return role === 'customer'
    ? Temporal.Duration.from({ hours: 24 * 30 })
    : Temporal.Duration.from({ hours: 12 });
}

/** Sessionen förlängs högst en gång per timme, för att inte skriva vid varje anrop. */
const RENEWAL_INTERVAL = Temporal.Duration.from({ hours: 1 });

const ROLES: readonly Role[] = ['customer', 'staff', 'admin'];

function toRole(value: string): Role {
  const role = ROLES.find((candidate) => candidate === value);
  if (role === undefined) throw new Error(`Unknown role in database: ${value}`);
  return role;
}

export async function createSession(
  db: Kysely<DB>,
  input: { userId: string; role: Role; now: Temporal.Instant },
): Promise<{ token: string; expiresAt: Temporal.Instant }> {
  const token = generateToken();
  const expiresAt = input.now.add(sessionLifetime(input.role));
  await db
    .insertInto('session')
    .values({
      idHash: hashToken(token),
      userId: input.userId,
      createdAt: toIso(input.now),
      lastSeenAt: toIso(input.now),
      expiresAt: toIso(expiresAt),
    })
    .execute();
  return { token, expiresAt };
}

/** Slår upp en session. Utgången session eller avstängt konto ger undefined. */
export async function validateSession(
  db: Kysely<DB>,
  token: string,
  now: Temporal.Instant,
): Promise<ValidatedSession | undefined> {
  if (!isWellFormedToken(token)) return undefined;
  const idHash = hashToken(token);

  const row = await db
    .selectFrom('session')
    .innerJoin('appUser', 'appUser.id', 'session.userId')
    .leftJoin('staff', 'staff.userId', 'appUser.id')
    .leftJoin('customer', 'customer.userId', 'appUser.id')
    .select([
      'appUser.id as userId',
      'appUser.email',
      'appUser.role',
      'staff.id as staffId',
      'customer.id as customerId',
      'session.lastSeenAt',
    ])
    .where('session.idHash', '=', idHash)
    .where('session.expiresAt', '>', toIso(now))
    .where('appUser.disabledAt', 'is', null)
    .executeTakeFirst();
  if (row === undefined) return undefined;

  const role = toRole(row.role);
  const actor: Actor = {
    userId: row.userId,
    email: row.email,
    role,
    staffId: row.staffId,
    customerId: row.customerId,
  };

  const lastSeen = Temporal.Instant.from(row.lastSeenAt);
  if (Temporal.Instant.compare(now, lastSeen.add(RENEWAL_INTERVAL)) < 0) {
    return { actor, idHash, renewedUntil: undefined };
  }
  const renewedUntil = now.add(sessionLifetime(role));
  await db
    .updateTable('session')
    .set({ lastSeenAt: toIso(now), expiresAt: toIso(renewedUntil) })
    .where('idHash', '=', idHash)
    .execute();
  return { actor, idHash, renewedUntil };
}

export async function deleteSession(db: Kysely<DB>, idHash: Buffer): Promise<void> {
  await db.deleteFrom('session').where('idHash', '=', idHash).execute();
}

/** Återkallar alla sessioner för en användare, till exempel vid anonymisering. */
export async function deleteSessionsForUser(db: Kysely<DB>, userId: string): Promise<void> {
  await db.deleteFrom('session').where('userId', '=', userId).execute();
}
