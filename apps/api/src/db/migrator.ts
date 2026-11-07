import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, type Kysely } from 'kysely';
import {
  Migrator,
  type Migration,
  type MigrationProvider,
  type MigrationResultSet,
} from 'kysely/migration';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Läser migreringar som rena SQL-filer (ADR-0006). Varje fil körs som en enda
 * fråga utan parametrar, så att den kan innehålla flera satser och
 * funktionskroppar med $$. Kyselys Migrator kör varje migrering i en
 * transaktion och tar ett lås mot samtidiga körningar.
 */
export class SqlFileMigrationProvider implements MigrationProvider {
  readonly #directory: string;

  constructor(directory: string = MIGRATIONS_DIR) {
    this.#directory = directory;
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.#directory)).filter((file) => file.endsWith('.sql')).sort();

    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      if (!MIGRATION_FILE.test(file)) {
        throw new Error(`Invalid migration file name: ${file} (expected NNNN_name.sql)`);
      }
      const source = await readFile(path.join(this.#directory, file), 'utf8');
      migrations[file.slice(0, -'.sql'.length)] = {
        up: async (db: Kysely<unknown>) => {
          await sql.raw(source).execute(db);
        },
      };
    }
    return migrations;
  }
}

export function createMigrator<T>(db: Kysely<T>, directory?: string): Migrator {
  return new Migrator({
    // Migreringstabellerna ska inte gå genom CamelCasePlugin eller andra plugins.
    db: db.withoutPlugins(),
    provider: new SqlFileMigrationProvider(directory),
    // Migreringar går bara framåt. En fil som redan har körts får inte ändras eller tas bort.
    allowUnorderedMigrations: false,
  });
}

export class MigrationFailedError extends Error {
  override readonly name = 'MigrationFailedError';
}

export async function migrateToLatest<T>(
  db: Kysely<T>,
  directory?: string,
): Promise<MigrationResultSet> {
  const result = await createMigrator(db, directory).migrateToLatest();
  if (result.error !== undefined) {
    const failed = result.results?.find((r) => r.status === 'Error')?.migrationName;
    const message =
      failed === undefined ? 'Migrations could not run' : `Migration ${failed} failed`;
    throw new MigrationFailedError(message, { cause: result.error });
  }
  return result;
}
