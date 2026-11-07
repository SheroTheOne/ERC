import {
  Business,
  CreateServiceRequest,
  IdParams,
  Problem,
  ServiceAdmin,
  ServiceAdminList,
  ServiceList,
  StaffList,
  UpdateBusinessRequest,
  UpdateServiceRequest,
} from '@erc/contracts';
import type { AppInstance } from '../../app.ts';
import { authorize } from '../../http/auth.ts';
import { ProblemError } from '../../http/problems.ts';
import {
  findActiveService,
  getBusiness,
  insertService,
  listActiveServices,
  listAllServices,
  listStaffForService,
  updateBusiness,
  updateService,
} from './repository.ts';

const errors = { 400: Problem, 401: Problem, 403: Problem, 404: Problem };

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

  app.patch(
    '/business',
    {
      schema: {
        summary: 'Ändra företagets inställningar (admin)',
        body: UpdateBusinessRequest,
        response: { 200: Business, ...errors },
      },
    },
    (request) => {
      authorize(request, 'admin');
      return updateBusiness(app.deps.db, request.body);
    },
  );

  app.get(
    '/services/all',
    {
      schema: {
        summary: 'Alla tjänster, även inaktiva, med buffert (personal)',
        response: { 200: ServiceAdminList, ...errors },
      },
    },
    async (request) => {
      authorize(request, 'staff');
      return { items: await listAllServices(app.deps.db) };
    },
  );

  app.post(
    '/services',
    {
      schema: {
        summary: 'Skapa en tjänst (admin)',
        body: CreateServiceRequest,
        response: { 201: ServiceAdmin, ...errors },
      },
    },
    async (request, reply) => {
      authorize(request, 'admin');
      const service = await insertService(app.deps.db, request.body);
      return reply
        .status(201)
        .header('location', `${app.prefix}/services/${service.id}`)
        .send(service);
    },
  );

  app.patch(
    '/services/:id',
    {
      schema: {
        summary: 'Ändra eller inaktivera en tjänst (admin)',
        params: IdParams,
        body: UpdateServiceRequest,
        response: { 200: ServiceAdmin, ...errors },
      },
    },
    async (request) => {
      authorize(request, 'admin');
      const service = await updateService(app.deps.db, request.params.id, request.body);
      if (service === undefined) throw new ProblemError('not-found', 404);
      return service;
    },
  );
}
