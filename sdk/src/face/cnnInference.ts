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
import type { BoundingBox, FaceLandmark, SpoofDetectionResult } from './types';

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
let cnnInitFailed = false;
let cnnInitAttempts = 0;
const CNN_MAX_RETRIES = 3;

// Separate canvases for face embedding and anti-spoof preprocessing
// (avoid shared canvas resize 112↔128 causing GPU-backed pixel corruption)
let faceCanvas: OffscreenCanvas | null = null;
let faceCtx: OffscreenCanvasRenderingContext2D | null = null;
let spoofCanvas: OffscreenCanvas | null = null;
let spoofCtx: OffscreenCanvasRenderingContext2D | null = null;

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

/**
 * InsightFace ArcFace 標準對齊參考點（112×112 目標空間）
 *
 * 5 點：左眼中心、右眼中心、鼻尖、左嘴角、右嘴角
 * 來源：insightface/python-package/insightface/utils/face_align.py
 */
const ARCFACE_REF_LANDMARKS: readonly [number, number][] = [
  [38.2946, 51.6963],   // left_eye
  [73.5318, 51.5014],   // right_eye
  [56.0252, 71.7366],   // nose_tip
  [41.5493, 92.3655],   // left_mouth_corner
  [70.7299, 92.2041],   // right_mouth_corner
];

/**
 * MediaPipe 468-landmark 中對應 ArcFace 5 點的索引
 * 眼睛用外角+內角的中點作為眼中心
 */
const MP_LEFT_EYE_OUTER = 33;
const MP_LEFT_EYE_INNER = 133;
const MP_RIGHT_EYE_OUTER = 263;
const MP_RIGHT_EYE_INNER = 362;
const MP_NOSE_TIP = 1;
const MP_LEFT_MOUTH = 61;
const MP_RIGHT_MOUTH = 291;

// ============================================================================
// Initialization
// ============================================================================

/**
 * iOS Safari/WKWebView 記憶體修正
 *
 * ORT v1.24.3 JS glue 在 module import 時建立：
 *   WebAssembly.Memory({initial:256, maximum:65536, shared:true})
 * = 4GB 虛擬位址空間。Safari 會預先保留 maximum → iPhone ≤4GB RAM 直接 OOM。
 *
 * 解法：import ORT 前 monkey-patch WebAssembly.Memory，限制 maximum。
 * 我們的模型只需 ~50-100MB（14MB 模型 + ORT runtime），256MB 上限綽綽有餘。
 */
const IOS_WASM_MAX_PAGES = 4096; // 4096 × 64KB = 256MB

function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iP(hone|od|ad)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

type MemoryDescriptor = { initial: number; maximum?: number; shared?: boolean };

function patchWasmMemoryForIOS(): typeof WebAssembly.Memory | null {
  if (!isIOSDevice()) return null;

  const OrigMemory = WebAssembly.Memory;
  const patchedCtor = function PatchedMemory(
    this: WebAssembly.Memory,
    desc: MemoryDescriptor
  ): WebAssembly.Memory {
    // Cap maximum at 256MB (was 4GB)
    const patched: MemoryDescriptor = desc.maximum && desc.maximum > IOS_WASM_MAX_PAGES
      ? { ...desc, maximum: IOS_WASM_MAX_PAGES }
      : { ...desc };

    try {
      return new OrigMemory(patched);
    } catch (err) {
      // SharedArrayBuffer unavailable (no COOP/COEP headers) → non-shared fallback
      if (patched.shared) {
        devLog('[CNN] Shared memory failed, trying non-shared');
        const { shared: _, ...nonSharedDesc } = patched;
        return new OrigMemory(nonSharedDesc as MemoryDescriptor);
      }
      throw err;
    }
  } as unknown as typeof WebAssembly.Memory;

  // Preserve prototype chain
  patchedCtor.prototype = OrigMemory.prototype;
  (WebAssembly as { Memory: typeof WebAssembly.Memory }).Memory = patchedCtor;

  devLog(`[CNN] iOS: patched WebAssembly.Memory maximum=${IOS_WASM_MAX_PAGES} (${IOS_WASM_MAX_PAGES * 64 / 1024}MB)`);
  return OrigMemory;
}

