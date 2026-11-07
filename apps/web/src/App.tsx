import { useEffect, useState } from 'react';
import { ApiError, api } from './lib/api.ts';

type Status =
  | { readonly state: 'loading' }
  | { readonly state: 'ok'; readonly time: string }
  | { readonly state: 'error'; readonly message: string };

export function App() {
  const [status, setStatus] = useState<Status>({ state: 'loading' });

  useEffect(() => {
    let active = true;
    api
      .health()
      .then((health) => {
        if (active) setStatus({ state: 'ok', time: health.time });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof ApiError ? error.problem.title : 'API:t svarar inte';
        setStatus({ state: 'error', message });
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main>
      <h1>ERC</h1>
      <p>Bokningssystem för tjänsteföretag. Bokningsflödet byggs i Fas 4.</p>
      <p role="status" aria-live="polite">
        {status.state === 'loading' && 'Kontrollerar API:t …'}
        {status.state === 'ok' && `API och databas svarar (${status.time}).`}
        {status.state === 'error' && `Fel: ${status.message}`}
      </p>
    </main>
  );
}
