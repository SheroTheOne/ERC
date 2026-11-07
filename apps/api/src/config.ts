import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

const Env = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
    { default: 'development' },
  ),
  DATABASE_URL: Type.String({ pattern: '^postgres(ql)?://' }),
  PUBLIC_ORIGIN: Type.String({ pattern: '^https?://[^/]+$' }),
  HOST: Type.String({ default: '0.0.0.0' }),
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 3000 }),
  LOG_LEVEL: Type.Union(
    [
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
      Type.Literal('debug'),
      Type.Literal('trace'),
      Type.Literal('silent'),
    ],
    { default: 'info' },
  ),
  DATABASE_POOL_MAX: Type.Integer({ minimum: 1, maximum: 100, default: 10 }),
  // Katalog med byggd webb (apps/web/dist). Serveras av API:t i produktion, så att
  // webb och API delar origin (ADR-0008).
  WEB_DIST_DIR: Type.Optional(Type.String({ minLength: 1 })),
});

export interface Config {
  readonly env: Static<typeof Env>['NODE_ENV'];
  readonly databaseUrl: string;
  readonly publicOrigin: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: Static<typeof Env>['LOG_LEVEL'];
  readonly databasePoolMax: number;
  readonly webDistDir: string | undefined;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Validerar miljövariabler. Kastar ConfigError med alla fel på en gång, utan värden (de kan vara hemliga). */
export function loadConfig(source: Readonly<Record<string, string | undefined>>): Config {
  const known = Object.fromEntries(
    Object.keys(Env.properties).flatMap((key) => {
      const value = source[key];
      return value === undefined || value === '' ? [] : [[key, value]];
    }),
  );

  const converted = Value.Convert(Env, Value.Default(Env, known));
  if (!Value.Check(Env, converted)) {
    const problems = Value.Errors(Env, converted).map(
      (error) => `${error.instancePath || '/'}: ${error.message}`,
    );
    throw new ConfigError(`Invalid environment:\n  ${problems.join('\n  ')}`);
  }

  return {
    env: converted.NODE_ENV,
    databaseUrl: converted.DATABASE_URL,
    publicOrigin: converted.PUBLIC_ORIGIN,
    host: converted.HOST,
    port: converted.PORT,
    logLevel: converted.LOG_LEVEL,
    databasePoolMax: converted.DATABASE_POOL_MAX,
    webDistDir: converted.WEB_DIST_DIR,
  };
}
