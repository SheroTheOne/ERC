import { argon2, randomBytes, timingSafeEqual, type Argon2Parameters } from 'node:crypto';

/**
 * argon2id via Node:s inbyggda crypto.argon2 med OWASP:s rekommenderade
 * parametrar (m = 19 MiB, t = 2, p = 1), lagrat i PHC-format (ADR-0008):
 * $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
 */
const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;
const SALT_BYTES = 16;
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function derive(
  password: string,
  salt: Buffer,
  params: Omit<Argon2Parameters, 'message' | 'nonce'>,
) {
  return new Promise<Buffer>((resolve, reject) => {
    argon2('argon2id', { ...params, message: password, nonce: salt }, (error, key) => {
      if (error === null) resolve(key);
      else reject(error);
    });
  });
}

const b64 = (buffer: Buffer) => buffer.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, PARAMS);
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(key)}`;
}

/** Jämför i konstant tid. En trasig hash ger false, aldrig ett undantag. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = PHC.exec(stored);
  if (match === null) return false;
  const [, memory, passes, parallelism, salt, hash] = match;
  if (salt === undefined || hash === undefined) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), {
    memory: Number(memory),
    passes: Number(passes),
    parallelism: Number(parallelism),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Används när kontot inte finns eller saknar lösenord, så att inloggningen tar
 * lika lång tid oavsett och inte avslöjar vilka e-postadresser som finns.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
