import { Type, type Static } from 'typebox';

export const HealthResponse = Type.Object(
  {
    status: Type.Literal('ok'),
    database: Type.Literal('ok'),
    time: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type HealthResponse = Static<typeof HealthResponse>;
