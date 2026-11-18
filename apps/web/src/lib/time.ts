// Rena hjälpfunktioner för datum och tid. Allt visas i företagets tidszon (ADR-0004),
// och kalenderdagar hanteras som strängar (YYYY-MM-DD) för att inte blandas ihop med instanter.

const MS_PER_DAY = 86_400_000;

function toUtcDate(localDate: string): Date {
  const [year, month, day] = localDate.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Invalid local date: ${localDate}`);
  }
  return new Date(Date.UTC(year, month - 1, day));
}

function fromUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Dagens datum i en viss tidszon. */
export function todayInZone(timezone: string, now: Date = new Date()): string {
  // sv-SE formaterar som YYYY-MM-DD.
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addDays(localDate: string, days: number): string {
  return fromUtcDate(new Date(toUtcDate(localDate).getTime() + days * MS_PER_DAY));
}

/** 0 = måndag … 6 = söndag. */
export function weekday(localDate: string): number {
  return (toUtcDate(localDate).getUTCDay() + 6) % 7;
}

/** Måndagen i den vecka dagen tillhör. */
export function startOfWeek(localDate: string): string {
  return addDays(localDate, -weekday(localDate));
}

/** ISO 8601-veckonummer, som används i Sverige. */
export function isoWeek(localDate: string): number {
  const thursday = toUtcDate(addDays(localDate, 3 - weekday(localDate)));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - yearStart) / MS_PER_DAY / 7) + 1;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtcDate(to).getTime() - toUtcDate(from).getTime()) / MS_PER_DAY);
}

/** "09:00" i företagets tidszon. */
export function formatTime(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(instant));
}

/** "mån 30 mars 09:00–10:00" i företagets tidszon. */
export function formatSlotRange(startsAt: string, endsAt: string, timezone: string): string {
  const day = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'long',
  }).format(new Date(startsAt));
  return `${day} ${formatTime(startsAt, timezone)}–${formatTime(endsAt, timezone)}`;
}

/** Kort och lång etikett för en kalenderdag, t.ex. "mån" / "30" / "måndag 30 mars". */
export function dayLabels(localDate: string): {
  readonly weekday: string;
  readonly day: string;
  readonly long: string;
} {
  const date = toUtcDate(localDate);
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC', ...options }).format(date);
  return {
    weekday: format({ weekday: 'short' }),
    day: format({ day: 'numeric' }),
    long: format({ weekday: 'long', day: 'numeric', month: 'long' }),
  };
}

/** Pris i öre till "500 kr" eller "499,50 kr". */
export function formatPrice(priceOre: number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    minimumFractionDigits: priceOre % 100 === 0 ? 0 : 2,
  }).format(priceOre / 100);
}

/**
 * Gör om ett telefonnummer till E.164 som API:t kräver. Svenska nummer som börjar på 0
 * får +46. Returnerar undefined om numret inte går att tolka.
 */
export function normalizePhone(input: string): string | undefined {
  const compact = input.replace(/[\s\-().]/g, '');
  let candidate = compact;
  if (compact.startsWith('00')) candidate = `+${compact.slice(2)}`;
  else if (compact.startsWith('0')) candidate = `+46${compact.slice(1)}`;
  return /^\+[1-9][0-9]{6,14}$/.test(candidate) ? candidate : undefined;
}
