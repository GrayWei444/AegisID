/**
 * MediaPipe-based Anti-Spoof Service
 *
 * 取代 ONNX Runtime (25MB) + MiniFASNet，改用 MediaPipe landmarks 已有的資料：
 * 1. Z-depth 平坦度 — 照片/螢幕的 z 值幾乎沒有變異
 * 2. 微動熵 — 真人 landmarks 有生理性微顫，照片異常穩定
 * 3. 遮擋偵測 — 口罩/帽子導致 landmark 缺失或異常
 *
 * 不需要額外模型，零額外記憶體。
 */

import type { BoundingBox, SpoofDetectionResult, FaceLandmark } from './types';

// ============================================================================
// State — 收集多幀 landmark 用於時序分析
// ============================================================================

interface FrameSnapshot {
  landmarks: FaceLandmark[];
  timestamp: number;
}

const frameHistory: FrameSnapshot[] = [];
const MAX_HISTORY = 30; // 約 3 秒（100ms 間隔）

// 遮擋偵測結果
export interface OcclusionResult {
  hasMask: boolean;   // 口罩（下巴/嘴巴 landmarks 異常）
}

let lastOcclusion: OcclusionResult = { hasMask: false };

// ============================================================================
// Key Landmark Indices (MediaPipe 478 face mesh)
// ============================================================================

// 鼻樑（z 值最突出）
const NOSE_BRIDGE = [6, 197, 195, 5, 4];
// 臉頰（z 值中等）
const CHEEKS = [123, 352, 50, 280];
// 下巴
const CHIN = [152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234];
// 嘴唇區域
const MOUTH = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];

// ============================================================================
// Z-Depth Flatness Detection
// ============================================================================

/**
 * 計算 z-depth 變異係數
 * 真人臉部有明顯的凹凸（鼻子突出、眼窩凹陷）
 * 照片/螢幕的 z 值幾乎平的
 */
function computeZDepthScore(landmarks: FaceLandmark[]): number {
  // 取關鍵部位的 z 值
  const zValues: number[] = [];
  for (const idx of [...NOSE_BRIDGE, ...CHEEKS, ...CHIN]) {
    if (landmarks[idx]) {
      zValues.push(landmarks[idx].z);
    }
  }
  if (zValues.length < 5) return 0;

  const mean = zValues.reduce((s, v) => s + v, 0) / zValues.length;
  const variance = zValues.reduce((s, v) => s + (v - mean) ** 2, 0) / zValues.length;
  const stdDev = Math.sqrt(variance);

  // 真人 z stdDev 通常 > 0.02，照片 < 0.005
  // 正規化到 0-1 分數（越高越像真人）
  const score = Math.min(stdDev / 0.03, 1.0);
  return score;
}

// ============================================================================
// Micro-Movement Entropy
// ============================================================================

/**
 * 計算 landmark 微動熵
 * 真人有生理性微顫（呼吸、肌肉張力），照片完全靜止
 */
function computeMicroMovementScore(): number {
  if (frameHistory.length < 10) return 0.5; // 資料不足，中性分數

  // 取最近 10 幀
  const recent = frameHistory.slice(-10);

  // 選幾個穩定的 landmarks 測量微動
  const trackPoints = [1, 4, 6, 10, 152]; // 鼻尖、鼻根、額頭中、下巴

  let totalVariance = 0;
  let count = 0;

  for (const idx of trackPoints) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const frame of recent) {
      if (frame.landmarks[idx]) {
        xs.push(frame.landmarks[idx].x);
        ys.push(frame.landmarks[idx].y);
      }
    }
    if (xs.length < 5) continue;

    const meanX = xs.reduce((s, v) => s + v, 0) / xs.length;
    const meanY = ys.reduce((s, v) => s + v, 0) / ys.length;
    const varX = xs.reduce((s, v) => s + (v - meanX) ** 2, 0) / xs.length;
    const varY = ys.reduce((s, v) => s + (v - meanY) ** 2, 0) / ys.length;
    totalVariance += varX + varY;
    count++;
  }

  if (count === 0) return 0.5;
  const avgVariance = totalVariance / count;

  // 真人微動 variance 通常 > 1e-6，照片 < 1e-8
  // 正規化到 0-1
  const score = Math.min(avgVariance / 5e-6, 1.0);
  return score;
}

// ============================================================================
// Occlusion Detection — 膚色分析 + Blendshapes
// ============================================================================

