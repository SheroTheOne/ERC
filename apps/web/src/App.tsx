import { BookingFlow } from './features/booking/BookingFlow.tsx';
import { api } from './lib/api.ts';
import { useResource } from './lib/useResource.ts';

const loadBusiness = () => api.business();

export function App() {
  const business = useResource(loadBusiness, {});

  return (
    <>
      <header className="site-header">
        <h1>{business.status === 'ok' ? business.data.name : 'ERC'}</h1>
      </header>
      <main>
        {business.status === 'loading' && <p role="status">Laddar …</p>}
        {business.status === 'error' && (
          <p className="notice" role="alert">
            Bokningen är inte tillgänglig just nu. Försök igen om en stund.
          </p>
        )}
        {business.status === 'ok' && <BookingFlow business={business.data} />}
      </main>
    </>
  );
}
