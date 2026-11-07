import {
  LoginRequest,
  MagicLinkRequest,
  MagicLinkVerifyRequest,
  Me,
  Problem,
} from '@erc/contracts';
import type { AppInstance } from '../../app.ts';
import { deleteSession } from '../../auth/sessions.ts';
import { authorize, clearSessionCookie, setSessionCookie } from '../../http/auth.ts';
import { login, requestLoginLink, toMe, verifyLoginLink } from './service.ts';

export function authRoutes(app: AppInstance): void {
  app.post(
    '/auth/login',
    {
      schema: {
        summary: 'Logga in personal eller administratör med lösenord',
        body: LoginRequest,
        response: { 204: { type: 'null' }, 400: Problem, 401: Problem },
      },
    },
    async (request, reply) => {
      // En ny session vid varje inloggning skyddar mot session fixation.
      if (request.sessionIdHash !== null) await deleteSession(app.deps.db, request.sessionIdHash);
      const session = await login({ ...app.deps, log: request.log }, request.body);
      setSessionCookie(reply, session.token, session.expiresAt, session.now);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/auth/magic-link',
    {
      schema: {
        summary: 'Skicka en inloggningslänk till en kund. Svarar alltid 202',
        body: MagicLinkRequest,
        response: { 202: { type: 'null' }, 400: Problem },
      },
    },
    async (request, reply) => {
      await requestLoginLink({ ...app.deps, log: request.log }, request.body.email);
      return reply.status(202).send(null);
    },
  );

  app.post(
    '/auth/magic-link/verify',
    {
      schema: {
        summary: 'Lös in en inloggningslänk',
        body: MagicLinkVerifyRequest,
        response: { 204: { type: 'null' }, 400: Problem, 401: Problem },
      },
    },
    async (request, reply) => {
      if (request.sessionIdHash !== null) await deleteSession(app.deps.db, request.sessionIdHash);
      const session = await verifyLoginLink({ ...app.deps, log: request.log }, request.body.token);
      setSessionCookie(reply, session.token, session.expiresAt, session.now);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/auth/logout',
    { schema: { summary: 'Logga ut', response: { 204: { type: 'null' } } } },
    async (request, reply) => {
      if (request.sessionIdHash !== null) await deleteSession(app.deps.db, request.sessionIdHash);
      clearSessionCookie(reply);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/me',
    { schema: { summary: 'Den inloggade användaren', response: { 200: Me, 401: Problem } } },
    (request) => toMe(authorize(request, 'customer', 'staff', 'admin')),
  );
}
