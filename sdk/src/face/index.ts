/**
 * Phase 26: Face Recognition Module
 * Phase 26b: CNN 臉部特徵擷取 + 防偽
 *
 * Re-exports for face recognition services
 */

// Types
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
} from './types';

export { CNN_EMBEDDING_DIM, LANDMARK_EMBEDDING_DIM } from './types';

// Face Mesh (MediaPipe)
export {
  initFaceLandmarker,
  isFaceLandmarkerReady,
  isFaceLandmarkerInitializing,
  detectFace,
  extractFaceGeometry,
  closeFaceLandmarker,
} from './faceMesh';

// Liveness Detection
export { ActiveLivenessDetector, PassiveLivenessDetector } from './liveness';

// Embedding
export {
  extractFaceEmbedding,
  cosineSimilarity,
  computeStableEmbedding,
  computeStableCnnEmbedding,
  computeEmbeddingConsistency,
} from './embedding';

// CNN Inference (Phase 26b)
export {
  initCnnModels,
  isCnnReady,
  isCnnInitializing,
  isCnnFailed,
  extractCnnEmbedding,
  detectSpoof,
  closeCnnModels,
  resetBboxSmoothing,
} from './cnnInference';

// Storage
export {
  saveFaceEmbedding,
  getFaceEmbedding,
  hasFaceEnrolled,
  ensureFaceStorageSync,
  clearFaceData,
  getStoredFaceEmbeddingRaw,
  restoreFaceEmbedding,
} from './storage';
