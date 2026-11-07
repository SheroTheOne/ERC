import { Type, type Static } from 'typebox';
import { Uuid } from './common.ts';

export const Email = Type.String({ format: 'email', maxLength: 254 });

export const LoginRequest = Type.Object(
  { email: Email, password: Type.String({ minLength: 1, maxLength: 1024 }) },
  { additionalProperties: false },
);
export type LoginRequest = Static<typeof LoginRequest>;

export const MagicLinkRequest = Type.Object({ email: Email }, { additionalProperties: false });
export type MagicLinkRequest = Static<typeof MagicLinkRequest>;

export const MagicLinkVerifyRequest = Type.Object(
  { token: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false },
);
export type MagicLinkVerifyRequest = Static<typeof MagicLinkVerifyRequest>;

export const Role = Type.Union([
  Type.Literal('customer'),
  Type.Literal('staff'),
  Type.Literal('admin'),
]);
export type Role = Static<typeof Role>;

export const Me = Type.Object(
  {
    id: Uuid,
    email: Type.String(),
    role: Role,
    staffId: Type.Union([Uuid, Type.Null()]),
    customerId: Type.Union([Uuid, Type.Null()]),
  },
  { additionalProperties: false },
);
export type Me = Static<typeof Me>;
