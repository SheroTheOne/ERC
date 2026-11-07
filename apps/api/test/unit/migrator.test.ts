import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, SqlFileMigrationProvider } from '../../src/db/migrator.ts';

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('SqlFileMigrationProvider', () => {
  it('finds the repository migrations in order', async () => {
    const names = Object.keys(await new SqlFileMigrationProvider(MIGRATIONS_DIR).getMigrations());
    expect(names[0]).toBe('0001_initial');
    expect(names).toEqual([...names].sort());
  });

  it('rejects files that do not follow NNNN_name.sql', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'erc-migrations-'));
    await writeFile(path.join(directory, '0001_ok.sql'), 'SELECT 1;');
    await writeFile(path.join(directory, '2-Bad Name.sql'), 'SELECT 1;');

    await expect(new SqlFileMigrationProvider(directory).getMigrations()).rejects.toThrow(
      /Invalid migration file name/,
    );
  });
});
