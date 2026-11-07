import fastifyCookie from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppInstance } from '../app.ts';
import { validateSession, type Actor, type Role } from '../auth/sessions.ts';
import { toInstant } from '../shared/time.ts';
import { ProblemError } from './problems.ts';

/** `__Host-` kräver Secure, Path=/ och ingen Domain, så att cookien inte kan sättas av en subdomän. */
export const SESSION_COOKIE = '__Host-erc_session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'fastify' {
  interface FastifyRequest {
    /** Inloggad användare, eller null för anonyma anrop. */
    actor: Actor | null;
    sessionIdHash: Buffer | null;
  }
}

export async function registerAuth(app: AppInstance): Promise<void> {
  await app.register(fastifyCookie);
  app.decorateRequest('actor', null);
  app.decorateRequest('sessionIdHash', null);

  app.addHook('onRequest', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token === undefined) return;

    // CSRF (ADR-0008): anrop som ändrar data och bär sessionscookien måste komma
    // från vår egen origin. SameSite=Lax täcker det mesta, det här täcker resten.
    if (
      !SAFE_METHODS.has(request.method) &&
      request.headers.origin !== app.deps.config.publicOrigin
    ) {
      throw new ProblemError('forbidden', 403, {
        detail: 'Förfrågan kommer från en annan origin.',
      });
    }

    const session = await validateSession(app.deps.db, token, toInstant(app.deps.clock.now()));
    if (session === undefined) {
      // Utgången eller återkallad session: ta bort cookien och fortsätt som anonym.
      clearSessionCookie(reply);
      return;
    }
    request.actor = session.actor;
    request.sessionIdHash = session.idHash;
    if (session.renewedUntil !== undefined) {
      setSessionCookie(reply, token, session.renewedUntil, toInstant(app.deps.clock.now()));
    }
  });
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Temporal.Instant,
  now: Temporal.Instant,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.max(0, Math.floor(now.until(expiresAt).total('seconds'))),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
}

/**
 * Kräver inloggning med någon av rollerna. 401 utan session, 403 med fel roll.
 * Admin får alltid det personal får (ADR-0008).
 */
export function authorize(request: FastifyRequest, ...roles: readonly Role[]): Actor {
  const actor = request.actor;
  if (actor === null) throw new ProblemError('unauthenticated', 401);
  const allowed = roles.includes(actor.role) || (actor.role === 'admin' && roles.includes('staff'));
  if (!allowed) throw new ProblemError('forbidden', 403);
  return actor;
}

/** Personal får ändra sitt eget schema, administratörer allas. */
export function authorizeOwnStaffOrAdmin(request: FastifyRequest, staffId: string): Actor {
  const actor = authorize(request, 'staff', 'admin');
  if (actor.role !== 'admin' && actor.staffId !== staffId) throw new ProblemError('forbidden', 403);
  return actor;
}

export function isStaff(
  actor: Actor | null,
): actor is Actor & { readonly role: 'staff' | 'admin' } {
  return actor !== null && (actor.role === 'staff' || actor.role === 'admin');
}
