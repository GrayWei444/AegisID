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
// Structural Features (TODO — research in progress)
// ============================================================

/**
 * 骨骼比率特徵（MediaPipe 468 landmarks）
 * TODO: 確定穩定的比率子集和最佳 bin width
 */
export interface BoneRatios {
  [key: string]: number;
}

/**
 * pHash 感知 hash（DCT）
 * TODO: 確定最佳 DCT 大小（4×4 穩定但區分力不足，8×8 區分力夠但不穩定）
 */
export interface PHash {
  bits: string;
  hex: string;
  nBits: number;
}

/**
 * 唯一 Face Structure ID
 * TODO: 確定特徵組合策略後實作
 *
 * 目標：
 *   同一人 → 永遠相同的 SHA-256 hash
 *   不同人 → 永遠不同的 SHA-256 hash
 */
export async function computeStructuralId(
  _alignedImg: ImageData,
  _landmarks: unknown,
): Promise<string> {
  // TODO: 特徵提取 + 量化 + hash
  throw new Error('Not implemented — research in progress. See docs/UNIQUE-FACE-ID.md');
}
