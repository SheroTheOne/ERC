/** Hjälpfunktioner för gränsen mellan databasens ISO-strängar och Temporal (ADR-0004). */

export function toInstant(value: string | Date): Temporal.Instant {
  return typeof value === 'string'
    ? Temporal.Instant.from(value)
    : Temporal.Instant.fromEpochMilliseconds(value.getTime());
}

/** ISO 8601 i UTC utan bråkdelar av sekunder när de är noll: 2026-03-30T07:00:00Z. */
export function toIso(instant: Temporal.Instant): string {
  return instant.toString({ smallestUnit: 'second' });
}

/** Lokal midnatt i början av dagen. Hanterar dagar som inte börjar 00:00 vid sommartid. */
export function startOfLocalDay(date: Temporal.PlainDate, timeZone: string): Temporal.Instant {
  return date.toZonedDateTime({ timeZone }).toInstant();
}

export function parseLocalDate(value: string): Temporal.PlainDate | undefined {
  try {
    return Temporal.PlainDate.from(value, { overflow: 'reject' });
  } catch {
    return undefined;
  }
}
