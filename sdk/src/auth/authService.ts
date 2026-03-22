/**
 * Auth Service — PIN management, lockout, and behavior baseline
 *
 * Handles PIN setup, verification, failed attempt tracking,
 * behavior lockout, and backup recovery authentication.
 *
 * Storage strategy: dual-write
 * - localStorage: sync cache (fast, used by synchronous methods)
 * - DatabaseAdapter: durable backup (async, fire-and-forget writes)
 */

import {
  deriveKey,
  generateSalt,
  secureCompare,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  toBuffer,
  PIN_LENGTH,
  BACKUP_AUTH_SALT,
} from './pinHash';
import { getSetting, setSetting, deleteSetting } from '../database';

// ============================================================================
// Storage Keys
// ============================================================================

const STORAGE_KEYS = {
  PIN_HASH: 'mist_pin_hash',
  PIN_SALT: 'mist_pin_salt',
  FAILED_ATTEMPTS: 'mist_failed_attempts',
  LOCKOUT_UNTIL: 'mist_lockout_until',
  BEHAVIOR_FAILED_ATTEMPTS: 'aegis_behavior_failed_attempts',
  BEHAVIOR_LOCKOUT_UNTIL: 'aegis_behavior_lockout_until',
  BEHAVIOR_BASELINE: 'aegis_behavior_baseline',
  BACKUP_AUTH_HASH: 'aegis_backup_auth_hash',
} as const;

// ============================================================================
// Config
// ============================================================================

const CONFIG = {
  MAX_ATTEMPTS: 5,
  LOCKOUT_DURATION: 5 * 60 * 1000, // 5 min (PIN errors)
  BEHAVIOR_MAX_ATTEMPTS: 5,
  BEHAVIOR_LOCKOUT_DURATION: 24 * 60 * 60 * 1000, // 24h
} as const;

// ============================================================================
// Migration
// ============================================================================

let _migrated = false;

async function ensureMigrated(): Promise<void> {
  if (_migrated) return;
  _migrated = true;
  // Migration is handled by host app via DatabaseAdapter
  // SDK just ensures settings are readable from adapter
}

// ============================================================================
// AuthService
// ============================================================================

class AuthService {
  // ---------- PIN Management ----------

  async hasPin(): Promise<boolean> {
    await ensureMigrated();
    let hash = localStorage.getItem(STORAGE_KEYS.PIN_HASH);
    let salt = localStorage.getItem(STORAGE_KEYS.PIN_SALT);
    if (!hash) hash = await getSetting(STORAGE_KEYS.PIN_HASH) ?? null;
    if (!salt) salt = await getSetting(STORAGE_KEYS.PIN_SALT) ?? null;
    return !!(hash && salt);
  }

  async setPin(pin: string): Promise<void> {
    if (pin.length !== PIN_LENGTH) {
      throw new Error(`PIN must be ${PIN_LENGTH} digits`);
    }
    if (!/^\d+$/.test(pin)) {
      throw new Error('PIN must contain only digits');
    }

    const salt = generateSalt();
    const hash = await deriveKey(pin, toBuffer(salt));

    const hashB64 = arrayBufferToBase64(hash);
    const saltB64 = arrayBufferToBase64(toBuffer(salt));
    localStorage.setItem(STORAGE_KEYS.PIN_HASH, hashB64);
    setSetting(STORAGE_KEYS.PIN_HASH, hashB64).catch(() => {});
    localStorage.setItem(STORAGE_KEYS.PIN_SALT, saltB64);
    setSetting(STORAGE_KEYS.PIN_SALT, saltB64).catch(() => {});

    this._resetFailedAttempts();

    // Backup recovery auth hash (fixed salt, both parties can compute independently)
    const backupAuthHash = await deriveKey(pin, toBuffer(BACKUP_AUTH_SALT));
    const backupAuthB64 = arrayBufferToBase64(backupAuthHash);
    localStorage.setItem(STORAGE_KEYS.BACKUP_AUTH_HASH, backupAuthB64);
    setSetting(STORAGE_KEYS.BACKUP_AUTH_HASH, backupAuthB64).catch(() => {});
  }

  async verifyPin(pin: string): Promise<boolean> {
    if (this.isLockedOut()) {
      return false;
    }

    let storedHash = localStorage.getItem(STORAGE_KEYS.PIN_HASH);
    let storedSalt = localStorage.getItem(STORAGE_KEYS.PIN_SALT);
    if (!storedHash) storedHash = await getSetting(STORAGE_KEYS.PIN_HASH) ?? null;
    if (!storedSalt) storedSalt = await getSetting(STORAGE_KEYS.PIN_SALT) ?? null;

    if (!storedHash || !storedSalt) {
      return false;
    }

    try {
      const salt = base64ToArrayBuffer(storedSalt);
      const hash = await deriveKey(pin, salt);
      const expectedHash = base64ToArrayBuffer(storedHash);
      const isValid = secureCompare(hash, expectedHash);

      if (isValid) {
        this._resetFailedAttempts();
        return true;
      } else {
        this._incrementFailedAttempts();
        return false;
      }
    } catch {
      return false;
    }
  }

