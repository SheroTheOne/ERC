import type { Business, Service, Slot, StaffSummary } from '@erc/contracts';
import { api } from '../../lib/api.ts';
import { addDays, dayLabels, formatPrice, formatTime, isoWeek } from '../../lib/time.ts';
import { type Resource, useResource } from '../../lib/useResource.ts';
import { StepHeading } from './StepHeading.tsx';
import { weekWindow } from './week.ts';

const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function SlotStep({
  business,
  service,
  staff,
  staffId,
  onStaffChange,
  today,
  weekStart,
  onWeekChange,
  selectedDate,
  onDateChange,
  reloadToken,
  notice,
  onSelect,
  onBack,
}: {
  readonly business: Business;
  readonly service: Service;
  readonly staff: Resource<{ readonly items: readonly StaffSummary[] }>;
  readonly staffId: string | undefined;
  readonly onStaffChange: (staffId: string | undefined) => void;
  readonly today: string;
  readonly weekStart: string;
  readonly onWeekChange: (weekStart: string) => void;
  readonly selectedDate: string | null;
  readonly onDateChange: (date: string) => void;
  readonly reloadToken: number;
  readonly notice: string | null;
  readonly onSelect: (slot: Slot) => void;
  readonly onBack: () => void;
}) {
  const week = weekWindow(weekStart, today, business.bookingHorizonDays);
  const availability = useResource(
    api.availability,
    week.range === null ? null : { serviceId: service.id, staffId, ...week.range },
    reloadToken,
  );

  const slotsByDate = new Map<string, readonly Slot[]>();
  if (availability.status === 'ok') {
    for (const day of availability.data.days) slotsByDate.set(day.date, day.slots);
  }
  // Utan ett aktivt val visas första dagen med lediga tider.
  const activeDate =
    selectedDate ?? week.days.find((date) => (slotsByDate.get(date)?.length ?? 0) > 0) ?? null;
  const activeSlots = activeDate === null ? [] : (slotsByDate.get(activeDate) ?? []);

  return (
    <section aria-labelledby="step-title">
      <StepHeading onBack={onBack}>
        {service.name} · {service.durationMinutes} min · {formatPrice(service.priceOre)}
      </StepHeading>

      {notice !== null && (
        <p className="notice" role="alert">
          {notice}
        </p>
      )}

      <label className="field">
        <span>Personal</span>
        <select
          value={staffId ?? ''}
          onChange={(event) => {
            onStaffChange(event.target.value === '' ? undefined : event.target.value);
          }}
          disabled={staff.status !== 'ok'}
        >
          <option value="">Valfri</option>
          {staff.status === 'ok' &&
            staff.data.items.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
        </select>
      </label>

      <div className="week-nav">
        <button
          type="button"
          onClick={() => {
            onWeekChange(addDays(weekStart, -7));
          }}
          disabled={!week.hasPrevious}
          aria-label="Föregående vecka"
        >
          ◀
        </button>
        <span>v. {isoWeek(weekStart)}</span>
        <button
          type="button"
          onClick={() => {
            onWeekChange(addDays(weekStart, 7));
          }}
          disabled={!week.hasNext}
          aria-label="Nästa vecka"
        >
          ▶
        </button>
      </div>

      <div className="days" role="group" aria-label={`Dagar i vecka ${isoWeek(weekStart)}`}>
        {week.days.map((date) => {
          const labels = dayLabels(date);
          const count = slotsByDate.get(date)?.length ?? 0;
          return (
            <button
              key={date}
              type="button"
              className="day"
              aria-pressed={date === activeDate}
              aria-label={`${labels.long}, ${count === 0 ? 'inga lediga tider' : `${count} lediga tider`}`}
              disabled={availability.status !== 'ok' || count === 0}
              onClick={() => {
                onDateChange(date);
              }}
            >
              <span className="day-weekday">{labels.weekday}</span>
              <span className="day-number">{labels.day}</span>
            </button>
          );
        })}
      </div>

      <div aria-live="polite">
        {week.range === null && <p>Det går inte att boka så långt fram.</p>}
        {week.range !== null && availability.status === 'loading' && (
          <p role="status">Hämtar lediga tider …</p>
        )}
        {availability.status === 'error' && (
          <p className="notice" role="alert">
            Det gick inte att hämta lediga tider. Försök igen om en stund.
          </p>
        )}
        {availability.status === 'ok' && activeDate === null && (
          <p>Inga lediga tider den här veckan.</p>
        )}
        {availability.status === 'ok' && activeDate !== null && (
          <>
            <h3 className="slots-heading">{dayLabels(activeDate).long}</h3>
            {activeSlots.length === 0 ? (
              <p>Inga lediga tider den här dagen.</p>
            ) : (
              <ul className="slots">
                {activeSlots.map((slot) => (
                  <li key={slot.startsAt}>
                    <button
                      type="button"
                      className="slot"
                      onClick={() => {
                        onSelect(slot);
                      }}
                    >
                      {formatTime(slot.startsAt, business.timezone)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {browserTimezone !== business.timezone && (
        <p className="hint">Tiderna visas i företagets tidszon ({business.timezone}).</p>
      )}
    </section>
  );
}
