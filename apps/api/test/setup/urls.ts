/** Samma server och inloggning, annan databas. */
export function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

export function quoteIdent(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Refusing unexpected identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
