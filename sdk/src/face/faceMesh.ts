/**
 * Phase 26: MediaPipe Face Landmarker Wrapper
 *
 * 使用 @mediapipe/tasks-vision 的 FaceLandmarker 偵測 468 個臉部 landmarks
 * 並從中提取幾何測量值（EAR、嘴角距離、鼻子偏移）用於活體偵測
 *
 * Delegate 策略（A+B fallback）：
 *   1. 預設 GPU + outputFacialTransformationMatrixes:false（最快路徑）
 *   2. 如果 detect 拋例外、或前 N 幀 landmark 全 garbage（visibility=0、x/y 超界）
 *      → 自動 close GPU instance，重 init 用 CPU
 *   3. CPU init 完成後 detect 路徑無縫切過去
 *   4. localStorage 記住該裝置 GPU broken，下次直接走 CPU 不浪費時間
 *
 * 所以一般使用者：GPU 速度（~10ms/frame）；GPU 壞的設備：CPU fallback（~30ms/frame）。
 */

import { FaceLandmarker, FilesetResolver, type FaceLandmarkerOptions } from '@mediapipe/tasks-vision';
import { devLog, devWarn } from '../utils/devLog';
import type { FaceLandmark, FaceGeometry, FaceDetectionResult } from './types';

// ============================================================================
// Singleton Instance
// ============================================================================

let landmarkerInstance: FaceLandmarker | null = null;
let isInitializing = false;
let initPromise: Promise<FaceLandmarker> | null = null;
let visionFileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let currentDelegate: 'GPU' | 'CPU' = 'GPU';

// GPU 失敗偵測：consecutive bad frames threshold
const GPU_BAD_FRAME_THRESHOLD = 5;
let gpuBadFrameCount = 0;
let gpuFallbackInProgress = false;
const GPU_FAIL_CACHE_KEY = 'aegisid_face_gpu_failed';

// 從 localStorage 讀「這台設備之前 GPU 已壞掉」的記憶
function isGpuKnownBroken(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(GPU_FAIL_CACHE_KEY) === '1';
  } catch { return false; }
}
function markGpuBroken(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(GPU_FAIL_CACHE_KEY, '1');
  } catch { /* ignore */ }
}

// 共用的 createFromOptions 配置（delegate 動態替換）
function buildOptions(delegate: 'GPU' | 'CPU'): FaceLandmarkerOptions {
  return {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      delegate,
    },
    runningMode: 'IMAGE',
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: true,
    // 關掉 transformation matrix — face_geometry calculator 在部分 Android GPU
    // 上 design_matrix.norm()=0 → procrustes solver 崩潰整個 graph throw exception。
    // 下游 yaw/rotation 都用 landmark 自己算（structuralId.ts:15: "Landmark-based
    // rotation 不依賴 MediaPipe matrix"），matrix 只是 debug 用，可關。
    // 關掉之後 GPU delegate 在多數設備可正常運作。
    outputFacialTransformationMatrixes: false,
  };
}

/**
 * 初始化 FaceLandmarker（lazy-load，首次使用時載入模型）
 *
 * 預設 GPU；若 localStorage 標記過 GPU 壞，直接走 CPU。
 * Detect 期間若 GPU 證實 broken，會自動重 init 切 CPU。
 */
export async function initFaceLandmarker(): Promise<FaceLandmarker> {
  if (landmarkerInstance) return landmarkerInstance;
  if (initPromise) return initPromise;

  isInitializing = true;
  currentDelegate = isGpuKnownBroken() ? 'CPU' : 'GPU';

  initPromise = (async () => {
    try {
      devLog(`[FaceMesh] Initializing FaceLandmarker (delegate=${currentDelegate})...`);
      const startTime = Date.now();

      // 釘死 MediaPipe WASM 版本！@latest 會在 patch release 時無聲變動，
      // 0.10.33+ 某些版本 landmark 座標格式從 normalized [0,1] 改成 pixel coords。
      // 升級時手動驗證再改。對應本機 node_modules 版本 (^0.10.18)。
      if (!visionFileset) {
        visionFileset = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm'
        );
      }

      landmarkerInstance = await FaceLandmarker.createFromOptions(
        visionFileset,
        buildOptions(currentDelegate)
      );

      const elapsed = Date.now() - startTime;
      devLog(`[FaceMesh] Initialized in ${elapsed}ms (delegate=${currentDelegate})`);
      gpuBadFrameCount = 0;
      gpuFallbackInProgress = false;

      return landmarkerInstance;
    } catch (err) {
      devLog('[FaceMesh] Initialization failed:', err);
      initPromise = null;
      throw err;
    } finally {
      isInitializing = false;
    }
  })();

  return initPromise;
}

/** 檢查是否已初始化 */
export function isFaceLandmarkerReady(): boolean {
  return landmarkerInstance !== null;
}

