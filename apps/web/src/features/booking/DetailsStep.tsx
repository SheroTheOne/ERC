import type { Business, Service, Slot } from '@erc/contracts';
import { type SyntheticEvent, useState } from 'react';
import { formatPrice, formatSlotRange } from '../../lib/time.ts';
import type { ContactField, ContactInput } from './errors.ts';
import { StepHeading } from './StepHeading.tsx';

const FIELD_ORDER: readonly ContactField[] = ['name', 'email', 'phone', 'note'];

export function DetailsStep({
  business,
  service,
  slot,
  staffName,
  contact,
  onContactChange,
  fieldErrors,
  error,
  submitting,
  onSubmit,
  onBack,
}: {
  readonly business: Business;
  readonly service: Service;
  readonly slot: Slot;
  readonly staffName: string | undefined;
  readonly contact: ContactInput;
  readonly onContactChange: (contact: ContactInput) => void;
  readonly fieldErrors: Partial<Record<ContactField, string>>;
  readonly error: string | null;
  readonly submitting: boolean;
  readonly onSubmit: () => void;
  readonly onBack: () => void;
}) {
  // Felen visas först när kunden har försökt skicka, inte medan hen skriver.
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? fieldErrors : {};

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);
    const firstInvalid = FIELD_ORDER.find((name) => fieldErrors[name] !== undefined);
    if (firstInvalid !== undefined) {
      document.getElementById(`contact-${firstInvalid}`)?.focus();
      return;
    }
    onSubmit();
  }

  function field(
    name: ContactField,
    label: string,
    input: { type?: string; autoComplete?: string; required?: boolean; multiline?: boolean },
  ) {
    const id = `contact-${name}`;
    const errorId = `${id}-error`;
    const message = errors[name];
    const common = {
      id,
      name,
      value: contact[name],
      'aria-invalid': message !== undefined,
      'aria-describedby': message === undefined ? undefined : errorId,
      onChange: (event: { target: { value: string } }) => {
        onContactChange({ ...contact, [name]: event.target.value });
      },
    };
    return (
      <div className="field">
        <label htmlFor={id}>
          {label}
          {input.required !== true && <span className="optional"> (valfritt)</span>}
        </label>
        {input.multiline === true ? (
          <textarea {...common} rows={3} maxLength={500} />
        ) : (
          <input
            {...common}
            type={input.type ?? 'text'}
            autoComplete={input.autoComplete}
            required={input.required}
          />
        )}
        {message !== undefined && (
          <span id={errorId} className="field-error">
            {message}
          </span>
        )}
      </div>
    );
  }

  return (
    <section aria-labelledby="step-title">
      <StepHeading onBack={onBack}>Bekräfta</StepHeading>

      <dl className="summary">
        <dt>Tid</dt>
        <dd>{formatSlotRange(slot.startsAt, slot.endsAt, business.timezone)}</dd>
        <dt>Tjänst</dt>
        <dd>
          {service.name}
          {staffName !== undefined && ` hos ${staffName}`}
        </dd>
        <dt>Pris</dt>
        <dd>{formatPrice(service.priceOre)}</dd>
      </dl>

      <form onSubmit={handleSubmit} noValidate>
        {field('name', 'Namn', { autoComplete: 'name', required: true })}
        {field('email', 'E-post', { type: 'email', autoComplete: 'email', required: true })}
        {field('phone', 'Telefon', { type: 'tel', autoComplete: 'tel' })}
        {field('note', 'Meddelande', { multiline: true })}

        {error !== null && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? 'Bokar …' : 'Boka tiden'}
        </button>
      </form>
    </section>
  );
}
