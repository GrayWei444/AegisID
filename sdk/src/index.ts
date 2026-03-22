/**
 * AegisID SDK — Anonymous Identity Verification
 *
 * Modules:
 * - face:     骨骼比率臉部辨識 + MediaPipe liveness detection + MiniFASNet anti-spoof
 * - behavior: PIN behavior fingerprinting (18-dim) + emulator/bot detection
 * - lsh:      Locality-Sensitive Hashing for cross-session behavior matching
 * - identity: Device fingerprinting (canvas/webgl/audio hash) for same-device detection
 */

// ============================================================================
// Face Recognition
// ============================================================================

export type {
  FaceEmbedding,
  FaceLandmark,
  FaceGeometry,
  FaceDetectionStatus,
  FaceVerifyResult,
  LivenessResult,
  LivenessChallenge,
  LivenessChallengeStatus,
  StoredFaceEmbedding,
  BoundingBox,
  AntiSpoofResult,
  EmbeddingConsistency,
  ChallengeEmbeddingSnapshot,
  SpoofDetectionResult,
} from './face';

export { LANDMARK_EMBEDDING_DIM } from './face';

export {
  initFaceLandmarker,
  isFaceLandmarkerReady,
  isFaceLandmarkerInitializing,
  detectFace,
  extractFaceGeometry,
  closeFaceLandmarker,
  ActiveLivenessDetector,
  PassiveLivenessDetector,
  extractFaceEmbedding,
  cosineSimilarity,
  computeStableEmbedding,
  computeEmbeddingConsistency,
  initAntiSpoofModel,
  initCnnModels,
  isAntiSpoofReady,
  isCnnReady,
  isAntiSpoofInitializing,
  isCnnInitializing,
  isAntiSpoofFailed,
  isCnnFailed,
  detectSpoof,
  closeAntiSpoofModel,
  closeCnnModels,
  saveFaceEmbedding,
  getFaceEmbedding,
  hasFaceEnrolled,
  clearFaceData,
  getStoredFaceEmbeddingRaw,
  restoreFaceEmbedding,
} from './face';

export { useFaceRecognition } from './face/useFaceRecognition';
export type { UseFaceRecognitionOptions, VerifyFaceResult } from './face/useFaceRecognition';

// ============================================================================
// Behavior Fingerprint
// ============================================================================

export type {
  PinTouchData,
  PinKeypress,
  PinInputRawData,
  PinBehaviorFingerprint,
  MotionSensorData,
  EmulatorDetectionResult,
} from './behavior';

export {
  calculateFingerprint,
  detectEmulatorOrBot,
  formatFingerprintForDisplay,
  formatDetectionResultForDisplay,
  usePinBehavior,
} from './behavior';

// ============================================================================
// LSH (Locality-Sensitive Hashing)
// ============================================================================

export type {
  LSHConfig,
  LSHHashResult,
  LSHCompareResult,
} from './lsh';

export {
  computeLSHHash,
  hammingDistance,
  compareLSHHash,
  PIN_LSH_CONFIG,
  PIN_FEATURE_NAMES,
  extractPinLSHFeatures,
  computePinLSHHash,
  FACE_LSH_CONFIG,
  computeFaceLSHHash,
  formatLSHHashForDisplay,
  formatCompareResultForDisplay,
} from './lsh';

// ============================================================================
// Database Adapter
// ============================================================================

export type { DatabaseAdapter } from './database';
export { setDatabaseAdapter } from './database';

// ============================================================================
// Identity (Device Fingerprinting)
// ============================================================================

export type {
  DeviceFingerprint,
  StoredDeviceFingerprint,
  DeviceFingerprintCheckResult,
} from './identity';

export {
  collectDeviceFingerprint,
  computeDeviceHash,
  saveDeviceFingerprint,
  loadDeviceFingerprint,
  checkSameDevice,
  checkDeviceFingerprintWithBackend,
} from './identity';
