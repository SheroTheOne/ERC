import { AvailabilityQuery, AvailabilityResponse, Problem } from '@erc/contracts';
import type { AppInstance } from '../../app.ts';
import { getAvailability } from './service.ts';

export function availabilityRoutes(app: AppInstance): void {
  app.get(
    '/availability',
    {
      schema: {
        summary: 'Lediga tider för en tjänst, beräknade vid varje anrop (ADR-0005)',
        querystring: AvailabilityQuery,
        response: { 200: AvailabilityResponse, 400: Problem, 404: Problem },
      },
    },
    async (request, reply) => {
      const availability = await getAvailability(app.deps, request.query);
      return reply.header('cache-control', 'no-store').send(availability);
    },
  );
}
