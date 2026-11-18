import { useEffect, useState } from 'react';

export type Resource<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ok'; readonly data: T }
  | { readonly status: 'error'; readonly error: unknown };

/**
 * Hämtar data när argumenten ändras. Resultatet sparas tillsammans med sin nyckel, så att
 * ett gammalt svar aldrig visas för nya argument och inget state behöver nollställas i effekten.
 * `load` ska vara stabil (en funktion på modulnivå), och `args` ska gå att serialisera som JSON.
 */
export function useResource<A, T>(
  load: (args: A) => Promise<T>,
  args: A | null,
  reloadToken = 0,
): Resource<T> {
  const key = args === null ? null : JSON.stringify([args, reloadToken]);
  const [result, setResult] = useState<{ readonly key: string; readonly value: Resource<T> }>();

  useEffect(() => {
    if (key === null) return;
    let active = true;
    const [parsed] = JSON.parse(key) as [A, number];
    load(parsed).then(
      (data) => {
        if (active) setResult({ key, value: { status: 'ok', data } });
      },
      (error: unknown) => {
        if (active) setResult({ key, value: { status: 'error', error } });
      },
    );
    return () => {
      active = false;
    };
  }, [key, load]);

  return result?.key === key ? result.value : { status: 'loading' };
}