/** 離屏 canvas，用於提取嘴巴區域像素 */
let occlusionCanvas: OffscreenCanvas | null = null;
let occlusionCtx: OffscreenCanvasRenderingContext2D | null = null;

/**
 * 方法 1：膚色分析
 * 取嘴巴區域像素 → 計算膚色佔比 → 低於閾值 = 有口罩
 *
 * HSV 膚色範圍（寬鬆）：H 0-50, S 20-255, V 40-255
 */
function checkSkinColorMask(
  video: HTMLVideoElement,
  landmarks: FaceLandmark[],
): { hasMask: boolean; skinRatio: number } {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw === 0 || vh === 0) return { hasMask: false, skinRatio: 1 };

  // 用 landmark 定位嘴巴矩形（像素座標）
  const mouthIndices = [61, 291, 13, 14, 78, 308, 82, 312, 0, 17];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const i of mouthIndices) {
    const lm = landmarks[i];
    if (!lm) continue;
    const px = lm.x * vw;
    const py = lm.y * vh;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }

  // 稍微擴大取樣區域
  const pad = (maxX - minX) * 0.3;
  minX = Math.max(0, minX - pad);
  maxX = Math.min(vw, maxX + pad);
  minY = Math.max(0, minY - pad * 0.5);
  maxY = Math.min(vh, maxY + pad);

  const w = Math.round(maxX - minX);
  const h = Math.round(maxY - minY);
  if (w < 4 || h < 4) return { hasMask: false, skinRatio: 1 };

  // 初始化離屏 canvas
  if (!occlusionCanvas || occlusionCanvas.width !== w || occlusionCanvas.height !== h) {
    occlusionCanvas = new OffscreenCanvas(w, h);
    occlusionCtx = occlusionCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!occlusionCtx) return { hasMask: false, skinRatio: 1 };

  // 從 video 擷取嘴巴區域
  occlusionCtx.drawImage(video, minX, minY, w, h, 0, 0, w, h);
  const imageData = occlusionCtx.getImageData(0, 0, w, h);
  const data = imageData.data;

  // 計算膚色像素佔比（RGB → 簡易膚色判定）
  let skinCount = 0;
  let totalCount = 0;
  // 每隔 2 pixel 取樣加速
  for (let i = 0; i < data.length; i += 8) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    totalCount++;

    // 簡易膚色判定（多規則）
    // Rule 1: RGB 範圍
    if (r > 80 && g > 40 && b > 20 && r > g && r > b && (r - g) > 15 && Math.abs(g - b) < 80) {
      skinCount++;
    }
    // Rule 2: 較亮膚色
    else if (r > 150 && g > 100 && b > 60 && r > g && (r - b) > 30) {
      skinCount++;
    }
  }

  const skinRatio = totalCount > 0 ? skinCount / totalCount : 1;
  // 正常臉：嘴巴區域膚色 > 40%
  // 口罩：膚色 < 25%（口罩是藍/白/黑）
  const hasMask = skinRatio < 0.25;

  return { hasMask, skinRatio };
}

/**
 * 方法 2：Blendshapes 分析
 * 口罩會讓嘴巴相關 blendshapes 異常（值接近 0 或異常穩定）
 */
function checkBlendshapeMask(
  blendshapes: Record<string, number> | undefined,
): { hasMask: boolean; mouthScore: number } {
  if (!blendshapes) return { hasMask: false, mouthScore: -1 };

  // 口罩會抑制嘴巴動作的 blendshapes
  const mouthKeys = [
    'jawOpen',
    'mouthClose',
    'mouthFunnel',
    'mouthPucker',
    'mouthLeft',
    'mouthRight',
    'mouthSmileLeft',
    'mouthSmileRight',
    'mouthFrownLeft',
    'mouthFrownRight',
    'mouthDimpleLeft',
    'mouthDimpleRight',
    'mouthLowerDownLeft',
    'mouthLowerDownRight',
    'mouthUpperUpLeft',
    'mouthUpperUpRight',
    'mouthPressLeft',
    'mouthPressRight',
  ];

  // 計算嘴巴 blendshapes 的平均活躍度
  let sum = 0;
  let count = 0;
  for (const key of mouthKeys) {
    if (key in blendshapes) {
      sum += blendshapes[key];
      count++;
    }
  }

  const mouthScore = count > 0 ? sum / count : -1;
  // 正常說話/表情：mouthScore > 0.02
  // 口罩抑制：全部接近 0（< 0.005）
  const hasMask = mouthScore >= 0 && mouthScore < 0.005;

  return { hasMask, mouthScore };
}

