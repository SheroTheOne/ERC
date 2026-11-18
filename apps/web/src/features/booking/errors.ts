import { ApiError } from '../../lib/api.ts';

export type ContactField = 'name' | 'email' | 'phone' | 'note';

/** Vad bokningsflödet ska göra när ett försök att boka misslyckas. */
export type BookingFailure =
  /** Tiden går inte längre att boka. Tillbaka till tiderna, som laddas om. */
  | { readonly kind: 'slot-gone'; readonly message: string }
  /** Fel i formuläret. Kunden står kvar och ser felen vid fälten. */
  | {
      readonly kind: 'invalid';
      readonly fields: Partial<Record<ContactField, string>>;
      readonly message: string;
    }
  /** Något annat. Formuläret behålls och kunden kan försöka igen. */
  | { readonly kind: 'retry'; readonly message: string };

const SLOT_GONE = 'Tiden hann bokas av någon annan. Välj en ny tid.';

const FIELD_BY_PATH: Readonly<Record<string, ContactField>> = {
  'body/contact/name': 'name',
  'body/contact/email': 'email',
  'body/contact/phone': 'phone',
  'body/note': 'note',
};

const FIELD_MESSAGES: Readonly<Record<ContactField, string>> = {
  name: 'Skriv ditt namn.',
  email: 'Skriv en giltig e-postadress.',
  phone: 'Skriv ett giltigt telefonnummer, t.ex. 070-123 45 67.',
  note: 'Meddelandet får vara högst 500 tecken.',
};

export function describeBookingFailure(error: unknown): BookingFailure {
  if (!(error instanceof ApiError)) {
    return {
      kind: 'retry',
      message: 'Vi kunde inte nå bokningen. Kontrollera anslutningen och försök igen.',
    };
  }
  if (error.is('slot-unavailable')) return { kind: 'slot-gone', message: SLOT_GONE };
  if (
    error.is('outside-open-hours') ||
    error.is('staff-inactive') ||
    error.is('staff-does-not-perform-service')
  ) {
    return { kind: 'slot-gone', message: 'Tiden går inte längre att boka. Välj en ny tid.' };
  }
  if (error.is('validation-failed')) {
    const fields: Partial<Record<ContactField, string>> = {};
    for (const issue of error.problem.errors ?? []) {
      const field = FIELD_BY_PATH[issue.path];
      if (field !== undefined) fields[field] = FIELD_MESSAGES[field];
    }
    if (Object.keys(fields).length > 0) {
      return { kind: 'invalid', fields, message: 'Kontrollera de markerade fälten.' };
    }
  }
  if (error.is('rate-limited')) {
    return { kind: 'retry', message: 'För många försök. Vänta en stund och försök igen.' };
  }
  const reference = error.problem.requestId === '' ? '' : ` (referens ${error.problem.requestId})`;
  return { kind: 'retry', message: `Bokningen gick inte igenom. Försök igen${reference}.` };
}

export interface ContactInput {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly note: string;
}

/** Samma regler som kontraktet, så att de flesta fel syns innan något skickas. */
export function validateContact(
  input: ContactInput,
  normalizedPhone: string | undefined,
): Partial<Record<ContactField, string>> {
  const errors: Partial<Record<ContactField, string>> = {};
  const name = input.name.trim();
  if (name === '' || name.length > 200) errors.name = FIELD_MESSAGES.name;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()) || input.email.length > 254) {
    errors.email = FIELD_MESSAGES.email;
  }
  if (input.phone.trim() !== '' && normalizedPhone === undefined) {
    errors.phone = FIELD_MESSAGES.phone;
  }
  if (input.note.length > 500) errors.note = FIELD_MESSAGES.note;
  return errors;
}
