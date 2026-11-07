/** Klockan injiceras så att domänkoden aldrig anropar Date.now() direkt (ADR-0009). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(instant: string | Date): Clock {
  const time = new Date(instant).getTime();
  return { now: () => new Date(time) };
}
