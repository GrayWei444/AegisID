/**
 * Anti-Spoof Inference Service
 *
 * MiniFASNetV2SE — 照片/面具/螢幕防偽偵測
 *
 * 使用 onnxruntime-web WASM 後端，懶載入 + Service Worker 快取
 *
 * 注意：MobileFaceNet (face_recognition.onnx) 已移除。
 * 臉部辨識改用骨骼比率系統（structuralId.ts），不再需要 CNN embedding。
 */

import { devLog, devWarn } from '../utils/devLog';
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
let spoofSession: OrtSession | null = null;
let isInitializing = false;
let initPromise: Promise<void> | null = null;
let initFailed = false;
let initAttempts = 0;
const MAX_RETRIES = 3;

// Anti-spoof preprocessing canvas
let spoofCanvas: OffscreenCanvas | null = null;
let spoofCtx: OffscreenCanvasRenderingContext2D | null = null;

// ============================================================================
// Constants
// ============================================================================

const SPOOF_MODEL_PATH = '/models/anti_spoof.onnx';

/** MiniFASNetV2SE 輸入尺寸 */
const SPOOF_INPUT_SIZE = 128;

/** MiniFASNetV2SE 輸入 tensor name */
const SPOOF_INPUT_NAME = 'input';

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
 * 我們的模型只需 ~10-20MB（612KB 模型 + ORT runtime），256MB 上限綽綽有餘。
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
        devLog('[AntiSpoof] Shared memory failed, trying non-shared');
        const { shared: _, ...nonSharedDesc } = patched;
        return new OrigMemory(nonSharedDesc as MemoryDescriptor);
      }
      throw err;
    }
  } as unknown as typeof WebAssembly.Memory;

  // Preserve prototype chain
  patchedCtor.prototype = OrigMemory.prototype;
  (WebAssembly as { Memory: typeof WebAssembly.Memory }).Memory = patchedCtor;

  devLog(`[AntiSpoof] iOS: patched WebAssembly.Memory maximum=${IOS_WASM_MAX_PAGES} (${IOS_WASM_MAX_PAGES * 64 / 1024}MB)`);
  return OrigMemory;
}

function restoreWasmMemory(orig: typeof WebAssembly.Memory | null): void {
  if (orig) {
    (WebAssembly as { Memory: typeof WebAssembly.Memory }).Memory = orig;
    devLog('[AntiSpoof] iOS: restored original WebAssembly.Memory');
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

/**
 * 初始化 Anti-Spoof 模型 (MiniFASNetV2SE)
 *
 * 向後相容別名：initCnnModels() — 現在只載入防偽模型
 */
export async function initAntiSpoofModel(): Promise<void> {
  if (spoofSession) return;
  if (initPromise) return initPromise;
  // 已確認永久性失敗（如 OOM），不再重試
  if (initFailed) return;

  isInitializing = true;
  initAttempts++;

  initPromise = (async () => {
    // iOS 記憶體修正：必須在 import ORT 之前 patch（ORT 在 module 載入時建立 Memory）
    const origMemory = patchWasmMemoryForIOS();

    try {
      const startTime = Date.now();
      devLog(`[AntiSpoof] Initializing ONNX Runtime + model... (attempt ${initAttempts}/${MAX_RETRIES})`);

      // 動態載入 onnxruntime-web（此時 WebAssembly.Memory 已被 patch）
      if (!ortModule) {
        ortModule = await import('onnxruntime-web');

        // 設定 WASM 後端 — 禁用 threads（iOS WKWebView 不穩定）
        // wasmPaths 指向 /wasm/ 避免 Vite hash 造成 ORT 找不到檔案
        ortModule.env.wasm.numThreads = 1;
        ortModule.env.wasm.wasmPaths = '/wasm/';
      }

      // 載入防偽模型
      const spoof = await ortModule.InferenceSession.create(SPOOF_MODEL_PATH, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });

      spoofSession = spoof as unknown as OrtSession;

      // 初始化 preprocessing canvas
      spoofCanvas = new OffscreenCanvas(SPOOF_INPUT_SIZE, SPOOF_INPUT_SIZE);
      spoofCtx = spoofCanvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;

      // Warm-up inference
      try {
        const dummySpoof = new Float32Array(3 * SPOOF_INPUT_SIZE * SPOOF_INPUT_SIZE);
        const warmupSpoofTensor = new ortModule.Tensor('float32', dummySpoof, [1, 3, SPOOF_INPUT_SIZE, SPOOF_INPUT_SIZE]);
        const spoofResult = await spoofSession.run({ [SPOOF_INPUT_NAME]: warmupSpoofTensor as unknown as OrtTensor });
        (warmupSpoofTensor as unknown as OrtTensor).dispose();
        const spoofOutKey = Object.keys(spoofResult)[0];
        if (spoofOutKey) spoofResult[spoofOutKey].dispose();

        devLog('[AntiSpoof] Warm-up inference complete');
      } catch (warmupErr) {
        devWarn('[AntiSpoof] Warm-up inference failed (non-fatal):', warmupErr);
      }

      const elapsed = Date.now() - startTime;
      devLog(`[AntiSpoof] Initialized in ${elapsed}ms (attempt ${initAttempts})`);
    } catch (err) {
      devWarn(`[AntiSpoof] Initialization failed (attempt ${initAttempts}):`, err);
      initPromise = null;

      if (!isTransientError(err) || initAttempts >= MAX_RETRIES) {
        // 永久性失敗 或 重試次數用完
        initFailed = true;
        devWarn(`[AntiSpoof] Permanently failed after ${initAttempts} attempts`);
      }
      // 暫時性失敗且還有重試次數 → 不設 initFailed，讓下次呼叫可以重試

      throw err;
    } finally {
      isInitializing = false;
      restoreWasmMemory(origMemory);
    }
  })();

  return initPromise;
}

/** 向後相容別名 */
export const initCnnModels = initAntiSpoofModel;

/** Anti-Spoof 模型是否已就緒 */
export function isAntiSpoofReady(): boolean {
  return spoofSession !== null;
}

/** 向後相容別名 */
export const isCnnReady = isAntiSpoofReady;

/** Anti-Spoof 模型是否正在初始化 */
export function isAntiSpoofInitializing(): boolean {
  return isInitializing;
}

/** 向後相容別名 */
export const isCnnInitializing = isAntiSpoofInitializing;

/** Anti-Spoof 模型初始化是否已失敗（如 iOS OOM） */
export function isAntiSpoofFailed(): boolean {
  return initFailed;
}

/** 向後相容別名 */
export const isCnnFailed = isAntiSpoofFailed;

// ============================================================================
// Bounding Box Preprocessing
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
    throw new Error('Anti-spoof model not initialized');
  }

  // 平滑 bounding box
  smoothBoundingBox(faceBox);

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

    devLog(`[AntiSpoof] classes=${numClasses}, raw=[${Array.from(outputData).map(v => v.toFixed(3)).join(',')}], probs=[${Array.from(probs).map(v => v.toFixed(3)).join(',')}], realProb=${realProb.toFixed(3)}`);

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

/** 釋放 Anti-Spoof 模型資源 */
export async function closeAntiSpoofModel(): Promise<void> {
  if (spoofSession) {
    await spoofSession.release();
    spoofSession = null;
  }
  spoofCanvas = null;
  spoofCtx = null;
  initPromise = null;
  lastFaceBox = null;
  devLog('[AntiSpoof] Model closed');
}

/** 向後相容別名 */
export const closeCnnModels = closeAntiSpoofModel;
