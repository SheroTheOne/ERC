import process from 'node:process';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDatabase, createPool } from './db/database.ts';
import { systemClock } from './shared/clock.ts';

const config = loadConfig(process.env);
// Loggern skapas av Fastify i buildApp. Fel som uppstår innan dess skrivs till stderr.
let logIdleError = (error: Error): void => {
  console.error('idle database client error', error);
};
const pool = createPool({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
  onIdleError: (error) => {
    logIdleError(error);
  },
});
const db = createDatabase(pool);

const app = await buildApp(
  { config, db, clock: systemClock },
  {
    logger: {
      level: config.logLevel,
      // Loggar innehåller id:n, aldrig cookies, tokens eller kontaktuppgifter (ADR-0010).
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
      ...(config.env === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } }
        : {}),
    },
  },
);

logIdleError = (error) => {
  app.log.error({ err: error }, 'idle database client error');
};

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await db.destroy();
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
    process.exitCode = 1;
  }
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  await db.destroy();
  process.exit(1);
}
