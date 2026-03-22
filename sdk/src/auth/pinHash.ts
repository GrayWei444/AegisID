/**
 * PIN Hash — Argon2id key derivation and secure comparison
 *
 * Memory-hard hashing resistant to GPU/ASIC brute-force attacks.
 * Used for PIN verification, backup recovery, and identity anchor encryption.
 */

import { argon2id } from 'hash-wasm';

// ============================================================================
// Constants
// ============================================================================

export const ARGON2_CONFIG = {
  memorySize: 65536,   // 64 MiB
  iterations: 3,
  parallelism: 4,
  hashLength: 32,      // 256-bit
} as const;

export const PIN_LENGTH = 6;

// 備份恢復驗證用固定 salt（雙方皆可獨立計算，不需交換）
export const BACKUP_AUTH_SALT = new TextEncoder().encode('AegisTalk-BackupAuth-v1');

// ============================================================================
// Buffer Helpers
// ============================================================================

/** Safe ArrayBuffer extraction from Uint8Array */
export function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(
      null, bytes.subarray(i, i + CHUNK) as unknown as number[]
    ));
  }
  return btoa(parts.join(''));
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return toBuffer(bytes);
}

export function uint8ToBase64(arr: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < arr.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(
      null, arr.subarray(i, i + CHUNK) as unknown as number[]
    ));
  }
  return btoa(parts.join(''));
}

export function base64ToUint8(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ============================================================================
// Core Crypto
// ============================================================================

/**
 * Derive key using Argon2id (memory-hard, GPU/ASIC resistant)
 */
export async function deriveKey(pin: string, salt: ArrayBuffer): Promise<ArrayBuffer> {
  const saltBytes = new Uint8Array(salt);
  const hashHex = await argon2id({
    password: pin,
    salt: saltBytes,
    memorySize: ARGON2_CONFIG.memorySize,
    iterations: ARGON2_CONFIG.iterations,
    parallelism: ARGON2_CONFIG.parallelism,
    hashLength: ARGON2_CONFIG.hashLength,
    outputType: 'hex',
  });
  const hash = new Uint8Array(hashHex.length / 2);
  for (let i = 0; i < hash.length; i++) {
    hash[i] = parseInt(hashHex.substring(i * 2, i * 2 + 2), 16);
  }
  return toBuffer(hash);
}

/**
 * Derive recovery key from PIN (returns Uint8Array)
 */
export async function deriveRecoveryKey(
  pin: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  if (!/^\d{6}$/.test(pin)) {
    throw new Error('PIN must be exactly 6 digits');
  }
  if (salt.length < 16) {
    throw new Error('Salt must be at least 16 bytes');
  }

  const hashHex = await argon2id({
    password: pin,
    salt: salt,
    memorySize: ARGON2_CONFIG.memorySize,
    iterations: ARGON2_CONFIG.iterations,
    parallelism: ARGON2_CONFIG.parallelism,
    hashLength: ARGON2_CONFIG.hashLength,
    outputType: 'hex',
  });
  const hash = new Uint8Array(hashHex.length / 2);
  for (let i = 0; i < hash.length; i++) {
    hash[i] = parseInt(hashHex.substring(i * 2, i * 2 + 2), 16);
  }
  return hash;
}

/** Generate random salt */
export function generateSalt(length: number = 32): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Constant-time comparison to prevent timing attacks */
export function secureCompare(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const viewA = new Uint8Array(a);
  const viewB = new Uint8Array(b);
  const maxLen = Math.max(viewA.length, viewB.length);
  let result = viewA.length ^ viewB.length;
  for (let i = 0; i < maxLen; i++) {
    result |= (viewA[i] ?? 0) ^ (viewB[i] ?? 0);
  }
  return result === 0;
}

/** Validate PIN format */
export function isValidPin(pin: string): boolean {
  return /^\d{6}$/.test(pin);
}

// ============================================================================
// AES-256-GCM Encryption (used by identity anchor)
// ============================================================================

function toAB(arr: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(arr.length);
  new Uint8Array(buffer).set(arr);
  return buffer;
}

/** Encrypt data with AES-256-GCM using PIN-derived key */
export async function encryptWithPin(
  plaintext: Uint8Array,
  pin: string,
): Promise<{ encrypted: string; salt: string; iv: string }> {
  const salt = generateSalt(32);
  const recoveryKey = await deriveRecoveryKey(pin, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const key = await crypto.subtle.importKey(
    'raw', toAB(recoveryKey), { name: 'AES-GCM' }, false, ['encrypt'],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toAB(iv) }, key, toAB(plaintext),
  );

  return {
    encrypted: uint8ToBase64(new Uint8Array(ciphertext)),
    salt: uint8ToBase64(salt),
    iv: uint8ToBase64(iv),
  };
}

/** Decrypt data with AES-256-GCM using PIN-derived key */
export async function decryptWithPin(
  encrypted: string,
  salt: string,
  iv: string,
  pin: string,
): Promise<Uint8Array> {
  const ciphertext = base64ToUint8(encrypted);
  const saltBytes = base64ToUint8(salt);
  const ivBytes = base64ToUint8(iv);

  const recoveryKey = await deriveRecoveryKey(pin, saltBytes);
  const key = await crypto.subtle.importKey(
    'raw', toAB(recoveryKey), { name: 'AES-GCM' }, false, ['decrypt'],
  );

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toAB(ivBytes) }, key, toAB(ciphertext),
  );

  return new Uint8Array(plaintext);
}

// ============================================================================
// Private Key Encryption (used by social recovery)
// ============================================================================

/** Encrypt private key with PIN (salt + iv + ciphertext bundled as Base64) */
export async function encryptPrivateKeyWithPin(
  privateKey: Uint8Array,
  pin: string,
): Promise<string> {
  const salt = generateSalt(32);
  const recoveryKey = await deriveRecoveryKey(pin, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const key = await crypto.subtle.importKey(
    'raw', toAB(recoveryKey), { name: 'AES-GCM' }, false, ['encrypt'],
  );
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, toAB(privateKey),
  ));

  // Format: salt (32) + iv (12) + ciphertext (variable)
  const combined = new Uint8Array(salt.length + iv.length + ciphertext.length);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(ciphertext, salt.length + iv.length);
  return uint8ToBase64(combined);
}

/** Decrypt private key with PIN */
export async function decryptPrivateKeyWithPin(
  encryptedData: string,
  pin: string,
): Promise<Uint8Array> {
  const combined = base64ToUint8(encryptedData);
  if (combined.length < 44) {
    throw new Error('Invalid encrypted data format');
  }

  const salt = combined.slice(0, 32);
  const iv = combined.slice(32, 44);
  const ciphertext = combined.slice(44);

  const recoveryKey = await deriveRecoveryKey(pin, salt);
  const key = await crypto.subtle.importKey(
    'raw', toAB(recoveryKey), { name: 'AES-GCM' }, false, ['decrypt'],
  );

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(toAB(iv)) }, key, toAB(ciphertext),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new Error('Decryption failed: incorrect PIN or corrupted data');
  }
}
