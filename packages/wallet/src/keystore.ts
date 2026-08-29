/**
 * `@astroid/wallet` — encrypted local keystore provider for agent runtime security.
 *
 * Stores raw Stellar private keys safely on disk or in memory by encrypting them
 * with a user-supplied passphrase via AES-GCM. Key material is derived with
 * PBKDF2-SHA256 using a random salt and high iteration count. The resulting
 * `EncryptedPayload` is JSON-serialisable for easy local storage (e.g.
 * `localStorage`, file, or secure enclave) and can be decrypted only with the
 * original passphrase.
 *
 * ## Security constraints & recommendations
 *
 * - **Passphrase strength:** Use a high-entropy passphrase of at least 12
 *   characters (preferably 16+ or a diceware phrase). Passphrases shorter than
 *   8 characters are rejected. This module does not enforce complexity rules
 *   beyond length — callers should validate entropy upstream.
 * - **Key derivation:** PBKDF2 with SHA-256, 100 000 iterations, 16-byte random
 *   salt. Iterations are deliberately high to slow brute-force while remaining
 *   fast enough for interactive use. Increase `iterations` if your runtime can
 *   tolerate longer derivation.
 * - **Encryption:** AES-256-GCM with a fresh 12-byte random IV per encryption.
 *   The same secret encrypted twice yields different ciphertexts (IV + salt
 *   randomness). The 128-bit auth tag is included in the ciphertext and verified
 *   on decrypt — tampering or a wrong passphrase results in an explicit
 *   `decryption failed` error.
 * - **Memory hygiene:** Decrypted key values are returned as `string`s and are
 *   not retained by the keystore. Callers should zero or drop the plaintext
 *   immediately after use (e.g. after signing) and avoid logging it. JavaScript
 *   cannot guarantee secure memory wiping, so treat the decrypted value as
 *   short-lived.
 * - **No external dependencies:** Only the built-in Web Crypto API
 *   (`globalThis.crypto.subtle` / `node:crypto` `webcrypto`) is used, keeping
 *   the SDK footprint light and audit-friendly. No third-party crypto
 *   implementations are bundled.
 * - **Serialization:** `EncryptedPayload` is plain JSON (`{ version, ciphertext,
 *   iv, salt, iterations, algorithm, hash }`) with base64-encoded binary fields.
 *   Use {@link SecureKeystore.serialize} / {@link SecureKeystore.deserialize}
 *   for storage, or `JSON.stringify` directly — the shape is stable and versioned.
 *
 * @example
 * ```ts
 * import { SecureKeystore } from '@astroid/wallet';
 *
 * const ks = new SecureKeystore();
 * const payload = await ks.encryptKey(secretKey, passphrase);
 * const json = SecureKeystore.serialize(payload);
 * // store `json` …
 * const restored = SecureKeystore.deserialize(json);
 * const secret = await ks.decryptKey(restored, passphrase);
 * ```
 *
 * @module
 */

import { ValidationError } from '@astroid/errors';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

/** Serialisable encrypted payload produced by {@link SecureKeystore.encryptKey}. */
export interface EncryptedPayload {
  /** Payload version for forward-compatibility. */
  version: number;
  /** Base64-encoded ciphertext (includes GCM auth tag). */
  ciphertext: string;
  /** Base64-encoded 12-byte IV. */
  iv: string;
  /** Base64-encoded 16-byte PBKDF2 salt. */
  salt: string;
  /** PBKDF2 iteration count used for this payload. */
  iterations: number;
  /** Cipher algorithm (currently only `AES-GCM`). */
  algorithm: 'AES-GCM';
  /** PBKDF2 hash (currently only `SHA-256`). */
  hash: 'SHA-256';
}

const CURRENT_VERSION = 1;
const DEFAULT_ITERATIONS = 100_000;
const MIN_PASSPHRASE_LEN = 8;
const RECOMMENDED_MIN_LEN = 12;
const SALT_BYTES = 16;
const IV_BYTES = 12;

