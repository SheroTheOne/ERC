import { describe, expect, it } from 'vitest';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../../src/auth/password.ts';

describe('password hashing', () => {
  it('stores argon2id in PHC format with OWASP parameters and a random salt', async () => {
    const first = await hashPassword('rätt häst batteri häftklammer');
    const second = await hashPassword('rätt häst batteri häftklammer');

    expect(first).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(first).not.toBe(second);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('rätt häst batteri häftklammer');
    expect(await verifyPassword('rätt häst batteri häftklammer', hash)).toBe(true);
    expect(await verifyPassword('Rätt häst batteri häftklammer', hash)).toBe(false);
  });

  it('returns false for malformed hashes instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', '$2b$10$bcrypt.hash.is.not.supported')).toBe(false);
  });

  it('has a dummy hash that never matches, used to equalise login timing', async () => {
    expect(await verifyPassword('', DUMMY_PASSWORD_HASH)).toBe(false);
    expect(await verifyPassword('erc-demo-2026', DUMMY_PASSWORD_HASH)).toBe(false);
  });
});
