/**
 * Phase 26: Face Recognition Types
 * Phase 26b: CNN 臉部特徵擷取 + 防偽
 */

// ============================================================================
// Embedding Types
// ============================================================================

/** 臉部 embedding 向量（CNN 512 維 or landmark fallback 128 維） */
export type FaceEmbedding = Float32Array;

/** CNN embedding 維度 */
export const CNN_EMBEDDING_DIM = 512;

/** Landmark embedding 維度（fallback） */
export const LANDMARK_EMBEDDING_DIM = 128;

// ============================================================================
// Bounding Box
// ============================================================================

/** 臉部邊界框（正規化座標 0-1） */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ============================================================================
// Liveness Types
// ============================================================================

/** 活體挑戰類型 */
export type LivenessChallenge = 'blink' | 'turn_head';

/** 活體挑戰狀態 */
export type LivenessChallengeStatus = 'waiting' | 'detected' | 'timeout';

/** 活體偵測結果 */
export interface LivenessResult {
  /** 是否通過活體偵測 */
  passed: boolean;
  /** 偵測模式 */
  mode: 'active' | 'passive';
  /** 各挑戰完成狀態 */
  challenges: {
    type: LivenessChallenge;
    status: LivenessChallengeStatus;
  }[];
  /** 信心度 (0-1) */
  confidence: number;
  /** 防偽分析結果（Phase 26b） */
  antiSpoof?: AntiSpoofResult;
}

// ============================================================================
// Anti-Spoof Types (Phase 26b)
// ============================================================================

/** CNN 防偽分析結果 */
export interface AntiSpoofResult {
  /** CNN 判定信心度 (0-1，越高越可能是真人) */
  cnnScore: number;
  /** CNN 多幀投票結果 */
  cnnVotes: { real: number; spoof: number };
  /** Embedding 一致性分析 */
  embeddingConsistency: EmbeddingConsistency;
  /** 綜合防偽分數 (0-1) */
  score: number;
  /** 是否可疑 */
  isSuspicious: boolean;
}

/** Embedding 一致性分析 */
export interface EmbeddingConsistency {
  /** 眨眼前後 embedding cosine similarity（真人 0.85-0.995，照片 >0.995） */
  blinkDelta: number;
  /** 轉頭時雙眼寬度比變化（真人 >0.1，照片 <0.05） */
  turnEyeRatio: number;
  /** 多幀 embedding 方差（太穩定 >0.99 = 可疑） */
  overallVariance: number;
}

/** 挑戰期間 embedding 快照 */
export interface ChallengeEmbeddingSnapshot {
  challenge: LivenessChallenge;
  phase: 'before' | 'during' | 'after';
  embedding: FaceEmbedding;
  geometry: FaceGeometry;
  timestamp: number;
}

/** CNN 防偽單幀推論結果 */
export interface SpoofDetectionResult {
  isReal: boolean;
  confidence: number;
}

// ============================================================================
// Face Detection Types
// ============================================================================

/** 臉部驗證結果 */
export interface FaceVerifyResult {
  /** cosine 相似度 (-1 到 1) */
  similarity: number;
  /** 是否通過驗證（similarity >= threshold） */
  isMatch: boolean;
  /** 使用的閾值 */
  threshold: number;
  /** 活體偵測結果 */
  liveness: LivenessResult;
}

/** 臉部偵測狀態 */
export type FaceDetectionStatus =
  | 'idle'           // 未啟動
  | 'loading'        // 載入模型中
  | 'ready'          // 模型已載入，等待人臉
  | 'face_detected'  // 偵測到人臉
  | 'challenge'      // 活體挑戰中
  | 'capturing'      // 擷取 embedding 中
  | 'verified'       // 驗證通過
  | 'failed'         // 驗證失敗
  | 'error';         // 錯誤

/** FaceLandmarker 輸出的 landmark 座標 */
export interface FaceLandmark {
  x: number;
  y: number;
  z: number;
}

/** 臉部幾何測量 */
export interface FaceGeometry {
  /** Eye Aspect Ratio — <0.2 = 閉眼 */
  leftEAR: number;
  rightEAR: number;
  /** 嘴角距離（正規化）— >0.5 = 微笑 */
  mouthWidth: number;
  /** 鼻子 X 偏移（正規化）— |x|>0.15 = 轉頭 */
  noseOffsetX: number;
  /** 臉部邊界框 */
  boundingBox: BoundingBox;
}

// ============================================================================
// Storage Types
// ============================================================================

/** 加密儲存的 embedding */
export interface StoredFaceEmbedding {
  /** AES-256-GCM 加密的 embedding */
  ciphertext: string;
  /** IV (Base64) */
  iv: string;
  /** 儲存時間 */
  timestamp: number;
  /** embedding 來源（CNN or landmark） */
  source?: 'cnn' | 'landmark';
  /** embedding 維度 */
  dim?: number;
}
