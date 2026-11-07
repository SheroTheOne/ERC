import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import type { Config } from './config.ts';
import type { Database } from './db/database.ts';
import { ProblemError, sendProblem, toProblem } from './http/problems.ts';
import { registerAuth } from './http/auth.ts';
import { authRoutes } from './modules/auth/routes.ts';
import { availabilityRoutes } from './modules/availability/routes.ts';
import { bookingRoutes } from './modules/bookings/routes.ts';
import { catalogRoutes } from './modules/catalog/routes.ts';
import { customerRoutes } from './modules/customers/routes.ts';
import { healthRoutes } from './modules/health/routes.ts';
import { staffRoutes } from './modules/staff/routes.ts';
import type { Clock } from './shared/clock.ts';
import type { Mailer } from './shared/mailer.ts';

export interface AppDeps {
  readonly config: Config;
  readonly db: Database;
  readonly clock: Clock;
  readonly mailer: Mailer;
}

export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export const API_PREFIX = '/api/v1';

export interface BuildAppOptions {
  readonly logger?: FastifyServerOptions['logger'];
}

/** Bygger appen utan att lyssna på en port, så att tester kan använda app.inject(). */
export async function buildApp(deps: AppDeps, options: BuildAppOptions = {}): Promise<AppInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: 64 * 1024,
    // Fastify registrerar ajv-formats själv (date-time, uri, email med flera).
    ajv: {
      customOptions: {
        // Okända fält ska ge 400, inte tas bort tyst (ADR-0007).
        removeAdditional: false,
        coerceTypes: 'array',
        useDefaults: true,
        allErrors: false,
      },
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorate('deps', deps);

  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    const problem = toProblem(error);
    if (problem.status >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.debug({ err: error }, 'request rejected');
    }
    return sendProblem(reply, request, problem);
  });

  await registerAuth(app);

  await app.register(
    (api, _options, done) => {
      healthRoutes(api);
      catalogRoutes(api);
      availabilityRoutes(api);
      bookingRoutes(api);
      authRoutes(api);
      staffRoutes(api);
      customerRoutes(api);
      done();
    },
    { prefix: API_PREFIX },
  );

  const webDistDir = deps.config.webDistDir;
  const indexHtml = webDistDir === undefined ? undefined : path.join(webDistDir, 'index.html');
  if (webDistDir !== undefined && indexHtml !== undefined && existsSync(indexHtml)) {
    await app.register(fastifyStatic, { root: path.resolve(webDistDir), wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    // Klientrouting: okända GET-sökvägar utanför API:t får webbappens index.html.
    if (
      indexHtml !== undefined &&
      request.method === 'GET' &&
      !request.url.startsWith(API_PREFIX) &&
      existsSync(indexHtml)
    ) {
      return reply.sendFile('index.html');
    }
    return sendProblem(reply, request, new ProblemError('not-found', 404));
  });

  return app;
}
