import {
  CreateStaffRequest,
  CreateTimeOffRequest,
  CreateTimeOffResponse,
  IdParams,
  Problem,
  ReplaceWorkingHoursRequest,
  ReplaceWorkingHoursResponse,
  StaffMember,
  StaffMemberList,
  StaffServicesRequest,
  StaffTimeOffParams,
  TimeOffList,
  TimeOffQuery,
  UpdateStaffRequest,
  WorkingHoursQuery,
  WorkingHoursResponse,
} from '@erc/contracts';
import type { AppInstance } from '../../app.ts';
import { authorize, authorizeOwnStaffOrAdmin } from '../../http/auth.ts';
import {
  addTimeOff,
  changeStaff,
  createStaff,
  getTimeOff,
  getWorkingHours,
  listStaff,
  removeTimeOff,
  setStaffServices,
  setWorkingHours,
} from './service.ts';

const errors = { 400: Problem, 401: Problem, 403: Problem, 404: Problem, 409: Problem };

/**
 * Behörighet (ADR-0008): personal läser all personal och alla scheman, men
 * ändrar bara sitt eget schema och sin egen frånvaro. Administratörer får allt.
 */
export function staffRoutes(app: AppInstance): void {
  app.get(
    '/staff',
    { schema: { summary: 'All personal', response: { 200: StaffMemberList, ...errors } } },
    async (request) => {
      authorize(request, 'staff');
      return { items: await listStaff(app.deps) };
    },
  );

  app.post(
    '/staff',
    {
      schema: {
        summary: 'Lägg till personal (admin)',
        body: CreateStaffRequest,
        response: { 201: StaffMember, ...errors },
      },
    },
    async (request, reply) => {
      authorize(request, 'admin');
      const member = await createStaff(app.deps, request.body);
      return reply.status(201).header('location', `${app.prefix}/staff/${member.id}`).send(member);
    },
  );

  app.patch(
    '/staff/:id',
    {
      schema: {
        summary: 'Ändra namn, roll eller aktiv status (admin)',
        params: IdParams,
        body: UpdateStaffRequest,
        response: { 200: StaffMember, ...errors },
      },
    },
    (request) =>
      changeStaff(app.deps, authorize(request, 'admin'), request.params.id, request.body),
  );

  app.put(
    '/staff/:id/services',
    {
      schema: {
        summary: 'Ange vilka tjänster personen utför (admin)',
        params: IdParams,
        body: StaffServicesRequest,
        response: { 200: StaffMember, ...errors },
      },
    },
    (request) => {
      authorize(request, 'admin');
      return setStaffServices(app.deps, request.params.id, request.body.serviceIds);
    },
  );

  app.get(
    '/staff/:id/working-hours',
    {
      schema: {
        summary: 'Arbetstider som gäller ett datum',
        params: IdParams,
        querystring: WorkingHoursQuery,
        response: { 200: WorkingHoursResponse, ...errors },
      },
    },
    (request) => {
      authorize(request, 'staff');
      return getWorkingHours(app.deps, request.params.id, request.query.at);
    },
  );

  app.put(
    '/staff/:id/working-hours',
    {
      schema: {
        summary: 'Ersätt veckoschemat från ett datum (egen personal eller admin)',
        params: IdParams,
        body: ReplaceWorkingHoursRequest,
        response: { 200: ReplaceWorkingHoursResponse, ...errors },
      },
    },
    (request) => {
      authorizeOwnStaffOrAdmin(request, request.params.id);
      return setWorkingHours(app.deps, request.params.id, request.body);
    },
  );

  app.get(
    '/staff/:id/time-off',
    {
      schema: {
        summary: 'Frånvaro inom ett intervall (standard: kommande 90 dagar)',
        params: IdParams,
        querystring: TimeOffQuery,
        response: { 200: TimeOffList, ...errors },
      },
    },
    async (request) => {
      authorize(request, 'staff');
      return { items: await getTimeOff(app.deps, request.params.id, request.query) };
    },
  );

  app.post(
    '/staff/:id/time-off',
    {
      schema: {
        summary: 'Lägg in frånvaro (egen personal eller admin)',
        params: IdParams,
        body: CreateTimeOffRequest,
        response: { 201: CreateTimeOffResponse, ...errors },
      },
    },
    async (request, reply) => {
      const actor = authorizeOwnStaffOrAdmin(request, request.params.id);
      const result = await addTimeOff(app.deps, actor, request.params.id, request.body);
      return reply.status(201).send(result);
    },
  );

  app.delete(
    '/staff/:id/time-off/:timeOffId',
    {
      schema: {
        summary: 'Ta bort frånvaro (egen personal eller admin)',
        params: StaffTimeOffParams,
        response: { 204: { type: 'null' }, ...errors },
      },
    },
    async (request, reply) => {
      authorizeOwnStaffOrAdmin(request, request.params.id);
      await removeTimeOff(app.deps, request.params.id, request.params.timeOffId);
      return reply.status(204).send(null);
    },
  );
}
