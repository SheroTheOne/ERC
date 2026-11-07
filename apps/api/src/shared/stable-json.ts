import { createHash } from 'node:crypto';

/**
 * JSON med sorterade nycklar, så att två förfrågningar med samma innehåll men
 * olika fältordning ger samma hash (används för idempotensnycklar, ADR-0003).
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashJson(value: unknown): Buffer {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest();
}