// ---------------------------------------------------------------------------
// Crypto helpers (WebCrypto with Node fallback)
// ---------------------------------------------------------------------------

function getCrypto(): Crypto {
  // Prefer globalThis.crypto (available in browsers and Node >=19 via webcrypto)
  const g = globalThis as unknown as { crypto?: Crypto };
  if (g.crypto?.subtle && typeof g.crypto.getRandomValues === 'function') return g.crypto;
  // Fallback to Node's webcrypto
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try {
    // Use dynamic require to avoid bundling node:crypto in browsers
    // @ts-ignore
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodeCrypto = require('node:crypto') as { webcrypto: Crypto };
    if (nodeCrypto.webcrypto?.subtle) return nodeCrypto.webcrypto as unknown as Crypto;
  } catch {
    // ignore
  }
  throw new ValidationError('Web Crypto API is not available in this environment.', {
    code: 'CRYPTO_UNAVAILABLE',
  });
}

function getSubtle(): SubtleCrypto {
  const c = getCrypto();
  if (!c.subtle) {
    throw new ValidationError('SubtleCrypto is not available.', { code: 'CRYPTO_UNAVAILABLE' });
  }
  return c.subtle;
}

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  getCrypto().getRandomValues(bytes);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  // Prefer Buffer when available (Node) for correctness with large arrays
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function decodeBase64(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function assertPassphrase(passphrase: string): void {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new ValidationError('A passphrase is required to encrypt or decrypt a secret key.', {
      code: 'MISSING_PASSPHRASE',
    });
  }
  if (passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new ValidationError(
      `Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters (recommended ${RECOMMENDED_MIN_LEN}+).`,
      { code: 'WEAK_PASSPHRASE' },
    );
  }
}

function assertSecretKey(secretKey: string): void {
  if (!secretKey || typeof secretKey !== 'string' || secretKey.trim().length === 0) {
    throw new ValidationError('A Stellar secret key is required.', { code: 'MISSING_SECRET_KEY' });
  }
}

async function deriveAesKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const subtle = getSubtle();
  const baseKey = await subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------------------
// SecureKeystore class
// ---------------------------------------------------------------------------

/**
 * Encrypts and decrypts Stellar secret keys with a passphrase using AES-GCM
 * and PBKDF2. Each encryption uses a fresh random salt and IV so the same
 * plaintext yields different ciphertexts.
 */
export class SecureKeystore {
  /** Default PBKDF2 iterations used when encrypting. */
  static readonly DEFAULT_ITERATIONS = DEFAULT_ITERATIONS;

  /**
   * Encrypt a Stellar secret key with a passphrase.
   *
   * @param secretKey   The raw Stellar secret key (e.g. `S...`).
   * @param passphrase  High-entropy passphrase (min 8 chars, 12+ recommended).
   * @returns A serialisable {@link EncryptedPayload} whose binary fields are base64-encoded.
   * @throws {ValidationError} When the secret or passphrase is missing/weak, or when crypto fails.
   */
  async encryptKey(secretKey: string, passphrase: string): Promise<EncryptedPayload> {
    assertSecretKey(secretKey);
    assertPassphrase(passphrase);

    const salt = getRandomBytes(SALT_BYTES);
    const iv = getRandomBytes(IV_BYTES);
    const iterations = DEFAULT_ITERATIONS;

    const key = await deriveAesKey(passphrase, salt, iterations);
    const subtle = getSubtle();

    let ciphertextBuf: ArrayBuffer;
    try {
      ciphertextBuf = await subtle.encrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        key,
        encoder.encode(secretKey),
      );
    } catch (cause) {
      throw new ValidationError('Failed to encrypt secret key.', {
        code: 'ENCRYPTION_FAILED',
        cause,
      });
    }

