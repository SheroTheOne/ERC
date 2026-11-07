import process from 'node:process';
import { loadConfig } from '../config.ts';
import { createDatabase, createPool } from './database.ts';
import { migrateToLatest } from './migrator.ts';

const config = loadConfig(process.env);
const pool = createPool({
  connectionString: config.databaseUrl,
  max: 1,
  applicationName: 'erc-migrate',
});
const db = createDatabase(pool);

try {
  const { results = [] } = await migrateToLatest(db);
  if (results.length === 0) {
    console.log('Database is up to date.');
  }
  for (const result of results) {
    console.log(
      `${result.status === 'Success' ? 'applied' : result.status}: ${result.migrationName}`,
    );
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
