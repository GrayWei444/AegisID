/**
 * Identity Module
 *
 * Device fingerprinting for same-device detection
 * and multi-account prevention.
 */

export type {
  DeviceFingerprint,
  StoredDeviceFingerprint,
  DeviceFingerprintCheckResult,
} from './deviceFingerprint';

export {
  collectDeviceFingerprint,
  computeDeviceHash,
  saveDeviceFingerprint,
  loadDeviceFingerprint,
  checkSameDevice,
  checkDeviceFingerprintWithBackend,
} from './deviceFingerprint';
