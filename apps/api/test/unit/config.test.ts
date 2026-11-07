import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.ts';

const REQUIRED = {
  DATABASE_URL: 'postgres://erc:secret@localhost:5432/erc',
  PUBLIC_ORIGIN: 'https://erc.example',
};

describe('loadConfig', () => {
  it('applies defaults and converts numbers', () => {
    const config = loadConfig({ ...REQUIRED, PORT: '8080' });
    expect(config).toMatchObject({
      env: 'development',
      port: 8080,
      host: '0.0.0.0',
      logLevel: 'info',
      databasePoolMax: 10,
      webDistDir: undefined,
    });
  });

  it('treats empty strings as missing', () => {
    expect(loadConfig({ ...REQUIRED, PORT: '' }).port).toBe(3000);
  });

  it('reports every invalid variable without echoing values', () => {
    let error: unknown;
    try {
      loadConfig({
        DATABASE_URL: 'mysql://user:secret@db/erc',
        PUBLIC_ORIGIN: 'https://erc.example/',
        PORT: '70000',
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain('/DATABASE_URL');
    expect(message).toContain('/PUBLIC_ORIGIN');
    expect(message).toContain('/PORT');
    expect(message).not.toContain('secret');
  });

  it('ignores unrelated environment variables', () => {
    expect(() => loadConfig({ ...REQUIRED, PATH: '/usr/bin', HOME: '/root' })).not.toThrow();
  });
});