    return {
      version: CURRENT_VERSION,
      ciphertext: encodeBase64(new Uint8Array(ciphertextBuf)),
      iv: encodeBase64(iv),
      salt: encodeBase64(salt),
      iterations,
      algorithm: 'AES-GCM',
      hash: 'SHA-256',
    };
  }

  /**
   * Decrypt an {@link EncryptedPayload} with the original passphrase.
   *
   * The GCM auth tag is verified; a wrong passphrase, corrupted payload, or
   * tampered ciphertext results in a `ValidationError`.
   *
   * @param payload     The payload returned by {@link SecureKeystore.encryptKey}, or a JSON string produced by {@link SecureKeystore.serialize}.
   * @param passphrase  The passphrase used during encryption.
   * @returns The original secret key plaintext string.
   * @throws {ValidationError} When decryption fails (wrong passphrase, bad payload, or auth tag mismatch).
   */
  async decryptKey(
    payload: EncryptedPayload | string,
    passphrase: string,
  ): Promise<string> {
    assertPassphrase(passphrase);

    const resolved: EncryptedPayload =
      typeof payload === 'string' ? SecureKeystore.deserialize(payload) : payload;

    if (
      !resolved ||
      typeof resolved.ciphertext !== 'string' ||
      typeof resolved.iv !== 'string' ||
      typeof resolved.salt !== 'string'
    ) {
      throw new ValidationError('Invalid encrypted payload: missing ciphertext/iv/salt.', {
        code: 'INVALID_PAYLOAD',
      });
    }

    const iterations = resolved.iterations ?? DEFAULT_ITERATIONS;
    const salt = decodeBase64(resolved.salt);
    const iv = decodeBase64(resolved.iv);
    const ciphertext = decodeBase64(resolved.ciphertext);

    const key = await deriveAesKey(passphrase, salt, iterations);
    const subtle = getSubtle();

    try {
      const plainBuf = await subtle.decrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        key,
        ciphertext as unknown as BufferSource,
      );
      return decoder.decode(plainBuf);
    } catch (cause) {
      // WebCrypto throws OperationError / DOMException on wrong passphrase or tamper
      throw new ValidationError(
        'Failed to decrypt secret key: wrong passphrase or corrupted payload.',
        {
          code: 'DECRYPTION_FAILED',
          cause,
        },
      );
    }
  }

  /**
   * Serialize a payload to a JSON string for local storage.
   *
   * @param payload The encrypted payload.
   * @returns JSON string.
   */
  static serialize(payload: EncryptedPayload): string {
    return JSON.stringify(payload);
  }

  /**
   * Deserialize a JSON string (or plain object) back to an {@link EncryptedPayload}.
   *
   * Performs basic structural validation before returning.
   *
   * @param serialized JSON string produced by {@link SecureKeystore.serialize} or a plain payload object.
   * @throws {ValidationError} When the input is not valid JSON or lacks required fields.
   */
  static deserialize(serialized: string | EncryptedPayload): EncryptedPayload {
    let obj: unknown;
    if (typeof serialized === 'string') {
      try {
        obj = JSON.parse(serialized);
      } catch (cause) {
        throw new ValidationError('Invalid serialized payload: not valid JSON.', {
          code: 'INVALID_PAYLOAD_JSON',
          cause,
        });
      }
    } else {
      obj = serialized;
    }

    if (typeof obj !== 'object' || obj === null) {
      throw new ValidationError('Invalid payload: expected an object.', { code: 'INVALID_PAYLOAD' });
    }
    const p = obj as Record<string, unknown>;
    if (
      typeof p.ciphertext !== 'string' ||
      typeof p.iv !== 'string' ||
      typeof p.salt !== 'string'
    ) {
      throw new ValidationError(
        'Invalid payload: missing required fields (ciphertext, iv, salt).',
        { code: 'INVALID_PAYLOAD' },
      );
    }
    return {
      version: typeof p.version === 'number' ? p.version : CURRENT_VERSION,
      ciphertext: p.ciphertext,
      iv: p.iv,
      salt: p.salt,
      iterations:
        typeof p.iterations === 'number' && Number.isFinite(p.iterations)
          ? p.iterations
          : DEFAULT_ITERATIONS,
      algorithm: 'AES-GCM',
      hash: 'SHA-256',
    };
  }
}

export default SecureKeystore;
