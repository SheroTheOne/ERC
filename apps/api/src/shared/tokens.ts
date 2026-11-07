import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 256 slumpade bitar som base64url. Bara hashen lagras i databasen (ADR-0008). */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function isWellFormedToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}
