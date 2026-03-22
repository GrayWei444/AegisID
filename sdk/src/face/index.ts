/**
 * Face Recognition Module
 *
 * - 骨骼比率臉部辨識（structuralId.ts）— 主要路線
 * - Anti-spoof 防偽（MiniFASNetV2SE）
 * - MediaPipe FaceLandmarker（468 landmarks）
 * - Landmark-based embedding（降級 fallback）
 *
 * MobileFaceNet CNN embedding 已移除，臉部辨識改用骨骼比率系統。
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

export { LANDMARK_EMBEDDING_DIM } from './types';

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

// Embedding (landmark-based)
export {
  extractFaceEmbedding,
  cosineSimilarity,
  computeStableEmbedding,
  computeEmbeddingConsistency,
} from './embedding';

// Anti-Spoof Inference (MiniFASNetV2SE)
export {
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
  resetBboxSmoothing,
} from './cnnInference';

// React Hook
export { useFaceRecognition } from './useFaceRecognition';
export type { UseFaceRecognitionOptions, VerifyFaceResult } from './useFaceRecognition';

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
