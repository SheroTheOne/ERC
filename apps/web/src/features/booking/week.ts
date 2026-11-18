import { addDays, daysBetween, startOfWeek } from '../../lib/time.ts';

export interface WeekWindow {
  /** Veckans sju dagar, måndag till söndag. */
  readonly days: readonly string[];
  /** Det intervall som går att boka i veckan, eller null om ingen dag går. */
  readonly range: { readonly from: string; readonly to: string } | null;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

/**
 * Vilka dagar i en vecka som är värda att fråga API:t om: inte före idag och inte efter
 * bokningshorisonten. Servern avgör ändå exakt vilka tider som går (minimal framförhållning m.m.).
 */
export function weekWindow(weekStart: string, today: string, horizonDays: number): WeekWindow {
  const lastDay = addDays(today, horizonDays);
  const weekEnd = addDays(weekStart, 6);
  const from = weekStart < today ? today : weekStart;
  const to = weekEnd > lastDay ? lastDay : weekEnd;
  return {
    days: Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)),
    range: from <= to ? { from, to } : null,
    hasPrevious: weekStart > startOfWeek(today),
    hasNext: daysBetween(addDays(weekStart, 7), lastDay) >= 0,
  };
}
