import { Business, IdParams, Problem, ServiceList, StaffList } from '@erc/contracts';
import type { AppInstance } from '../../app.ts';
import { ProblemError } from '../../http/problems.ts';
import {
  findActiveService,
  getBusiness,
  listActiveServices,
  listStaffForService,
} from './repository.ts';

export function catalogRoutes(app: AppInstance): void {
  app.get(
    '/business',
    {
      schema: {
        summary: 'Företagets namn, tidszon och bokningspolicy',
        response: { 200: Business },
      },
    },
    () => getBusiness(app.deps.db),
  );

  app.get(
    '/services',
    { schema: { summary: 'Aktiva tjänster', response: { 200: ServiceList } } },
    async () => ({ items: await listActiveServices(app.deps.db) }),
  );

  app.get(
    '/services/:id/staff',
    {
      schema: {
        summary: 'Personal som utför tjänsten',
        params: IdParams,
        response: { 200: StaffList, 404: Problem },
      },
    },
    async (request) => {
      if ((await findActiveService(app.deps.db, request.params.id)) === undefined) {
        throw new ProblemError('not-found', 404);
      }
      return { items: await listStaffForService(app.deps.db, request.params.id) };
    },
  );
}