  async changePin(oldPin: string, newPin: string): Promise<boolean> {
    const isValid = await this.verifyPin(oldPin);
    if (!isValid) return false;
    await this.setPin(newPin);
    return true;
  }

  async clearPin(): Promise<void> {
    localStorage.removeItem(STORAGE_KEYS.PIN_HASH);
    deleteSetting(STORAGE_KEYS.PIN_HASH).catch(() => {});
    localStorage.removeItem(STORAGE_KEYS.PIN_SALT);
    deleteSetting(STORAGE_KEYS.PIN_SALT).catch(() => {});
    localStorage.removeItem(STORAGE_KEYS.BACKUP_AUTH_HASH);
    deleteSetting(STORAGE_KEYS.BACKUP_AUTH_HASH).catch(() => {});
  }

  async clearAll(): Promise<void> {
    for (const key of Object.values(STORAGE_KEYS)) {
      localStorage.removeItem(key);
      deleteSetting(key).catch(() => {});
    }
  }

  hasPinSet(): boolean {
    return localStorage.getItem(STORAGE_KEYS.PIN_HASH) !== null;
  }

  // ---------- Failed Attempts Lockout ----------

  getFailedAttempts(): number {
    const attempts = localStorage.getItem(STORAGE_KEYS.FAILED_ATTEMPTS);
    return attempts ? parseInt(attempts, 10) : 0;
  }

  private _incrementFailedAttempts(): void {
    const attempts = this.getFailedAttempts() + 1;
    const attemptsStr = attempts.toString();
    localStorage.setItem(STORAGE_KEYS.FAILED_ATTEMPTS, attemptsStr);
    setSetting(STORAGE_KEYS.FAILED_ATTEMPTS, attemptsStr).catch(() => {});

    if (attempts >= CONFIG.MAX_ATTEMPTS) {
      const lockoutUntil = Date.now() + CONFIG.LOCKOUT_DURATION;
      const lockoutStr = lockoutUntil.toString();
      localStorage.setItem(STORAGE_KEYS.LOCKOUT_UNTIL, lockoutStr);
      setSetting(STORAGE_KEYS.LOCKOUT_UNTIL, lockoutStr).catch(() => {});
    }
  }

  private _resetFailedAttempts(): void {
    localStorage.removeItem(STORAGE_KEYS.FAILED_ATTEMPTS);
    deleteSetting(STORAGE_KEYS.FAILED_ATTEMPTS).catch(() => {});
    localStorage.removeItem(STORAGE_KEYS.LOCKOUT_UNTIL);
    deleteSetting(STORAGE_KEYS.LOCKOUT_UNTIL).catch(() => {});
  }

  isLockedOut(): boolean {
    const lockoutUntil = localStorage.getItem(STORAGE_KEYS.LOCKOUT_UNTIL);
    if (!lockoutUntil) return false;
    const lockoutTime = parseInt(lockoutUntil, 10);
    if (Date.now() >= lockoutTime) {
      this._resetFailedAttempts();
      return false;
    }
    return true;
  }

  getLockoutRemaining(): number {
    const lockoutUntil = localStorage.getItem(STORAGE_KEYS.LOCKOUT_UNTIL);
    if (!lockoutUntil) return 0;
    return Math.max(0, parseInt(lockoutUntil, 10) - Date.now());
  }

  // ---------- Behavior Lockout ----------

  getBehaviorFailedAttempts(): number {
    const attempts = localStorage.getItem(STORAGE_KEYS.BEHAVIOR_FAILED_ATTEMPTS);
    return attempts ? parseInt(attempts, 10) : 0;
  }

  incrementBehaviorFailedAttempts(): boolean {
    const attempts = this.getBehaviorFailedAttempts() + 1;
    const attemptsStr = attempts.toString();
    localStorage.setItem(STORAGE_KEYS.BEHAVIOR_FAILED_ATTEMPTS, attemptsStr);
    setSetting(STORAGE_KEYS.BEHAVIOR_FAILED_ATTEMPTS, attemptsStr).catch(() => {});

    if (attempts >= CONFIG.BEHAVIOR_MAX_ATTEMPTS) {
      const lockoutUntil = Date.now() + CONFIG.BEHAVIOR_LOCKOUT_DURATION;
      const lockoutStr = lockoutUntil.toString();
      localStorage.setItem(STORAGE_KEYS.BEHAVIOR_LOCKOUT_UNTIL, lockoutStr);
      setSetting(STORAGE_KEYS.BEHAVIOR_LOCKOUT_UNTIL, lockoutStr).catch(() => {});
      return true;
    }
    return false;
  }

  resetBehaviorFailedAttempts(): void {
    localStorage.removeItem(STORAGE_KEYS.BEHAVIOR_FAILED_ATTEMPTS);
    deleteSetting(STORAGE_KEYS.BEHAVIOR_FAILED_ATTEMPTS).catch(() => {});
    localStorage.removeItem(STORAGE_KEYS.BEHAVIOR_LOCKOUT_UNTIL);
    deleteSetting(STORAGE_KEYS.BEHAVIOR_LOCKOUT_UNTIL).catch(() => {});
  }

