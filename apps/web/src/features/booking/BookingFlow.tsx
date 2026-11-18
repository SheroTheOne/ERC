import type { Booking, Business, Service, Slot } from '@erc/contracts';
import { useState } from 'react';
import { api } from '../../lib/api.ts';
import { normalizePhone, startOfWeek, todayInZone } from '../../lib/time.ts';
import { useResource } from '../../lib/useResource.ts';
import { Confirmation } from './Confirmation.tsx';
import { DetailsStep } from './DetailsStep.tsx';
import {
  type ContactField,
  type ContactInput,
  describeBookingFailure,
  validateContact,
} from './errors.ts';
import { ServiceStep } from './ServiceStep.tsx';
import { SlotStep } from './SlotStep.tsx';

type Step =
  | { readonly name: 'service' }
  | { readonly name: 'slot'; readonly service: Service }
  | { readonly name: 'details'; readonly service: Service; readonly slot: Slot }
  | { readonly name: 'done'; readonly booking: Booking };

const EMPTY_CONTACT: ContactInput = { name: '', email: '', phone: '', note: '' };
const loadServices = () => api.services();

export function BookingFlow({ business }: { readonly business: Business }) {
  const services = useResource(loadServices, {});
  const [step, setStep] = useState<Step>({ name: 'service' });

  // Valen ligger här och inte i stegen, så att de finns kvar när kunden går fram och tillbaka.
  const [staffId, setStaffId] = useState<string>();
  const [weekStart, setWeekStart] = useState<string>();
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const [contact, setContact] = useState<ContactInput>(EMPTY_CONTACT);
  const [serverFieldErrors, setServerFieldErrors] = useState<Partial<Record<ContactField, string>>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const service = step.name === 'slot' || step.name === 'details' ? step.service : undefined;
  const staff = useResource(api.serviceStaff, service?.id ?? null);
  const staffName =
    staff.status === 'ok' && staffId !== undefined
      ? staff.data.items.find((member) => member.id === staffId)?.displayName
      : undefined;

  const today = todayInZone(business.timezone);
  const phone = normalizePhone(contact.phone);
  const clientFieldErrors = validateContact(contact, phone);

  function chooseService(chosen: Service) {
    setStaffId(undefined);
    setWeekStart(undefined);
    setSelectedDate(null);
    setNotice(null);
    setStep({ name: 'slot', service: chosen });
  }

  function chooseSlot(chosenService: Service, slot: Slot) {
    setNotice(null);
    setError(null);
    setStep({ name: 'details', service: chosenService, slot });
  }

  async function submit(chosenService: Service, slot: Slot) {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const note = contact.note.trim();
      const booking = await api.createBooking({
        serviceId: chosenService.id,
        ...(staffId === undefined ? {} : { staffId }),
        startsAt: slot.startsAt,
        contact: {
          name: contact.name.trim(),
          email: contact.email.trim(),
          ...(phone === undefined ? {} : { phone }),
        },
        ...(note === '' ? {} : { note }),
      });
      setStep({ name: 'done', booking });
    } catch (caught) {
      const failure = describeBookingFailure(caught);
      switch (failure.kind) {
        case 'slot-gone':
          // Kunden står kvar på samma dag och formuläret behålls (docs/ux/views.md).
          setNotice(failure.message);
          setSelectedDate(todayInZone(business.timezone, new Date(slot.startsAt)));
          setReloadToken((token) => token + 1);
          setStep({ name: 'slot', service: chosenService });
          break;
        case 'invalid':
          setServerFieldErrors(failure.fields);
          setError(failure.message);
          break;
        case 'retry':
          setError(failure.message);
          break;
      }
    } finally {
      setSubmitting(false);
    }
  }

  function restart() {
    setContact(EMPTY_CONTACT);
    setServerFieldErrors({});
    setError(null);
    setStep({ name: 'service' });
  }

  switch (step.name) {
    case 'service':
      if (services.status === 'loading') return <p role="status">Hämtar tjänster …</p>;
      if (services.status === 'error') {
        return (
          <p className="notice" role="alert">
            Det gick inte att hämta tjänsterna. Försök igen om en stund.
          </p>
        );
      }
      return <ServiceStep services={services.data.items} onSelect={chooseService} />;

    case 'slot':
      return (
        <SlotStep
          business={business}
          service={step.service}
          staff={staff}
          staffId={staffId}
          onStaffChange={(id) => {
            setStaffId(id);
            setSelectedDate(null);
          }}
          today={today}
          weekStart={weekStart ?? startOfWeek(today)}
          onWeekChange={(start) => {
            setWeekStart(start);
            setSelectedDate(null);
            setNotice(null);
          }}
          selectedDate={selectedDate}
          onDateChange={setSelectedDate}
          reloadToken={reloadToken}
          notice={notice}
          onSelect={(slot) => {
            chooseSlot(step.service, slot);
          }}
          onBack={() => {
            setStep({ name: 'service' });
          }}
        />
      );

    case 'details':
      return (
        <DetailsStep
          business={business}
          service={step.service}
          slot={step.slot}
          staffName={staffName}
          contact={contact}
          onContactChange={(next) => {
            setContact(next);
            setServerFieldErrors({});
          }}
          fieldErrors={{ ...serverFieldErrors, ...clientFieldErrors }}
          error={error}
          submitting={submitting}
          onSubmit={() => void submit(step.service, step.slot)}
          onBack={() => {
            setSelectedDate(todayInZone(business.timezone, new Date(step.slot.startsAt)));
            setStep({ name: 'slot', service: step.service });
          }}
        />
      );

    case 'done':
      return (
        <Confirmation
          business={business}
          booking={step.booking}
          email={contact.email.trim()}
          onRestart={restart}
        />
      );
  }
}
