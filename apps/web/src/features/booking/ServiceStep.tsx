import type { Service } from '@erc/contracts';
import { formatPrice } from '../../lib/time.ts';
import { StepHeading } from './StepHeading.tsx';

export function ServiceStep({
  services,
  onSelect,
}: {
  readonly services: readonly Service[];
  readonly onSelect: (service: Service) => void;
}) {
  return (
    <section aria-labelledby="step-title">
      <StepHeading>Välj tjänst</StepHeading>
      {services.length === 0 ? (
        <p>Det finns inga tjänster att boka just nu.</p>
      ) : (
        <ul className="card-list">
          {services.map((service) => (
            <li key={service.id}>
              <button
                type="button"
                className="card"
                onClick={() => {
                  onSelect(service);
                }}
              >
                <span className="card-main">
                  <span className="card-title">{service.name}</span>
                  {service.description !== null && (
                    <span className="card-description">{service.description}</span>
                  )}
                </span>
                <span className="card-meta">
                  <span>{service.durationMinutes} min</span>
                  <span>{formatPrice(service.priceOre)}</span>
                </span>
                <span aria-hidden="true" className="chevron">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