  isBehaviorLockedOut(): boolean {
    const lockoutUntil = localStorage.getItem(STORAGE_KEYS.BEHAVIOR_LOCKOUT_UNTIL);
    if (!lockoutUntil) return false;
    const lockoutTime = parseInt(lockoutUntil, 10);
    if (Date.now() >= lockoutTime) {
      this.resetBehaviorFailedAttempts();
      return false;
    }
    return true;
  }

  getBehaviorLockoutRemaining(): number {
    const lockoutUntil = localStorage.getItem(STORAGE_KEYS.BEHAVIOR_LOCKOUT_UNTIL);
    if (!lockoutUntil) return 0;
    return Math.max(0, parseInt(lockoutUntil, 10) - Date.now());
  }

  formatBehaviorLockoutRemaining(): string {
    const remaining = this.getBehaviorLockoutRemaining();
    if (remaining <= 0) return '';
    const hours = Math.floor(remaining / (60 * 60 * 1000));
    const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
    if (hours > 0) return `${hours} 小時 ${minutes} 分鐘`;
    return `${minutes} 分鐘`;
  }

  // ---------- Behavior Baseline ----------

  saveBehaviorBaseline(fingerprint: unknown): void {
    try {
      const data = JSON.stringify(fingerprint);
      localStorage.setItem(STORAGE_KEYS.BEHAVIOR_BASELINE, data);
      setSetting(STORAGE_KEYS.BEHAVIOR_BASELINE, data).catch(() => {});
    } catch {
      // silently ignore
    }
  }

  getBehaviorBaseline<T>(): T | null {
    try {
      const data = localStorage.getItem(STORAGE_KEYS.BEHAVIOR_BASELINE);
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  }

  async getBehaviorBaselineAsync<T>(): Promise<T | null> {
    try {
      let data = localStorage.getItem(STORAGE_KEYS.BEHAVIOR_BASELINE);
      if (!data) data = await getSetting(STORAGE_KEYS.BEHAVIOR_BASELINE) ?? null;
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  }

  hasBehaviorBaseline(): boolean {
    return localStorage.getItem(STORAGE_KEYS.BEHAVIOR_BASELINE) !== null;
  }

  async hasBehaviorBaselineAsync(): Promise<boolean> {
    if (localStorage.getItem(STORAGE_KEYS.BEHAVIOR_BASELINE) !== null) return true;
    const val = await getSetting(STORAGE_KEYS.BEHAVIOR_BASELINE);
    return val !== undefined && val !== null;
  }

  clearBehaviorBaseline(): void {
    localStorage.removeItem(STORAGE_KEYS.BEHAVIOR_BASELINE);
    deleteSetting(STORAGE_KEYS.BEHAVIOR_BASELINE).catch(() => {});
  }

  // ---------- Backup Recovery Auth ----------

  async deriveBackupAuthHash(pin: string): Promise<string> {
    const hash = await deriveKey(pin, toBuffer(BACKUP_AUTH_SALT));
    return arrayBufferToBase64(hash);
  }

  async verifyBackupAuthHash(receivedHash: string): Promise<boolean> {
    let storedHash = localStorage.getItem(STORAGE_KEYS.BACKUP_AUTH_HASH);
    if (!storedHash) storedHash = await getSetting(STORAGE_KEYS.BACKUP_AUTH_HASH) ?? null;
    if (!storedHash) return false;

    const received = base64ToArrayBuffer(receivedHash);
    const expected = base64ToArrayBuffer(storedHash);
    return secureCompare(received, expected);
  }

  // ---------- Device Transfer Restore ----------

  async restoreFromTransfer(data: {
    pinHash?: string;
    pinSalt?: string;
    backupAuthHash?: string;
    behaviorBaseline?: string;
  }): Promise<void> {
    if (data.pinHash && data.pinSalt) {
      localStorage.setItem(STORAGE_KEYS.PIN_HASH, data.pinHash);
      localStorage.setItem(STORAGE_KEYS.PIN_SALT, data.pinSalt);
      setSetting(STORAGE_KEYS.PIN_HASH, data.pinHash).catch(() => {});
      setSetting(STORAGE_KEYS.PIN_SALT, data.pinSalt).catch(() => {});
    }

    if (data.backupAuthHash) {
      localStorage.setItem(STORAGE_KEYS.BACKUP_AUTH_HASH, data.backupAuthHash);
      setSetting(STORAGE_KEYS.BACKUP_AUTH_HASH, data.backupAuthHash).catch(() => {});
    }

    if (data.behaviorBaseline) {
      localStorage.setItem(STORAGE_KEYS.BEHAVIOR_BASELINE, data.behaviorBaseline);
      setSetting(STORAGE_KEYS.BEHAVIOR_BASELINE, data.behaviorBaseline).catch(() => {});
    }

    this._resetFailedAttempts();
  }
}

// Singleton export
export const authService = new AuthService();
export { ensureMigrated as migrateAuthToSQLite };
export default authService;
