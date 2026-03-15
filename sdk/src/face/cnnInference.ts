/**
 * Phase 26b: CNN Inference Service
 *
 * 雙模型 ONNX 推論：
 * 1. MobileFaceNet (w600k_mbf) — 臉部 512 維 CNN embedding
 * 2. MiniFASNetV2SE — 照片/面具/螢幕防偽偵測
 *
 * 使用 onnxruntime-web WASM 後端，懶載入 + Service Worker 快取
 */

import { devLog, devWarn } from '../utils/devLog';
import { CNN_EMBEDDING_DIM } from './types';
import type { BoundingBox, SpoofDetectionResult } from './types';

// ============================================================================
// Types (internal)
// ============================================================================

interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
}

interface OrtTensor {
  data: Float32Array | Int32Array | Uint8Array;
  dims: readonly number[];
  dispose(): void;
}

// Lazy-imported ORT module
type OrtModule = typeof import('onnxruntime-web');

// ============================================================================
// State
// ============================================================================

let ortModule: OrtModule | null = null;
let faceSession: OrtSession | null = null;
let spoofSession: OrtSession | null = null;
let isInitializing = false;
let initPromise: Promise<void> | null = null;

// Shared canvas for image preprocessing
let preprocessCanvas: OffscreenCanvas | null = null;
let preprocessCtx: OffscreenCanvasRenderingContext2D | null = null;

// ============================================================================
// Constants
// ============================================================================

const FACE_MODEL_PATH = '/models/face_recognition.onnx';
const SPOOF_MODEL_PATH = '/models/anti_spoof.onnx';

/** MobileFaceNet 輸入尺寸 */
const FACE_INPUT_SIZE = 112;
/** MiniFASNetV2SE 輸入尺寸 */
const SPOOF_INPUT_SIZE = 128;

/** MobileFaceNet 輸入 tensor name */
const FACE_INPUT_NAME = 'input.1';
/** MiniFASNetV2SE 輸入 tensor name */
const SPOOF_INPUT_NAME = 'input';

/** MobileFaceNet 預期輸出維度 */
const EXPECTED_FACE_DIM = CNN_EMBEDDING_DIM; // 512

// ============================================================================
// Initialization
// ============================================================================

/**
 * 懶載入 ONNX Runtime + 雙模型
 *
 * 並行載入兩個模型，總計 ~14MB（首次下載，之後 Service Worker 快取）
 */
export async function initCnnModels(): Promise<void> {
  if (faceSession && spoofSession) return;
  if (initPromise) return initPromise;

  isInitializing = true;

  initPromise = (async () => {
    try {
      const startTime = Date.now();
      devLog('[CNN] Initializing ONNX Runtime + models...');

      // 動態載入 onnxruntime-web
      ortModule = await import('onnxruntime-web');

      // 設定 WASM 後端
      ortModule.env.wasm.numThreads = 1;

      // 並行載入兩個模型
      const [face, spoof] = await Promise.all([
        ortModule.InferenceSession.create(FACE_MODEL_PATH, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        }),
        ortModule.InferenceSession.create(SPOOF_MODEL_PATH, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        }),
      ]);

      faceSession = face as unknown as OrtSession;
      spoofSession = spoof as unknown as OrtSession;

      // 初始化 preprocessing canvas
      preprocessCanvas = new OffscreenCanvas(SPOOF_INPUT_SIZE, SPOOF_INPUT_SIZE);
      preprocessCtx = preprocessCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;

      const elapsed = Date.now() - startTime;
      devLog(`[CNN] Initialized in ${elapsed}ms`);
    } catch (err) {
      devWarn('[CNN] Initialization failed:', err);
      initPromise = null;
      throw err;
    } finally {
      isInitializing = false;
    }
  })();

  return initPromise;
}

/** CNN 模型是否已就緒 */
export function isCnnReady(): boolean {
  return faceSession !== null && spoofSession !== null;
}

/** CNN 模型是否正在初始化 */
export function isCnnInitializing(): boolean {
  return isInitializing;
}

// ============================================================================
// Image Preprocessing
// ============================================================================