/**
 * 綜合口罩偵測
 * 膚色分析 + blendshapes，任一方法偵測到 = 有口罩
 */
function detectOcclusion(
  landmarks: FaceLandmark[],
  video: HTMLVideoElement | null,
  blendshapes: Record<string, number> | undefined,
): OcclusionResult {
  const skin = video ? checkSkinColorMask(video, landmarks) : { hasMask: false, skinRatio: 1 };
  const blend = checkBlendshapeMask(blendshapes);

  // 任一方法偵測到 = 有口罩
  const hasMask = skin.hasMask || blend.hasMask;

  return { hasMask };
}

// ============================================================================
// Public API — 保持原有介面
// ============================================================================

/** 診斷 log 節流 */
let lastOcclusionLogMs = 0;
/** 上次傳入的 video reference */
let lastVideoRef: HTMLVideoElement | null = null;
/** 上次傳入的 blendshapes */
let lastBlendshapes: Record<string, number> | undefined;

/** 記錄一幀（在 detection loop 中呼叫） */
export function recordFrame(
  landmarks: FaceLandmark[],
  video?: HTMLVideoElement | null,
  blendshapes?: Record<string, number>,
): void {
  frameHistory.push({ landmarks, timestamp: performance.now() });
  if (frameHistory.length > MAX_HISTORY) {
    frameHistory.shift();
  }

  // 保存 video/blendshapes reference
  if (video) lastVideoRef = video;
  if (blendshapes) lastBlendshapes = blendshapes;

  // 更新遮擋偵測
  lastOcclusion = detectOcclusion(landmarks, lastVideoRef, lastBlendshapes);

  // 每 3 秒輸出一次診斷
  const now = performance.now();
  if (now - lastOcclusionLogMs > 3000) {
    lastOcclusionLogMs = now;
    const skin = lastVideoRef ? checkSkinColorMask(lastVideoRef, landmarks) : { skinRatio: -1 };
    const blend = checkBlendshapeMask(lastBlendshapes);
    console.error(
      `[DIAG:OCCLUSION] mask=${lastOcclusion.hasMask}` +
      ` skinRatio=${skin.skinRatio.toFixed(3)}` +
      ` mouthBlend=${blend.mouthScore.toFixed(4)}`
    );
  }
}

/** 取得最新遮擋偵測結果 */
export function getOcclusionResult(): OcclusionResult {
  return lastOcclusion;
}

/** 初始化 — no-op（不需要載入模型） */
export async function initAntiSpoofModel(): Promise<void> { /* MediaPipe-based, no model to load */ }
export const initCnnModels = initAntiSpoofModel;

/** 始終回傳 true — MediaPipe landmarks 就是資料來源 */
export function isAntiSpoofReady(): boolean { return true; }
export const isCnnReady = isAntiSpoofReady;

export function isAntiSpoofInitializing(): boolean { return false; }
export const isCnnInitializing = isAntiSpoofInitializing;

export function isAntiSpoofFailed(): boolean { return false; }
export const isCnnFailed = isAntiSpoofFailed;

export function resetBboxSmoothing(): void {
  frameHistory.length = 0;
  lastOcclusion = { hasMask: false };
}

/**
 * MediaPipe-based 防偽偵測
 * 使用 z-depth 平坦度 + 微動熵，取代 ONNX Runtime CNN
 */
export async function detectSpoof(
  _video: HTMLVideoElement,
  _faceBox: BoundingBox
): Promise<SpoofDetectionResult> {
  // 從已記錄的幀計算
  if (frameHistory.length === 0) {
    return { isReal: true, confidence: 0.5 };
  }

  const latestLandmarks = frameHistory[frameHistory.length - 1].landmarks;

  const zScore = computeZDepthScore(latestLandmarks);
  const moveScore = computeMicroMovementScore();

  // 綜合分數：z-depth 60% + 微動 40%
  const confidence = zScore * 0.6 + moveScore * 0.4;

  return {
    isReal: confidence > 0.3,
    confidence,
  };
}

export async function closeAntiSpoofModel(): Promise<void> {
  frameHistory.length = 0;
}
export const closeCnnModels = closeAntiSpoofModel;