function restoreWasmMemory(orig: typeof WebAssembly.Memory | null): void {
  if (orig) {
    (WebAssembly as { Memory: typeof WebAssembly.Memory }).Memory = orig;
    devLog('[CNN] iOS: restored original WebAssembly.Memory');
  }
}

/**
 * 判斷是否為暫時性錯誤（fetch 失敗、SW 快取未就緒等）
 * 只有 OOM 是永久性失敗
 */
function isTransientError(err: unknown): boolean {
  const msg = String(err);
  // OOM 是永久性的 — 這台裝置記憶體不夠
  if (msg.includes('Out of memory') || msg.includes('RangeError')) return false;
  // Fetch 失敗、MIME type 錯誤、WASM compile 失敗 — 暫時性，SW 快取就緒後可能成功
  return true;
}

export async function initCnnModels(): Promise<void> {
  if (faceSession && spoofSession) return;
  if (initPromise) return initPromise;
  // 已確認永久性失敗（如 OOM），不再重試
  if (cnnInitFailed) return;

  isInitializing = true;
  cnnInitAttempts++;

  initPromise = (async () => {
    // iOS 記憶體修正：必須在 import ORT 之前 patch（ORT 在 module 載入時建立 Memory）
    const origMemory = patchWasmMemoryForIOS();

    try {
      const startTime = Date.now();
      devLog(`[CNN] Initializing ONNX Runtime + models... (attempt ${cnnInitAttempts}/${CNN_MAX_RETRIES})`);

      // 動態載入 onnxruntime-web（此時 WebAssembly.Memory 已被 patch）
      if (!ortModule) {
        ortModule = await import('onnxruntime-web');

        // 設定 WASM 後端 — 禁用 threads（iOS WKWebView 不穩定）
        // wasmPaths 指向 /wasm/ 避免 Vite hash 造成 ORT 找不到檔案
        ortModule.env.wasm.numThreads = 1;
        ortModule.env.wasm.wasmPaths = '/wasm/';
      }

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

      // 初始化 preprocessing canvases（各自獨立，避免 resize 導致 GPU 像素污染）
      faceCanvas = new OffscreenCanvas(FACE_INPUT_SIZE, FACE_INPUT_SIZE);
      faceCtx = faceCanvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
      spoofCanvas = new OffscreenCanvas(SPOOF_INPUT_SIZE, SPOOF_INPUT_SIZE);
      spoofCtx = spoofCanvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;

      const elapsed = Date.now() - startTime;
      devLog(`[CNN] Initialized in ${elapsed}ms (attempt ${cnnInitAttempts})`);
    } catch (err) {
      devWarn(`[CNN] Initialization failed (attempt ${cnnInitAttempts}):`, err);
      initPromise = null;

      if (!isTransientError(err) || cnnInitAttempts >= CNN_MAX_RETRIES) {
        // 永久性失敗 或 重試次數用完
        cnnInitFailed = true;
        devWarn(`[CNN] Permanently failed after ${cnnInitAttempts} attempts`);
      }
      // 暫時性失敗且還有重試次數 → 不設 cnnInitFailed，讓下次呼叫可以重試

      throw err;
    } finally {
      isInitializing = false;
      restoreWasmMemory(origMemory);
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

/** CNN 模型初始化是否已失敗（如 iOS OOM） */
export function isCnnFailed(): boolean {
  return cnnInitFailed;
}

// ============================================================================
// Face Alignment (ArcFace 標準 5 點對齊)
// ============================================================================

/**
 * 從 MediaPipe 468 landmarks 提取 ArcFace 5 點（像素座標）
 */
function extractAlignmentPoints(
  landmarks: FaceLandmark[],
  videoWidth: number,
  videoHeight: number
): [number, number][] {
  // 眼中心 = 外角和內角的中點
  const leftEye: [number, number] = [
    ((landmarks[MP_LEFT_EYE_OUTER].x + landmarks[MP_LEFT_EYE_INNER].x) / 2) * videoWidth,
    ((landmarks[MP_LEFT_EYE_OUTER].y + landmarks[MP_LEFT_EYE_INNER].y) / 2) * videoHeight,
  ];
  const rightEye: [number, number] = [
    ((landmarks[MP_RIGHT_EYE_OUTER].x + landmarks[MP_RIGHT_EYE_INNER].x) / 2) * videoWidth,
    ((landmarks[MP_RIGHT_EYE_OUTER].y + landmarks[MP_RIGHT_EYE_INNER].y) / 2) * videoHeight,
  ];
  const nose: [number, number] = [
    landmarks[MP_NOSE_TIP].x * videoWidth,
    landmarks[MP_NOSE_TIP].y * videoHeight,
  ];
  const leftMouth: [number, number] = [
    landmarks[MP_LEFT_MOUTH].x * videoWidth,
    landmarks[MP_LEFT_MOUTH].y * videoHeight,
  ];
  const rightMouth: [number, number] = [
    landmarks[MP_RIGHT_MOUTH].x * videoWidth,
    landmarks[MP_RIGHT_MOUTH].y * videoHeight,
  ];

  return [leftEye, rightEye, nose, leftMouth, rightMouth];
}

/**
 * 計算 2D Similarity Transform（5 點 least-squares）
 *
 * 找 a, b, tx, ty 使得：
 *   dst_x = a * src_x - b * src_y + tx
 *   dst_y = b * src_x + a * src_y + ty
 *
 * 閉合公式（不需要 SVD 或外部函式庫）：
 *   A^T A = [[S2, 0, Sx, Sy], [0, S2, -Sy, Sx], [Sx, -Sy, N, 0], [Sy, Sx, 0, N]]
 *   解耦後直接求解 a, b, tx, ty
 */
function computeSimilarityTransform(
  src: readonly [number, number][],
  dst: readonly [number, number][]
): { a: number; b: number; tx: number; ty: number } {
  const N = src.length;

  let S2 = 0, Sx = 0, Sy = 0;
  let rhsA = 0, rhsB = 0, rhsE = 0, rhsF = 0;

  for (let i = 0; i < N; i++) {
    const sx = src[i][0], sy = src[i][1];
    const dx = dst[i][0], dy = dst[i][1];

    S2 += sx * sx + sy * sy;
    Sx += sx;
    Sy += sy;

    rhsA += sx * dx + sy * dy;
    rhsB += -sy * dx + sx * dy;
    rhsE += dx;
    rhsF += dy;
  }

  const denom = S2 - (Sx * Sx + Sy * Sy) / N;

  if (Math.abs(denom) < 1e-10) {
    // 退化情況（所有點重疊）→ 回傳恆等變換
    return { a: 1, b: 0, tx: 0, ty: 0 };
  }

  const a = (rhsA - (Sx * rhsE + Sy * rhsF) / N) / denom;
  const b = (rhsB - (-Sy * rhsE + Sx * rhsF) / N) / denom;
  const tx = (rhsE - Sx * a + Sy * b) / N;
  const ty = (rhsF - Sy * a - Sx * b) / N;

  return { a, b, tx, ty };
}

/**
 * ArcFace 標準對齊裁切：使用 5 點 similarity transform 將臉部對齊到 112×112
 *
 * 比 bounding box 裁切更穩定：
 * - 修正頭部傾斜（旋轉）
 * - 修正臉部位移（平移）
 * - 修正距離差異（縮放）
 * - 同一人在不同角度/位置應得到相似的 aligned crop
 *
 * @returns CHW 格式的 Float32Array [3, 112, 112]，RGB [-1,+1]
 */
function cropAndPreprocessAligned(
  video: HTMLVideoElement,
  landmarks: FaceLandmark[],
  targetSize: number
): Float32Array {
  if (!faceCanvas || !faceCtx) {
    throw new Error('Face preprocessing canvas not initialized');
  }

  const vw = video.videoWidth;
  const vh = video.videoHeight;

  // 提取 5 點（像素座標）並計算 similarity transform
  const srcPoints = extractAlignmentPoints(landmarks, vw, vh);
  const { a, b, tx, ty } = computeSimilarityTransform(srcPoints, ARCFACE_REF_LANDMARKS);

  // 應用 transform：video coords → 112×112 aligned coords
  faceCtx.clearRect(0, 0, targetSize, targetSize);
  faceCtx.setTransform(a, b, -b, a, tx, ty);
  faceCtx.drawImage(video, 0, 0);
  faceCtx.resetTransform();

  // 讀取像素
  const imageData = faceCtx.getImageData(0, 0, targetSize, targetSize);
  const pixels = imageData.data;

  // Hair/Hat Mask: 消除帽子/頭髮對 embedding 的影響
  // 根據 debug crop 實際觀察：帽子佔 y=0~30，眉毛在 y≈42
  // 對上方做 soft fade to neutral gray (127.5 → 0.0 in normalized space)
  // 註冊和驗證都套用同樣 mask，確保比較公平
  const MASK_FULL = 25;      // y < 25: 完全遮罩
  const MASK_FADE_END = 40;  // y 25~40: 線性漸變；y >= 40: 原始像素
  const FADE_RANGE = MASK_FADE_END - MASK_FULL;

  for (let y = 0; y < targetSize; y++) {
    if (y >= MASK_FADE_END) break;
    let w: number;
    if (y < MASK_FULL) {
      w = 0.0;
    } else {
      w = (y - MASK_FULL) / FADE_RANGE;
    }
    for (let x = 0; x < targetSize; x++) {
      const idx = (y * targetSize + x) * 4;
      pixels[idx + 0] = Math.round(127.5 + (pixels[idx + 0] - 127.5) * w);
      pixels[idx + 1] = Math.round(127.5 + (pixels[idx + 1] - 127.5) * w);
      pixels[idx + 2] = Math.round(127.5 + (pixels[idx + 2] - 127.5) * w);
    }
  }

  // InsightFace ArcFace 標準預處理：RGB, (pixel - 127.5) / 127.5 → [-1, +1]
  const chw = new Float32Array(3 * targetSize * targetSize);
  const hw = targetSize * targetSize;

  for (let i = 0; i < hw; i++) {
    const rgbaIdx = i * 4;
    chw[0 * hw + i] = (pixels[rgbaIdx + 0] - 127.5) / 127.5; // R
    chw[1 * hw + i] = (pixels[rgbaIdx + 1] - 127.5) / 127.5; // G
    chw[2 * hw + i] = (pixels[rgbaIdx + 2] - 127.5) / 127.5; // B
  }

  return chw;
}

// ============================================================================
// Bounding Box Preprocessing (fallback + anti-spoof)
// ============================================================================

// Bounding box 時序平滑（減少 MediaPipe landmark 逐幀抖動）
let lastFaceBox: BoundingBox | null = null;

function smoothBoundingBox(newBox: BoundingBox): BoundingBox {
  if (!lastFaceBox) {
    lastFaceBox = { ...newBox };
    return newBox;
  }
  // 指數平滑 α=0.3（平滑但仍能跟隨移動）
  const alpha = 0.3;
  const smoothed: BoundingBox = {
    x: lastFaceBox.x * (1 - alpha) + newBox.x * alpha,
    y: lastFaceBox.y * (1 - alpha) + newBox.y * alpha,
    width: lastFaceBox.width * (1 - alpha) + newBox.width * alpha,
    height: lastFaceBox.height * (1 - alpha) + newBox.height * alpha,
  };
  lastFaceBox = { ...smoothed };
  return smoothed;
}

/** 重置 bbox 平滑狀態（切換相機/新 session 時呼叫） */
export function resetBboxSmoothing(): void {
  lastFaceBox = null;
}

/**
 * 從 video 裁切臉部區域並 resize 到目標尺寸
 *
 * InsightFace ArcFace 標準預處理：
 * - 色彩空間：RGB（cv2.dnn.blobFromImage swapRB=True）
 * - 正規化：(pixel - 127.5) / 127.5 → 範圍 [-1, +1]
 * - 格式：CHW [3, H, W]
 *
 * @param video HTMLVideoElement
 * @param faceBox 正規化座標的臉部邊界框 (0-1)
 * @param targetSize 目標尺寸（正方形）
 * @returns CHW 格式的 Float32Array [3, H, W]，RGB 色彩空間，[-1,+1] 正規化
 */
function cropAndPreprocess(
  video: HTMLVideoElement,
  faceBox: BoundingBox,
  targetSize: number
): Float32Array {
  if (!faceCanvas || !faceCtx) {
    throw new Error('Face preprocessing canvas not initialized');
  }

  // 平滑 bounding box（減少逐幀抖動）
  const smoothedBox = smoothBoundingBox(faceBox);

  const vw = video.videoWidth;
  const vh = video.videoHeight;

  // 將正規化座標轉換為像素座標
  const sx = Math.max(0, Math.floor(smoothedBox.x * vw));
  const sy = Math.max(0, Math.floor(smoothedBox.y * vh));
  const sw = Math.min(Math.ceil(smoothedBox.width * vw), vw - sx);
  const sh = Math.min(Math.ceil(smoothedBox.height * vh), vh - sy);

  // 清除並裁切 + resize（canvas 尺寸固定為 FACE_INPUT_SIZE，無需 resize）
  faceCtx.clearRect(0, 0, targetSize, targetSize);
  faceCtx.drawImage(video, sx, sy, sw, sh, 0, 0, targetSize, targetSize);

  // 取得像素資料
  const imageData = faceCtx.getImageData(0, 0, targetSize, targetSize);
  const pixels = imageData.data; // RGBA

  // InsightFace ArcFace 標準預處理：
  // RGB 色彩空間 + (pixel - 127.5) / 127.5 → [-1, +1]
  // 參考：cv2.dnn.blobFromImage(img, 1.0/127.5, (112,112), (127.5,127.5,127.5), swapRB=True)
  const chw = new Float32Array(3 * targetSize * targetSize);
  const hw = targetSize * targetSize;

  for (let i = 0; i < hw; i++) {
    const rgbaIdx = i * 4;
    // RGB 順序（InsightFace swapRB=True → 模型接收 RGB）
    // (pixel - 127.5) / 127.5 = pixel / 127.5 - 1.0
    chw[0 * hw + i] = (pixels[rgbaIdx + 0] - 127.5) / 127.5; // R
    chw[1 * hw + i] = (pixels[rgbaIdx + 1] - 127.5) / 127.5; // G
    chw[2 * hw + i] = (pixels[rgbaIdx + 2] - 127.5) / 127.5; // B
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
 * 當提供 rawLandmarks 時使用 ArcFace 5 點對齊（推薦）
 * 否則 fallback 到 bounding box 裁切
 *
 * @param rawLandmarks MediaPipe 468 landmarks（正規化座標 0-1），用於 ArcFace 對齊
 * @returns 512 維 Float32Array，L2 正規化
 */
export async function extractCnnEmbedding(
  video: HTMLVideoElement,
  faceBox: BoundingBox,
  rawLandmarks?: FaceLandmark[]
): Promise<Float32Array> {
  if (!faceSession || !ortModule) {
    throw new Error('CNN face model not initialized');
  }

  // 優先使用 ArcFace 5 點對齊（穩定性遠高於 bbox 裁切）
  // fallback 到 bbox 裁切（無 landmarks 或 landmarks 不足時）
  let inputData: Float32Array;
  if (rawLandmarks && rawLandmarks.length >= 468) {
    inputData = cropAndPreprocessAligned(video, rawLandmarks, FACE_INPUT_SIZE);
  } else {
    inputData = cropAndPreprocess(video, faceBox, FACE_INPUT_SIZE);
  }

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
 * 使用 MiniFASNetV2SE (Silent-Face-Anti-Spoofing)：
 * - 輸入：128×128 RGB，CHW 格式
 * - 輸出：3 類 logits [fake, real, unknown]
 *   原始模型：label = np.argmax(prediction), label == 1 → Real
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

    // 取得輸出
    const outputKey = Object.keys(results)[0];
    const outputData = results[outputKey].data as Float32Array;

    // SuriAI MiniFASNetV2SE 量化模型 class 順序（經實測驗證）：
    // - 2 類: [real_logit, spoof_logit]
    // - index 0 = Real Face, index 1 = Spoof/Fake
    // 注意：與原始 Silent-Face-Anti-Spoofing 的順序相反（原始: index 1 = Real）

    const numClasses = outputData.length;

    // 數值穩定的 Softmax（全部 classes）
    let maxVal = -Infinity;
    for (let i = 0; i < numClasses; i++) {
      if (outputData[i] > maxVal) maxVal = outputData[i];
    }
    let sumExp = 0;
    const probs = new Float32Array(numClasses);
    for (let i = 0; i < numClasses; i++) {
      probs[i] = Math.exp(outputData[i] - maxVal);
      sumExp += probs[i];
    }
    for (let i = 0; i < numClasses; i++) {
      probs[i] /= sumExp;
    }

    // index 0 = Real Face（SuriAI 量化模型）
    const realProb = probs[0];

    devLog(`[CNN/AntiSpoof] classes=${numClasses}, raw=[${Array.from(outputData).map(v => v.toFixed(3)).join(',')}], probs=[${Array.from(probs).map(v => v.toFixed(3)).join(',')}], realProb=${realProb.toFixed(3)}`);

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
 * RGB 版預處理（anti-spoof 模型使用 RGB，[0,1] 正規化）
 *
 * SuriAI MiniFASNetV2SE 預處理規範：
 * 1. 臉部框擴大 1.5x（包含周圍背景，有助偵測螢幕邊框/反光等偽造線索）
 * 2. Letterbox resize（保持比例，反射填充）
 * 3. RGB [0,1]（/255，無 mean/std 正規化）
 */
function cropAndPreprocessRGB(
  video: HTMLVideoElement,
  faceBox: BoundingBox,
  targetSize: number
): Float32Array {
  if (!spoofCanvas || !spoofCtx) {
    throw new Error('Spoof preprocessing canvas not initialized');
  }

  // 使用已平滑的 bbox
  const smoothedBox = lastFaceBox ?? faceBox;

  const vw = video.videoWidth;
  const vh = video.videoHeight;

  // 擴大 1.5x 臉部框（含周圍背景，反偽造模型需要邊緣資訊）
  const EXPAND = 1.5;
  const cx = (smoothedBox.x + smoothedBox.width / 2) * vw;
  const cy = (smoothedBox.y + smoothedBox.height / 2) * vh;
  const halfW = (smoothedBox.width * vw * EXPAND) / 2;
  const halfH = (smoothedBox.height * vh * EXPAND) / 2;

  const sx = Math.max(0, Math.floor(cx - halfW));
  const sy = Math.max(0, Math.floor(cy - halfH));
  const sw = Math.min(Math.ceil(halfW * 2), vw - sx);
  const sh = Math.min(Math.ceil(halfH * 2), vh - sy);

  // Letterbox resize：保持比例，居中，填充區域用邊緣像素
  const scale = Math.min(targetSize / sw, targetSize / sh);
  const newW = Math.round(sw * scale);
  const newH = Math.round(sh * scale);
  const padX = Math.floor((targetSize - newW) / 2);
  const padY = Math.floor((targetSize - newH) / 2);

  // 清除並畫（canvas 尺寸固定為 SPOOF_INPUT_SIZE，無需 resize）
  spoofCtx.clearRect(0, 0, targetSize, targetSize);

  // 先用邊緣像素填充（模擬 reflection padding 簡化版）
  // 先畫拉伸版填滿底色
  spoofCtx.drawImage(video, sx, sy, sw, sh, 0, 0, targetSize, targetSize);
  // 再畫正確比例的居中版
  spoofCtx.drawImage(video, sx, sy, sw, sh, padX, padY, newW, newH);

  const imageData = spoofCtx.getImageData(0, 0, targetSize, targetSize);
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
  faceCanvas = null;
  faceCtx = null;
  spoofCanvas = null;
  spoofCtx = null;
  initPromise = null;
  lastFaceBox = null;
  devLog('[CNN] Models closed');
}