/**
 * 從 video 裁切臉部區域並 resize 到目標尺寸
 *
 * @param video HTMLVideoElement
 * @param faceBox 正規化座標的臉部邊界框 (0-1)
 * @param targetSize 目標尺寸（正方形）
 * @returns CHW 格式的 Float32Array [3, H, W]，BGR 色彩空間，[0,1] 正規化
 */
function cropAndPreprocess(
  video: HTMLVideoElement,
  faceBox: BoundingBox,
  targetSize: number
): Float32Array {
  if (!preprocessCanvas || !preprocessCtx) {
    throw new Error('Preprocessing canvas not initialized');
  }

  const vw = video.videoWidth;
  const vh = video.videoHeight;

  // 將正規化座標轉換為像素座標
  const sx = Math.max(0, Math.floor(faceBox.x * vw));
  const sy = Math.max(0, Math.floor(faceBox.y * vh));
  const sw = Math.min(Math.ceil(faceBox.width * vw), vw - sx);
  const sh = Math.min(Math.ceil(faceBox.height * vh), vh - sy);

  // Resize canvas 到目標尺寸
  preprocessCanvas.width = targetSize;
  preprocessCanvas.height = targetSize;

  // 裁切 + resize
  preprocessCtx.drawImage(video, sx, sy, sw, sh, 0, 0, targetSize, targetSize);

  // 取得像素資料
  const imageData = preprocessCtx.getImageData(0, 0, targetSize, targetSize);
  const pixels = imageData.data; // RGBA

  // 轉換為 CHW 格式 [3, H, W]，BGR 色彩空間，[0,1] 正規化
  const chw = new Float32Array(3 * targetSize * targetSize);
  const hw = targetSize * targetSize;

  for (let i = 0; i < hw; i++) {
    const rgbaIdx = i * 4;
    // BGR 順序（InsightFace 使用 BGR）
    chw[0 * hw + i] = pixels[rgbaIdx + 2] / 255.0; // B
    chw[1 * hw + i] = pixels[rgbaIdx + 1] / 255.0; // G
    chw[2 * hw + i] = pixels[rgbaIdx + 0] / 255.0; // R
  }

  return chw;
}

// ============================================================================
// Face Embedding (MobileFaceNet)
// ============================================================================

/**
 * 從 video 的臉部區域提取 CNN embedding
 *
 * 使用 MobileFaceNet (w600k_mbf)：
 * - 輸入：112×112 BGR，CHW 格式
 * - 輸出：512 維 L2 正規化 embedding
 * - 推論時間：~15-25ms (WASM)
 *
 * @returns 512 維 Float32Array，L2 正規化
 */
export async function extractCnnEmbedding(
  video: HTMLVideoElement,
  faceBox: BoundingBox
): Promise<Float32Array> {
  if (!faceSession || !ortModule) {
    throw new Error('CNN face model not initialized');
  }

  // 裁切 + 預處理
  const inputData = cropAndPreprocess(video, faceBox, FACE_INPUT_SIZE);

  // 建立 tensor [1, 3, 112, 112]
  const inputTensor = new ortModule.Tensor('float32', inputData, [1, 3, FACE_INPUT_SIZE, FACE_INPUT_SIZE]);

  let results: Record<string, OrtTensor> | null = null;
  try {
    // 推論
    results = await (faceSession as unknown as OrtSession).run({
      [FACE_INPUT_NAME]: inputTensor as unknown as OrtTensor,
    });

    // 取得輸出（期望 512 維）
    const outputKey = Object.keys(results)[0];
    const outputData = results[outputKey].data as Float32Array;

    if (outputData.length !== EXPECTED_FACE_DIM) {
      devWarn('[CNN] Unexpected face embedding dim:', outputData.length, 'expected:', EXPECTED_FACE_DIM);
    }

    // L2 正規化
    const embedding = new Float32Array(outputData.length);
    let norm = 0;
    for (let i = 0; i < outputData.length; i++) {
      norm += outputData[i] * outputData[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < outputData.length; i++) {
        embedding[i] = outputData[i] / norm;
      }
    } else {
      embedding.set(outputData);
    }

    return embedding;
  } finally {
    // 確保 tensor 無論成功或失敗都被釋放
    inputTensor.dispose();
    if (results) {
      const outputKey = Object.keys(results)[0];
      if (outputKey) results[outputKey].dispose();
    }
  }
}

