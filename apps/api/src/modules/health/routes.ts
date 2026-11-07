import { HealthResponse, Problem } from '@erc/contracts';
import { sql } from 'kysely';
import type { AppInstance } from '../../app.ts';
import { ProblemError } from '../../http/problems.ts';

export function healthRoutes(app: AppInstance): void {
  app.get(
    '/health',
    {
      schema: {
        summary: 'Kontrollera att API:t och databasen svarar',
        response: { 200: HealthResponse, 503: Problem },
      },
    },
    async (_request, reply) => {
      try {
        // Väntetiden begränsas av poolens connectionTimeoutMillis.
        await sql`SELECT 1`.execute(app.deps.db);
      } catch (error) {
        throw new ProblemError('service-unavailable', 503, { cause: error });
      }
      return reply.header('cache-control', 'no-store').send({
        status: 'ok',
        database: 'ok',
        time: app.deps.clock.now().toISOString(),
      });
    },
  );
}
