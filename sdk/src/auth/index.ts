/**
 * Auth Module
 *
 * PIN-based authentication with Argon2id key derivation,
 * lockout protection, behavior baseline management,
 * and AES-256-GCM encryption utilities.
 */

export {
  // Core crypto
  deriveKey,
  deriveRecoveryKey,
  generateSalt,
  secureCompare,
  isValidPin,
  // AES-256-GCM
  encryptWithPin,
  decryptWithPin,
  encryptPrivateKeyWithPin,
  decryptPrivateKeyWithPin,
  // Buffer helpers
  toBuffer,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  uint8ToBase64,
  base64ToUint8,
  // Constants
  ARGON2_CONFIG,
  PIN_LENGTH,
  BACKUP_AUTH_SALT,
} from './pinHash';

export {
  authService,
  migrateAuthToSQLite,
} from './authService';

export type { default as AuthServiceType } from './authService';
