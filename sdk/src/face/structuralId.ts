/**
 * AegisID Structural Face ID
 *
 * 目標：同一張臉 → 任何時間、任何光線、任何裝置 → 永遠相同的唯一 ID
 *
 * 這不是模糊匹配（similarity > threshold），是確定性的唯一 ID。
 * 傳統 CNN embedding 每次推論結果不同，只能做「夠接近」的匹配。
 * Structural ID 透過確定性影像處理管線，讓同一張臉永遠產出同一個 hash。
 *
 * 管線（已驗證 SSIM 0.993）：
 *   ArcFace 5pt align → grayscale → histogram equalization → face mask → 112×112
 *
 * 特徵提取（研究中）：
 *   - 骨骼比率（MediaPipe landmarks）
 *   - 深度曲率場（Depth Anything V2 + Laplacian）
 *   - pHash（DCT 感知 hash）
 *   - 組合策略待定
 *
 * @see docs/UNIQUE-FACE-ID.md
 * @see docs/IMAGE-NORMALIZATION.md
 * @see docs/face-structure-id-research.md
 * @see tools/face-id-test.html
 */

// ============================================================
// Image Normalization Pipeline (verified)
// ============================================================

export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * RGB ImageData → Grayscale
 * ITU-R BT.601: 0.299R + 0.587G + 0.114B
 */
export function toGrayscale(img: ImageData): GrayImage {
  const px = img.data;
  const n = img.width * img.height;
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
  }
  return { data: gray, width: img.width, height: img.height };
}

/**
 * 全局直方圖均衡化（不是 CLAHE）
 * 把任意曝光條件下的灰度分佈拉到均勻分佈
 */
export function histogramEqualize(g: GrayImage): GrayImage {
  const d = g.data;
  const n = d.length;
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[d[i]]++;

  const cdf = new Uint32Array(256);
  cdf[0] = hist[0];
  for (let i = 1; i < 256; i++) cdf[i] = cdf[i - 1] + hist[i];

  let cdfMin = 0;
  for (let i = 0; i < 256; i++) {
    if (cdf[i] > 0) { cdfMin = cdf[i]; break; }
  }

  const out = new Uint8Array(n);
  const scale = 255 / (n - cdfMin || 1);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round((cdf[d[i]] - cdfMin) * scale);
  }
  return { data: out, width: g.width, height: g.height };
}

/**
 * 橢圓臉部遮罩（ArcFace 112×112 aligned 專用）
 * 遮罩外填充 128（中性灰）
 */
export function applyFaceMask(g: GrayImage): GrayImage {
  const d = g.data;
  const w = g.width;
  const h = g.height;
  const out = new Uint8Array(d.length);

  // 遮罩參數（ArcFace 112×112 標準位置）
  const cx = w / 2;
  const cy = h * 68 / 112;
  const rx = w * 40 / 112;
  const ry = h * 44 / 112;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1.0) {
        out[y * w + x] = d[y * w + x];
      } else {
        out[y * w + x] = 128;
      }
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * 完整正規化管線
 * ArcFace aligned ImageData → 正規化灰度圖
 *
 * 已驗證: SSIM > 0.99, pHash 4×4 100% exact match
 */
export function normalizeAlignedFace(alignedImg: ImageData): GrayImage {
  const gray = toGrayscale(alignedImg);
  const equalized = histogramEqualize(gray);
  const masked = applyFaceMask(equalized);
  return masked;
}

// ============================================================
// Structural Features — 骨骼比率系統
// ============================================================

/**
 * 骨骼比率類別
 * @see docs/BONE-RATIO-SYSTEM.md
 */
export type BoneRatioCategory =
  | 'F'   // 臉部整體比例
  | 'EL'  // 左眼
  | 'ER'  // 右眼
  | 'B'   // 眉毛
  | 'N'   // 鼻子
  | 'M'   // 嘴巴
  | 'J'   // 下顎顴骨
  | 'X';  // 交叉特徵

/**
 * 單一骨骼比率定義
 */
export interface BoneRatioDefinition {
  readonly id: string;
  readonly category: BoneRatioCategory;
  readonly name: string;
  readonly landmarkIndices: readonly number[];
}

/**
 * 骨骼比率計算結果
 */
export interface BoneRatioResult {
  readonly id: string;
  readonly value: number;
  readonly binIndex: number;
  readonly stable: boolean;
}

/**
 * pHash 感知 hash（DCT）
 * 4×4 (15bit) = 100% stable, 區分力不足 → 用作快速預篩
 * 8×8 (63bit) = 2-4 bit drift → 暫不使用
 */
export interface PHash {
  readonly bits: string;
  readonly hex: string;
  readonly nBits: number;
}

/**
 * Face Structure ID 完整結果
 */
export interface FaceStructureIdResult {
  readonly hash: string;
  readonly pHash4x4: PHash;
  readonly stableBoneRatios: readonly BoneRatioResult[];
  readonly totalRatiosTested: number;
  readonly stableCount: number;
}

/** Bin width for bone ratio quantization */
export const DEFAULT_BIN_WIDTH = 0.05;

/** 67 骨骼比率的 MediaPipe landmark 對應 — 待比率篩選完成後填入完整定義 */
export const BONE_RATIO_COUNT = 67;

/**
 * 計算骨骼比率
 * TODO: 等穩定比率子集確定後，只計算穩定的那些
 *
 * @param landmarks MediaPipe 468 landmarks (ArcFace aligned 座標)
 * @param binWidth 量化 bin 寬度，預設 0.05
 */
export function computeBoneRatios(
  _landmarks: readonly { x: number; y: number; z: number }[],
  _binWidth: number = DEFAULT_BIN_WIDTH,
): readonly BoneRatioResult[] {
  // TODO: 等 67 比率穩定性測試完成，保留穩定子集後實作
  throw new Error('Not implemented — bone ratio stability testing in progress. See docs/BONE-RATIO-SYSTEM.md');
}

/**
 * 計算 pHash 4×4（快速預篩用）
 * TODO: 實作 DCT 32×32 → 4×4 低頻 → median threshold → 15 bit hash
 */
export function computePHash4x4(_gray: GrayImage): PHash {
  // TODO: 實作
  throw new Error('Not implemented — see docs/UNIQUE-FACE-ID.md');
}

/**
 * 唯一 Face Structure ID
 * TODO: 確定特徵組合策略後實作
 *
 * 目標：
 *   同一人 → 永遠相同的 SHA-256 hash
 *   不同人 → 永遠不同的 SHA-256 hash
 *
 * 組合策略：pHash 4×4 (15bit) + 穩定骨骼比率 bins → SHA-256
 *
 * @see docs/UNIQUE-FACE-ID.md
 * @see docs/BONE-RATIO-SYSTEM.md
 */
export async function computeStructuralId(
  _alignedImg: ImageData,
  _landmarks: readonly { x: number; y: number; z: number }[],
): Promise<FaceStructureIdResult> {
  // TODO: 特徵提取 + 量化 + hash
  throw new Error('Not implemented — research in progress. See docs/UNIQUE-FACE-ID.md');
}