/** 檢查是否正在初始化 */
export function isFaceLandmarkerInitializing(): boolean {
  return isInitializing;
}

/** 目前實際運作的 delegate（給 UI / debug 用）*/
export function getCurrentDelegate(): 'GPU' | 'CPU' {
  return currentDelegate;
}

// ============================================================================
// GPU → CPU fallback 觸發
// ============================================================================

async function fallbackToCpu(reason: string): Promise<void> {
  if (gpuFallbackInProgress) return;
  if (currentDelegate === 'CPU') return;  // 已是 CPU 不用再 fallback
  gpuFallbackInProgress = true;
  devWarn(`[FaceMesh] GPU broken (${reason}), falling back to CPU`);
  markGpuBroken();
  try {
    if (landmarkerInstance) { try { landmarkerInstance.close(); } catch { /* ignore */ } }
    landmarkerInstance = null;
    initPromise = null;
    currentDelegate = 'CPU';
    if (visionFileset) {
      landmarkerInstance = await FaceLandmarker.createFromOptions(
        visionFileset,
        buildOptions('CPU')
      );
      devLog('[FaceMesh] CPU fallback ready');
    }
    gpuBadFrameCount = 0;
  } finally {
    gpuFallbackInProgress = false;
  }
}

/**
 * 判斷一個 landmark frame 是否為 GPU shader 失敗的 garbage：
 * - landmark[0].x 不在 normalized [0, 1] 範圍 → 座標系統壞了（pixel coord garbage）
 * - 多數 visibility 都是 0 → 對 face landmarker 來說正常（face landmark 沒 visibility 概念）
 *   所以只用座標範圍判斷
 */
function isGarbageLandmarks(landmarks: FaceLandmark[]): boolean {
  if (landmarks.length === 0) return true;
  const lm0 = landmarks[0];
  return !(lm0.x >= 0 && lm0.x <= 1 && lm0.y >= 0 && lm0.y <= 1);
}

// ============================================================================
// Face Detection
// ============================================================================

/**
 * 從 video frame 偵測臉部 landmarks
 *
 * @returns landmarks + matrix + yaw，或 null（未偵測到人臉 / GPU 失敗 fallback 中）
 */
export function detectFace(
  video: HTMLVideoElement,
  _timestampMs: number
): FaceDetectionResult | null {
  if (!landmarkerInstance) return null;

  // try/catch — MediaPipe 內部 calculator 偶有 throw（procrustes/SVD/NaN ROI 等）
  let result;
  try {
    result = landmarkerInstance.detect(video);
  } catch (err) {
    const msg = (err as Error).message;
    devLog('[FaceMesh] detect threw:', msg);
    if (currentDelegate === 'GPU') {
      // GPU detect throw 是強訊號，立刻 fallback
      void fallbackToCpu('detect threw: ' + msg.slice(0, 80));
    }
    return null;
  }

  if (!result.faceLandmarks || result.faceLandmarks.length === 0) {
    return null;
  }

  const landmarks = result.faceLandmarks[0] as FaceLandmark[];

  // GPU 健康檢查：座標退化（非 normalized）= shader 跑壞了
  if (currentDelegate === 'GPU' && isGarbageLandmarks(landmarks)) {
    gpuBadFrameCount++;
    if (gpuBadFrameCount >= GPU_BAD_FRAME_THRESHOLD) {
      void fallbackToCpu(`${gpuBadFrameCount} consecutive garbage frames`);
    }
    return null;
  }
  if (currentDelegate === 'GPU') gpuBadFrameCount = 0; // reset on good frame

  // 從 transformation matrix 提取資料（目前 buildOptions 已關閉 matrix output，這裡 always undefined）
  let matrix: { data: number[] } | undefined;
  if (
    result.facialTransformationMatrixes &&
    result.facialTransformationMatrixes.length > 0
  ) {
    const mat = result.facialTransformationMatrixes[0];
    const matData = mat.data ? Array.from(mat.data as Iterable<number>) : [];
    if (matData.length >= 16) {
      matrix = { data: matData };
    }
  }

  // Blendshapes — 52 個表情係數
  let blendshapes: Record<string, number> | undefined;
  if (result.faceBlendshapes && result.faceBlendshapes.length > 0) {
    blendshapes = {};
    for (const cat of result.faceBlendshapes[0].categories) {
      blendshapes[cat.categoryName] = cat.score;
    }
  }

  // Yaw 用 landmark 幾何計算（與測試工具一致，比 rotation matrix 更穩定）
  // yaw = (nose.x - eyeMidX) / eyeSpan
  const leX = (landmarks[33].x + landmarks[133].x) / 2;
  const reX = (landmarks[263].x + landmarks[362].x) / 2;
  const eyeMidX = (leX + reX) / 2;
  const eyeSpan = Math.abs(reX - leX);
  const yaw = eyeSpan > 0.01
    ? (landmarks[1].x - eyeMidX) / eyeSpan
    : 0;

  return { landmarks, matrix, yaw, blendshapes };
}

