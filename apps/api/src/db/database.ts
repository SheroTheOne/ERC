import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { toIso } from '../shared/time.ts';
import type { DB } from './types.ts';

export type Database = Kysely<DB>;

/**
 * Typparsers per pool i stället för globalt via pg.types, så att tester och
 * verktyg inte påverkar varandra (ADR-0006).
 *
 * - timestamptz blir en ISO 8601-sträng i UTC med sekundprecision, samma format
 *   som API:t använder överallt: 2026-03-30T07:00:00Z.
 * - date förblir 'YYYY-MM-DD'. pg:s standard gör om det till Date vid lokal
 *   midnatt, vilket flyttar datumet i alla tidszoner väster om UTC.
 * - timestamp utan tidszon används inte i schemat och ska aldrig dyka upp.
 */
function createTypeParsers(): pg.TypeOverrides {
  const { builtins } = pg.types;
  const overrides = new pg.TypeOverrides();
  overrides.setTypeParser(builtins.TIMESTAMPTZ, (value) =>
    toIso(Temporal.Instant.fromEpochMilliseconds(Date.parse(value))),
  );
  overrides.setTypeParser(builtins.DATE, (value) => value);
  overrides.setTypeParser(builtins.TIMESTAMP, () => {
    throw new Error('timestamp without time zone is not allowed, use timestamptz');
  });
  return overrides;
}

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly applicationName?: string;
  /**
   * Fel från vilande anslutningar, till exempel när databasen startas om eller
   * en anslutning avslutas av servern. Utan lyssnare kraschar Node processen,
   * så varje anropare måste ta ställning till hur felet ska hanteras.
   */
  readonly onIdleError: (error: Error) => void;
}

export function createPool(options: DatabaseOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'erc-api',
    // Sätts per anslutning så att SQL-funktioner och tidsstämplar beter sig
    // likadant oavsett serverns standardinställningar.
    options: '-c search_path=erc,public -c TimeZone=UTC',
    types: createTypeParsers(),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', options.onIdleError);
  return pool;
}

export function createDatabase(pool: pg.Pool): Database {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}
