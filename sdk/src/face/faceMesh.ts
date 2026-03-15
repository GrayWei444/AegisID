/**
 * Phase 26: MediaPipe Face Landmarker Wrapper
 *
 * 使用 @mediapipe/tasks-vision 的 FaceLandmarker 偵測 468 個臉部 landmarks
 * 並從中提取幾何測量值（EAR、嘴角距離、鼻子偏移）用於活體偵測
 */

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { devLog } from '../utils/devLog';
import type { FaceLandmark, FaceGeometry } from './types';

// ============================================================================
// Singleton Instance
// ============================================================================

let landmarkerInstance: FaceLandmarker | null = null;
let isInitializing = false;
let initPromise: Promise<FaceLandmarker> | null = null;

/**
 * 初始化 FaceLandmarker（lazy-load，首次使用時載入模型）
 *
 * 使用 CDN 載入 WASM + 模型檔案，大小約 2-3MB
 * Service Worker 會自動快取，後續載入更快
 */
export async function initFaceLandmarker(): Promise<FaceLandmarker> {
  if (landmarkerInstance) return landmarkerInstance;
  if (initPromise) return initPromise;

  isInitializing = true;

  initPromise = (async () => {
    try {
      devLog('[FaceMesh] Initializing FaceLandmarker...');
      const startTime = Date.now();

      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
      );

      landmarkerInstance = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });

      const elapsed = Date.now() - startTime;
      devLog(`[FaceMesh] Initialized in ${elapsed}ms`);

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

// ============================================================================
// Face Detection
// ============================================================================

/**
 * 從 video frame 偵測臉部 landmarks
 *
 * @returns 468 個 landmark 座標，或 null（未偵測到人臉）
 */
export function detectFace(
  video: HTMLVideoElement,
  timestampMs: number
): FaceLandmark[] | null {
  if (!landmarkerInstance) return null;

  const result = landmarkerInstance.detectForVideo(video, timestampMs);

  if (!result.faceLandmarks || result.faceLandmarks.length === 0) {
    return null;
  }

  // 取第一個偵測到的人臉
  return result.faceLandmarks[0] as FaceLandmark[];
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
