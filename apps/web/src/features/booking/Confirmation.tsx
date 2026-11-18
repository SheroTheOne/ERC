import type { Booking, Business } from '@erc/contracts';
import { formatPrice, formatSlotRange } from '../../lib/time.ts';
import { StepHeading } from './StepHeading.tsx';

export function Confirmation({
  business,
  booking,
  email,
  onRestart,
}: {
  readonly business: Business;
  readonly booking: Booking;
  readonly email: string;
  readonly onRestart: () => void;
}) {
  return (
    <section aria-labelledby="step-title">
      <StepHeading>Tiden är bokad</StepHeading>
      <dl className="summary">
        <dt>Tid</dt>
        <dd>{formatSlotRange(booking.startsAt, booking.endsAt, business.timezone)}</dd>
        <dt>Tjänst</dt>
        <dd>
          {booking.serviceName} hos {booking.staffName}
        </dd>
        <dt>Pris</dt>
        <dd>{formatPrice(booking.priceOre)}</dd>
      </dl>
      <p>
        En bekräftelse skickas till <strong>{email}</strong>. Där finns en länk för att avboka.
      </p>
      <button type="button" onClick={onRestart}>
        Boka en till tid
      </button>
    </section>
  );
}
