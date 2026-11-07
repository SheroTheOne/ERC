import type { LoginRequest, Me } from '@erc/contracts';
import type { FastifyBaseLogger } from 'fastify';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '../../auth/password.ts';
import { createSession, type Actor, type Role } from '../../auth/sessions.ts';
import type { Database } from '../../db/database.ts';
import { ProblemError } from '../../http/problems.ts';
import type { Clock } from '../../shared/clock.ts';
import type { Mailer } from '../../shared/mailer.ts';
import { generateToken, hashToken, isWellFormedToken } from '../../shared/tokens.ts';
import { toInstant, toIso } from '../../shared/time.ts';

export interface AuthDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly mailer: Mailer;
  readonly log: FastifyBaseLogger;
}

export interface NewSession {
  readonly token: string;
  readonly expiresAt: Temporal.Instant;
  readonly now: Temporal.Instant;
}

const LOGIN_LINK_LIFETIME = Temporal.Duration.from({ minutes: 15 });
/** Högst så här många inloggningslänkar per adress och kvart, så att ingen kan översvämma en inkorg. */
const MAX_LOGIN_LINKS_PER_WINDOW = 3;

const invalidCredentials = () =>
  new ProblemError('unauthenticated', 401, { detail: 'Fel e-postadress eller lösenord.' });

/**
 * Inloggning för personal och administratörer. Tar lika lång tid oavsett om
 * kontot finns, saknar lösenord eller är avstängt, och ger samma svar (ADR-0008).
 */
export async function login(deps: AuthDeps, input: LoginRequest): Promise<NewSession> {
  const user = await deps.db
    .selectFrom('appUser')
    .select(['id', 'role', 'passwordHash', 'disabledAt'])
    .where('email', '=', input.email)
    .executeTakeFirst();

  const valid = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (user === undefined || user.passwordHash === null || user.disabledAt !== null || !valid) {
    throw invalidCredentials();
  }
  if (user.role !== 'staff' && user.role !== 'admin') throw invalidCredentials();

  const now = toInstant(deps.clock.now());
  const session = await createSession(deps.db, { userId: user.id, role: user.role, now });
  return { ...session, now };
}

/**
 * Skickar en inloggningslänk till en kund som har bokat tidigare. Svaret är
 * alltid detsamma, så att det inte avslöjar vilka adresser som finns.
 */
export async function requestLoginLink(deps: AuthDeps, email: string): Promise<void> {
  const customer = await deps.db
    .selectFrom('customer')
    .select('id')
    .where('email', '=', email)
    .where('anonymizedAt', 'is', null)
    .executeTakeFirst();
  if (customer === undefined) return;

  const now = toInstant(deps.clock.now());
  const recent = await deps.db
    .selectFrom('loginToken')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('email', '=', email)
    .where('createdAt', '>', toIso(now.subtract(LOGIN_LINK_LIFETIME)))
    .executeTakeFirstOrThrow();
  if (Number(recent.count) >= MAX_LOGIN_LINKS_PER_WINDOW) {
    deps.log.warn('login link rate limit reached');
    return;
  }

  const token = generateToken();
  await deps.db
    .insertInto('loginToken')
    .values({
      tokenHash: hashToken(token),
      email,
      createdAt: toIso(now),
      expiresAt: toIso(now.add(LOGIN_LINK_LIFETIME)),
    })
    .execute();

  try {
    await deps.mailer.sendLoginLink({ to: email, token });
  } catch (error) {
    deps.log.error({ err: error }, 'failed to send login link');
  }
}

const invalidLink = () =>
  new ProblemError('unauthenticated', 401, { detail: 'Länken är ogiltig eller har gått ut.' });

/**
 * Löser in en inloggningslänk. Token kan bara användas en gång: förbrukningen
 * sker i samma UPDATE som kontrollen, så två samtidiga försök kan inte båda lyckas.
 */
export async function verifyLoginLink(deps: AuthDeps, token: string): Promise<NewSession> {
  if (!isWellFormedToken(token)) throw invalidLink();
  const now = toInstant(deps.clock.now());

  return deps.db.transaction().execute(async (trx) => {
    const consumed = await trx
      .updateTable('loginToken')
      .set({ consumedAt: toIso(now) })
      .where('tokenHash', '=', hashToken(token))
      .where('consumedAt', 'is', null)
      .where('expiresAt', '>', toIso(now))
      .returning('email')
      .executeTakeFirst();
    if (consumed === undefined) throw invalidLink();

    const customer = await trx
      .selectFrom('customer')
      .select(['id', 'userId'])
      .where('email', '=', consumed.email)
      .where('anonymizedAt', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (customer === undefined) throw invalidLink();

    let userId = customer.userId;
    if (userId === null) {
      const existing = await trx
        .selectFrom('appUser')
        .select(['id', 'role'])
        .where('email', '=', consumed.email)
        .executeTakeFirst();
      // Personalkonton loggar in med lösenord, aldrig med e-postlänk.
      if (existing !== undefined && existing.role !== 'customer') throw invalidLink();
      userId =
        existing?.id ??
        (
          await trx
            .insertInto('appUser')
            .values({ email: consumed.email, role: 'customer' })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      await trx.updateTable('customer').set({ userId }).where('id', '=', customer.id).execute();
    }

    const session = await createSession(trx, { userId, role: 'customer', now });
    return { ...session, now };
  });
}

export function toMe(actor: Actor): Me {
  return {
    id: actor.userId,
    email: actor.email,
    role: actor.role satisfies Role,
    staffId: actor.staffId,
    customerId: actor.customerId,
  };
}