// ============================================================================
// Geometry Extraction
// ============================================================================

/**
 * MediaPipe Face Mesh 468 landmark 索引
 * @see https://github.com/google/mediapipe/blob/master/mediapipe/modules/face_geometry/data/canonical_face_model_uv_visualization.png
 */
const LANDMARK = {
  // 左眼（從觀察者角度）
  LEFT_EYE_TOP: 159,
  LEFT_EYE_BOTTOM: 145,
  LEFT_EYE_INNER: 133,
  LEFT_EYE_OUTER: 33,
  // 右眼
  RIGHT_EYE_TOP: 386,
  RIGHT_EYE_BOTTOM: 374,
  RIGHT_EYE_INNER: 362,
  RIGHT_EYE_OUTER: 263,
  // 嘴巴
  MOUTH_LEFT: 61,
  MOUTH_RIGHT: 291,
  MOUTH_TOP: 13,
  MOUTH_BOTTOM: 14,
  // 鼻子
  NOSE_TIP: 1,
  // 臉部邊界
  FACE_LEFT: 234,
  FACE_RIGHT: 454,
  FACE_TOP: 10,
  FACE_BOTTOM: 152,
} as const;

/**
 * 計算 Eye Aspect Ratio (EAR)
 *
 * EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)
 * 正常睜眼 ~0.25-0.35，閉眼 <0.2
 */
function computeEAR(
  top: FaceLandmark,
  bottom: FaceLandmark,
  inner: FaceLandmark,
  outer: FaceLandmark
): number {
  const vertical = Math.sqrt(
    Math.pow(top.x - bottom.x, 2) + Math.pow(top.y - bottom.y, 2)
  );
  const horizontal = Math.sqrt(
    Math.pow(inner.x - outer.x, 2) + Math.pow(inner.y - outer.y, 2)
  );
  if (horizontal === 0) return 0;
  return vertical / horizontal;
}

/**
 * 從 468 landmarks 提取臉部幾何測量
 */
export function extractFaceGeometry(landmarks: FaceLandmark[]): FaceGeometry {
  // Eye Aspect Ratio
  const leftEAR = computeEAR(
    landmarks[LANDMARK.LEFT_EYE_TOP],
    landmarks[LANDMARK.LEFT_EYE_BOTTOM],
    landmarks[LANDMARK.LEFT_EYE_INNER],
    landmarks[LANDMARK.LEFT_EYE_OUTER]
  );
  const rightEAR = computeEAR(
    landmarks[LANDMARK.RIGHT_EYE_TOP],
    landmarks[LANDMARK.RIGHT_EYE_BOTTOM],
    landmarks[LANDMARK.RIGHT_EYE_INNER],
    landmarks[LANDMARK.RIGHT_EYE_OUTER]
  );

  // 嘴角寬度（正規化，除以臉部寬度）
  const faceWidth = Math.abs(
    landmarks[LANDMARK.FACE_RIGHT].x - landmarks[LANDMARK.FACE_LEFT].x
  );
  const mouthW = Math.abs(
    landmarks[LANDMARK.MOUTH_RIGHT].x - landmarks[LANDMARK.MOUTH_LEFT].x
  );
  const mouthWidth = faceWidth > 0 ? mouthW / faceWidth : 0;

  // 鼻子 X 偏移（正規化：0 = 正面，正 = 向右轉）
  const faceCenterX =
    (landmarks[LANDMARK.FACE_LEFT].x + landmarks[LANDMARK.FACE_RIGHT].x) / 2;
  const noseOffsetX = faceWidth > 0
    ? (landmarks[LANDMARK.NOSE_TIP].x - faceCenterX) / faceWidth
    : 0;

  // 臉部邊界框
  const minX = landmarks[LANDMARK.FACE_LEFT].x;
  const maxX = landmarks[LANDMARK.FACE_RIGHT].x;
  const minY = landmarks[LANDMARK.FACE_TOP].y;
  const maxY = landmarks[LANDMARK.FACE_BOTTOM].y;

  return {
    leftEAR,
    rightEAR,
    mouthWidth,
    noseOffsetX,
    boundingBox: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    },
  };
}

// ============================================================================
// Cleanup
// ============================================================================

/** 釋放 FaceLandmarker 資源 */
export function closeFaceLandmarker(): void {
  if (landmarkerInstance) {
    landmarkerInstance.close();
    landmarkerInstance = null;
    initPromise = null;
    devLog('[FaceMesh] Closed');
  }
}
