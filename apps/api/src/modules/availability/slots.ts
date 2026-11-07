/**
 * Ren funktion som gör om fria intervall till starttider för en tjänst (ADR-0005).
 * Inga sidoeffekter och ingen klocka: samma indata ger alltid samma utdata.
 */

/** Halvöppet intervall [start, end) i absolut tid. */
export interface Period {
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
}

export interface SlotRules {
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  /** Rutnätet förankras i lokal tid: 09:00, 09:15 … oavsett UTC-offset (ADR-0004). */
  readonly stepMinutes: number;
  readonly timeZone: string;
  /** Tidigaste tillåtna start, inklusive (policy för framförhållning). */
  readonly notBefore: Temporal.Instant;
  /** Senaste tillåtna start, inklusive (policy för bokningshorisont). */
  readonly notAfter: Temporal.Instant;
}

const MAX_ALIGNMENT_STEPS = 4;

/**
 * Starttider s där [s − bufferBefore, s + duration + bufferAfter) ryms helt i ett
 * fritt intervall, s ligger på rutnätet och notBefore ≤ s ≤ notAfter.
 * Fria intervall förutsätts vara sorterade och disjunkta, vilket en
 * tstzmultirange alltid är. Resultatet är då också sorterat och utan dubbletter.
 */
export function generateSlots(free: readonly Period[], rules: SlotRules): Temporal.Instant[] {
  assertRules(rules);
  const slots: Temporal.Instant[] = [];

  for (const period of free) {
    const earliest = max(period.start.add({ minutes: rules.bufferBeforeMinutes }), rules.notBefore);
    const latest = min(
      period.end.subtract({ minutes: rules.durationMinutes + rules.bufferAfterMinutes }),
      rules.notAfter,
    );

    let candidate = alignUp(earliest, rules);
    while (Temporal.Instant.compare(candidate, latest) <= 0) {
      slots.push(candidate);
      candidate = alignUp(candidate.add({ minutes: rules.stepMinutes }), rules);
    }
  }

  return slots;
}

/** Den lokala kalenderdag som en tidpunkt tillhör i den givna tidszonen. */
export function localDate(instant: Temporal.Instant, timeZone: string): Temporal.PlainDate {
  return instant.toZonedDateTimeISO(timeZone).toPlainDate();
}

/**
 * Första tidpunkt ≥ instant vars lokala klockslag är en multipel av steget räknat
 * från lokal midnatt. Efter en offsetändring som inte är en multipel av steget
 * (till exempel 30 minuter i Australia/Lord_Howe) justeras kandidaten igen.
 */
function alignUp(instant: Temporal.Instant, rules: SlotRules): Temporal.Instant {
  let current = instant;
  for (let attempt = 0; attempt < MAX_ALIGNMENT_STEPS; attempt++) {
    const zoned = current.toZonedDateTimeISO(rules.timeZone);
    const minuteOfDay = zoned.hour * 60 + zoned.minute;
    const hasSubMinute =
      zoned.second !== 0 ||
      zoned.millisecond !== 0 ||
      zoned.microsecond !== 0 ||
      zoned.nanosecond !== 0;
    const remainder = minuteOfDay % rules.stepMinutes;
    if (remainder === 0 && !hasSubMinute) return current;

    const floored = zoned.round({ smallestUnit: 'minute', roundingMode: 'floor' });
    current = floored.add({ minutes: rules.stepMinutes - remainder }).toInstant();
  }
  throw new Error(`Could not align ${instant.toString()} to a ${rules.stepMinutes}-minute grid`);
}

function assertRules(rules: SlotRules): void {
  if (
    !Number.isInteger(rules.stepMinutes) ||
    rules.stepMinutes <= 0 ||
    60 % rules.stepMinutes !== 0
  ) {
    throw new RangeError('stepMinutes must be a positive divisor of 60');
  }
  for (const [name, value] of [
    ['durationMinutes', rules.durationMinutes],
    ['bufferBeforeMinutes', rules.bufferBeforeMinutes],
    ['bufferAfterMinutes', rules.bufferAfterMinutes],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || (name === 'durationMinutes' && value === 0)) {
      throw new RangeError(
        `${name} must be a ${name === 'durationMinutes' ? 'positive' : 'non-negative'} integer`,
      );
    }
  }
}

function max(a: Temporal.Instant, b: Temporal.Instant): Temporal.Instant {
  return Temporal.Instant.compare(a, b) >= 0 ? a : b;
}

function min(a: Temporal.Instant, b: Temporal.Instant): Temporal.Instant {
  return Temporal.Instant.compare(a, b) <= 0 ? a : b;
}
