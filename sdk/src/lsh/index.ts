/**
 * LSH (Locality-Sensitive Hashing) Module
 *
 * Fuzzy matching of behavior fingerprints across sessions.
 * Similar behavior vectors produce similar hashes.
 */

export type {
  LSHConfig,
  LSHHashResult,
  LSHCompareResult,
} from './lshFingerprint';

export {
  computeLSHHash,
  hammingDistance,
  compareLSHHash,
  PIN_LSH_CONFIG,
  PIN_FEATURE_NAMES,
  extractPinLSHFeatures,
  computePinLSHHash,
  formatLSHHashForDisplay,
  formatCompareResultForDisplay,
} from './lshFingerprint';
