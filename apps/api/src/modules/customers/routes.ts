import {
  BookingList,
  Customer,
  CustomerExport,
  CustomerList,
  CustomerQuery,
  IdParams,
  Problem,
} from '@erc/contracts';
import type { AppInstance } from '../../app.ts';
import { authorize } from '../../http/auth.ts';
import { ProblemError } from '../../http/problems.ts';
import type { Actor } from '../../auth/sessions.ts';
import {
  anonymizeCustomer,
  customerBookings,
  exportCustomer,
  getCustomer,
  searchCustomers,
} from './service.ts';

const errors = { 400: Problem, 401: Problem, 403: Problem, 404: Problem };

/** En kundsession utan kopplad kund kan inte uppstå, men typen tillåter det. */
function ownCustomerId(actor: Actor): string {
  if (actor.customerId === null) throw new ProblemError('not-found', 404);
  return actor.customerId;
}

export function customerRoutes(app: AppInstance): void {
  app.get(
    '/customers',
    {
      schema: {
        summary: 'Sök kunder (personal)',
        querystring: CustomerQuery,
        response: { 200: CustomerList, ...errors },
      },
    },
    async (request) => {
      authorize(request, 'staff');
      return { items: await searchCustomers(app.deps, request.query) };
    },
  );

  app.get(
    '/customers/:id',
    {
      schema: {
        summary: 'En kund (personal)',
        params: IdParams,
        response: { 200: Customer, ...errors },
      },
    },
    (request) => {
      authorize(request, 'staff');
      return getCustomer(app.deps, request.params.id);
    },
  );

  app.get(
    '/customers/:id/export',
    {
      schema: {
        summary: 'Dataexport för en kund (admin, ADR-0010)',
        params: IdParams,
        response: { 200: CustomerExport, ...errors },
      },
    },
    (request) => {
      authorize(request, 'admin');
      return exportCustomer(app.deps, request.params.id);
    },
  );

  app.post(
    '/customers/:id/anonymize',
    {
      schema: {
        summary: 'Radera personuppgifter genom anonymisering (admin, ADR-0010)',
        params: IdParams,
        response: { 200: Customer, ...errors },
      },
    },
    (request) => {
      authorize(request, 'admin');
      return anonymizeCustomer(app.deps, request.params.id);
    },
  );

  app.get(
    '/me/bookings',
    { schema: { summary: 'Mina bokningar (kund)', response: { 200: BookingList, ...errors } } },
    async (request) => {
      const customerId = ownCustomerId(authorize(request, 'customer'));
      return { items: await customerBookings(app.deps, customerId) };
    },
  );

  app.get(
    '/me/export',
    {
      schema: {
        summary: 'Min dataexport (kund, ADR-0010)',
        response: { 200: CustomerExport, ...errors },
      },
    },
    (request) => exportCustomer(app.deps, ownCustomerId(authorize(request, 'customer'))),
  );
}
