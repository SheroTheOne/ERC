import { Type } from 'typebox';

export const Uuid = Type.String({ format: 'uuid' });

/** Tidpunkt i ISO 8601 med offset. Servern svarar alltid i UTC (`Z`), ADR-0004. */
export const Instant = Type.String({ format: 'date-time' });

/** Lokal kalenderdag i företagets tidszon. */
export const LocalDate = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });

export const IdParams = Type.Object({ id: Uuid }, { additionalProperties: false });