// ============================================================================
// Anti-Spoof Detection (MiniFASNetV2SE)
// ============================================================================

/**
 * 從 video 的臉部區域偵測防偽
 *
 * 使用 MiniFASNetV2SE：
 * - 輸入：128×128 RGB，CHW 格式
 * - 輸出：[real_score, spoof_score]
 * - 推論時間：~10-15ms (WASM)
 * - 準確率：98.2%
 *
 * @returns { isReal, confidence }
 */
export async function detectSpoof(
  video: HTMLVideoElement,
  faceBox: BoundingBox
): Promise<SpoofDetectionResult> {
  if (!spoofSession || !ortModule) {
    throw new Error('CNN anti-spoof model not initialized');
  }

  // 裁切 + 預處理（anti-spoof 用 RGB）
  const inputData = cropAndPreprocessRGB(video, faceBox, SPOOF_INPUT_SIZE);

  // 建立 tensor [1, 3, 128, 128]
  const inputTensor = new ortModule.Tensor('float32', inputData, [1, 3, SPOOF_INPUT_SIZE, SPOOF_INPUT_SIZE]);

  let results: Record<string, OrtTensor> | null = null;
  try {
    // 推論
    results = await (spoofSession as unknown as OrtSession).run({
      [SPOOF_INPUT_NAME]: inputTensor as unknown as OrtTensor,
    });

    // 取得輸出 [real_score, spoof_score]
    const outputKey = Object.keys(results)[0];
    const outputData = results[outputKey].data as Float32Array;

    // 數值穩定的 Softmax（減去最大值避免 exp overflow）
    const maxVal = Math.max(outputData[0], outputData[1]);
    const expReal = Math.exp(outputData[0] - maxVal);
    const expSpoof = Math.exp(outputData[1] - maxVal);
    const sumExp = expReal + expSpoof;
    const realProb = expReal / sumExp;

    return {
      isReal: realProb > 0.5,
      confidence: realProb,
    };
  } finally {
    // 確保 tensor 無論成功或失敗都被釋放
    inputTensor.dispose();
    if (results) {
      const outputKey = Object.keys(results)[0];
      if (outputKey) results[outputKey].dispose();
    }
  }
}

/**
 * RGB 版預處理（anti-spoof 模型使用 RGB 而非 BGR）
 */
function cropAndPreprocessRGB(
  video: HTMLVideoElement,
  faceBox: BoundingBox,
  targetSize: number
): Float32Array {
  if (!preprocessCanvas || !preprocessCtx) {
    throw new Error('Preprocessing canvas not initialized');
  }

  const vw = video.videoWidth;
  const vh = video.videoHeight;

  const sx = Math.max(0, Math.floor(faceBox.x * vw));
  const sy = Math.max(0, Math.floor(faceBox.y * vh));
  const sw = Math.min(Math.ceil(faceBox.width * vw), vw - sx);
  const sh = Math.min(Math.ceil(faceBox.height * vh), vh - sy);

  preprocessCanvas.width = targetSize;
  preprocessCanvas.height = targetSize;
  preprocessCtx.drawImage(video, sx, sy, sw, sh, 0, 0, targetSize, targetSize);

  const imageData = preprocessCtx.getImageData(0, 0, targetSize, targetSize);
  const pixels = imageData.data;

  // RGB 順序，[0,1] 正規化
  const chw = new Float32Array(3 * targetSize * targetSize);
  const hw = targetSize * targetSize;

  for (let i = 0; i < hw; i++) {
    const rgbaIdx = i * 4;
    chw[0 * hw + i] = pixels[rgbaIdx + 0] / 255.0; // R
    chw[1 * hw + i] = pixels[rgbaIdx + 1] / 255.0; // G
    chw[2 * hw + i] = pixels[rgbaIdx + 2] / 255.0; // B
  }

  return chw;
}

// ============================================================================
// Cleanup
// ============================================================================

/** 釋放 CNN 模型資源 */
export async function closeCnnModels(): Promise<void> {
  if (faceSession) {
    await faceSession.release();
    faceSession = null;
  }
  if (spoofSession) {
    await spoofSession.release();
    spoofSession = null;
  }
  preprocessCanvas = null;
  preprocessCtx = null;
  initPromise = null;
  devLog('[CNN] Models closed');
}
