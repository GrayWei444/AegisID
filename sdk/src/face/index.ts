/**
 * Face Recognition Module
 *
 * - 骨骼比率臉部辨識（structuralId.ts）— 主要路線
 * - Anti-spoof 防偽（MiniFASNetV2SE）
 * - MediaPipe FaceLandmarker（468 landmarks）
 */

// Types
export type {
  FaceEmbedding,
  FaceLandmark,
  FaceGeometry,
  FaceDetectionStatus,
  FaceDetectionResult,
  FaceVerifyResult,
  LivenessResult,
  LivenessChallenge,
  LivenessChallengeStatus,
  StoredFaceEmbedding,
  StoredBoneRatioData,
  BoneRatioPlainData,
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

// Structural Face ID v17 (骨骼比率 + 真 3D)
export {
  computeStructuralId,
  matchLoginBins,
  buildTrue3DModel,
  buildTrue3DModel as build3DModel,
  compute3DFeatures,
  computeBoneRatios,
  computeMedianBins,
  selectStrictFrontalFrames,
  computePHash4x4,
  computeAccountKey,
  DEFAULT_BIN_WIDTH,
  LOGIN_MATCH_THRESHOLD,
  STABLE_RATIO_WHITELIST,
  STABLE_3D_FEATURES,
} from './structuralId';

export type {
  CapturedFrame,
  Landmark3D,
  TransformMatrixData,
  FaceStructureIdResult,
  IdentityHashes,
  LoginMatchResult,
  BoneRatioResult,
  BoneRatioCategory,
  GrayImage,
  PHash,
} from './structuralId';

// Embedding (landmark-based, legacy — kept for backward compat)
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
  saveBoneRatioData,
  getBoneRatioData,
} from './storage';
