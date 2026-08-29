import { describe, it, expect } from 'vitest';
import { SecureKeystore } from '../src/keystore.js';

/**
 * Use a deterministic-looking but real Stellar secret for tests.
 * Any base32-looking string works; the keystore treats it as opaque UTF-8.
 */
const SECRET = 'SC4C2Q2C2EXAMPLESECRETKEYMUSTBE56CHARSLONGFORSTELLAR1234567';
const PASSPHRASE = 'correct-horse-battery-staple-123';
const WRONG_PASSPHRASE = 'wrong-passphrase-!@#456';

describe('SecureKeystore', () => {
  it('encrypts and decrypts a secret key with the correct passphrase', async () => {
    const ks = new SecureKeystore();
    const payload = await ks.encryptKey(SECRET, PASSPHRASE);
    expect(payload.ciphertext).toBeTruthy();
    expect(payload.iv).toBeTruthy();
    expect(payload.salt).toBeTruthy();
    expect(payload.iterations).toBeGreaterThanOrEqual(10_000);
    expect(payload.algorithm).toBe('AES-GCM');

    const decrypted = await ks.decryptKey(payload, PASSPHRASE);
    expect(decrypted).toBe(SECRET);
  });

  it('encrypting the same secret multiple times yields randomized ciphertexts (IV/salt randomness)', async () => {
    const ks = new SecureKeystore();
    const a = await ks.encryptKey(SECRET, PASSPHRASE);
    const b = await ks.encryptKey(SECRET, PASSPHRASE);
    // Ciphertexts must differ because IV and salt are random per call
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
    // Salts should also differ with overwhelming probability
    expect(a.salt).not.toBe(b.salt);
    // Both still decrypt correctly
    expect(await ks.decryptKey(a, PASSPHRASE)).toBe(SECRET);
    expect(await ks.decryptKey(b, PASSPHRASE)).toBe(SECRET);
  });

  it('supplying the wrong passphrase fails to decrypt with an explicit validation error', async () => {
    const ks = new SecureKeystore();
    const payload = await ks.encryptKey(SECRET, PASSPHRASE);
    await expect(ks.decryptKey(payload, WRONG_PASSPHRASE)).rejects.toThrowError();
    try {
      await ks.decryptKey(payload, WRONG_PASSPHRASE);
      expect.unreachable('expected decryption to fail with wrong passphrase');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      // Ensure it carries a validation code like DECRYPTION_FAILED
      expect((err as Error).message).toMatch(/decrypt/i);
    }
  });

  it('supports string serialization/deserialization for local storage', async () => {
    const ks = new SecureKeystore();
    const payload = await ks.encryptKey(SECRET, PASSPHRASE);
    const serialized = SecureKeystore.serialize(payload);
    expect(typeof serialized).toBe('string');
    // Must be valid JSON
    expect(() => JSON.parse(serialized)).not.toThrow();

    const deserialized = SecureKeystore.deserialize(serialized);
    expect(deserialized.ciphertext).toBe(payload.ciphertext);
    expect(deserialized.iv).toBe(payload.iv);
    expect(deserialized.salt).toBe(payload.salt);

    const decrypted = await ks.decryptKey(deserialized, PASSPHRASE);
    expect(decrypted).toBe(SECRET);

    // Also accept serialized string directly in decryptKey
    const decryptedFromString = await ks.decryptKey(serialized, PASSPHRASE);
    expect(decryptedFromString).toBe(SECRET);
  });

  it('serialize/deserialize via JSON.stringify round-trip', async () => {
    const ks = new SecureKeystore();
    const payload = await ks.encryptKey(SECRET, PASSPHRASE);
    const json = JSON.stringify(payload);
    const viaJson = JSON.parse(json);
    const decrypted = await ks.decryptKey(viaJson, PASSPHRASE);
    expect(decrypted).toBe(SECRET);
  });

  it('throws when passphrase is too short or missing', async () => {
    const ks = new SecureKeystore();
    await expect(ks.encryptKey(SECRET, '')).rejects.toThrow();
    await expect(ks.encryptKey(SECRET, 'short')).rejects.toThrow();
    const payload = await ks.encryptKey(SECRET, PASSPHRASE);
    await expect(ks.decryptKey(payload, '')).rejects.toThrow();
  });

  it('throws when secret key is missing', async () => {
    const ks = new SecureKeystore();
    await expect(ks.encryptKey('', PASSPHRASE)).rejects.toThrow();
  });

  it('decrypt fails on tampered ciphertext', async () => {
    const ks = new SecureKeystore();
    const payload = await ks.encryptKey(SECRET, PASSPHRASE);
    const tampered = {
      ...payload,
      ciphertext: payload.ciphertext.slice(0, -4) + 'AAAA',
    };
    await expect(ks.decryptKey(tampered, PASSPHRASE)).rejects.toThrow();
  });
});
