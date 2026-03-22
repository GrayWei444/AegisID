/**
 * AegisID Structural Face ID — v15 IPD 正規化骨骼比率系統
 *
 * 目標：同一張臉 → 任何時間、任何光線、任何裝置 → 永遠相同的唯一 ID
 *
 * 一套骨骼比率系統同時服務：
 *   - 註冊：3D 轉頭掃描 → 25 骨骼比率 → SHA-256 唯一 ID → VPS 查重
 *   - 登入：平面刷臉 → 25 骨骼 bins → 比對本機正面基準 → ≥80% match
 *   - 恢復：3D 掃描 + PIN → account_key → VPS 查表 → 返回加密身份包
 *
 * @see docs/UNIQUE-FACE-ID.md
 * @see docs/BONE-RATIO-SYSTEM.md
 * @see docs/IMAGE-NORMALIZATION.md
 * @see tools/face-id-test.html
 */

// ============================================================
// Types
// ============================================================

export interface GrayImage {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** MediaPipe 468 landmark point */
export interface Landmark3D {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** MediaPipe FaceLandmarker 4×4 transform matrix (column-major, 16 elements) */
export interface TransformMatrixData {
  readonly data: readonly number[];
}

/** 單幀擷取結果（3D 掃描用） */
export interface CapturedFrame {
  readonly landmarks: readonly Landmark3D[];
  readonly matrix?: TransformMatrixData;
  readonly yaw?: number;
}

export type BoneRatioCategory = 'F' | 'EL' | 'ER' | 'B' | 'N' | 'M' | 'J' | 'X';

export interface BoneRatioDefinition {
  readonly id: string;
  readonly category: BoneRatioCategory;
  readonly name: string;
  readonly landmarkIndices: readonly number[];
}

export interface BoneRatioResult {
  readonly id: string;
  readonly value: number;
  readonly binIndex: number;
  readonly stable: boolean;
}

export interface PHash {
  readonly bits: string;
  readonly hex: string;
  readonly nBits: number;
}

export interface FaceStructureIdResult {
  readonly hash: string;
  readonly pHash4x4: PHash;
  readonly stableBoneRatios: readonly BoneRatioResult[];
  readonly totalRatiosTested: number;
  readonly stableCount: number;
  readonly frontalBins: ReadonlyMap<string, number>;
}

export interface LoginMatchResult {
  readonly matchCount: number;
  readonly totalCompared: number;
  readonly matchRate: number;
  readonly passed: boolean;
  readonly details: ReadonlyMap<string, { refBin: number; loginBin: number; match: boolean }>;
}

// ============================================================
// Constants
// ============================================================

/** Bin width for bone ratio quantization (confirmed: 0.25 + round()) */
export const DEFAULT_BIN_WIDTH = 0.25;

export const BONE_RATIO_TOTAL = 67;
export const BONE_RATIO_STABLE = 25;

/**
 * v15.1 穩定比率白名單 — IPD 正規化 + 多幀 median
 * 區分力：5^25 ≈ 3×10^17
 */
export const STABLE_RATIO_WHITELIST = [
  'F02', 'F03',
  'EL02', 'EL03', 'EL04', 'EL06', 'EL08',
  'ER02', 'ER03', 'ER04', 'ER06', 'ER08',
  'B01', 'B02', 'B04', 'B05', 'B06', 'B07',
  'N01', 'N02', 'N03', 'N04', 'N10',
  'X03', 'X05',
] as const;

export const LOGIN_MATCH_THRESHOLD = 0.80;

/** 正面幀取樣數（登入 & 註冊正面基準） */
const FRONTAL_FRAME_COUNT = 5;

// ============================================================
// Image Normalization Pipeline (verified SSIM 0.993)
// ============================================================

/** RGB ImageData → Grayscale (ITU-R BT.601) */
export function toGrayscale(img: ImageData): GrayImage {
  const px = img.data;
  const n = img.width * img.height;
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
  }
  return { data: gray, width: img.width, height: img.height };
}

/** 全局直方圖均衡化 */
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

/** 橢圓臉部遮罩（ArcFace 112×112 aligned 專用），遮罩外填 128 */
export function applyFaceMask(g: GrayImage): GrayImage {
  const { data: d, width: w, height: h } = g;
  const out = new Uint8Array(d.length);
  const cx = w / 2;
  const cy = h * 68 / 112;
  const rx = w * 40 / 112;
  const ry = h * 44 / 112;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      out[y * w + x] = (dx * dx + dy * dy <= 1.0) ? d[y * w + x] : 128;
    }
  }
  return { data: out, width: w, height: h };
}

/** ArcFace aligned ImageData → 正規化灰度圖 */
export function normalizeAlignedFace(alignedImg: ImageData): GrayImage {
  return applyFaceMask(histogramEqualize(toGrayscale(alignedImg)));
}

// ============================================================
// Internal Helpers — Distance & Midpoint
// ============================================================

type DistFn = (a: Landmark3D, b: Landmark3D) => number;
type MidFn = (a: Landmark3D, b: Landmark3D) => Landmark3D;

function dist2d(a: Landmark3D, b: Landmark3D): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function dist3d(a: Landmark3D, b: Landmark3D): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + ((a.z || 0) - (b.z || 0)) ** 2);
}

function midpoint2d(a: Landmark3D, b: Landmark3D): Landmark3D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: 0 };
}

function midpoint3d(a: Landmark3D, b: Landmark3D): Landmark3D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 };
}

function quantizeBin(value: number, binWidth: number): number {
  return Math.round(value / binWidth);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// ============================================================
// Bone Ratios — 67 ratios (all categories)
// ============================================================

/**
 * 計算全部 67 骨骼比率
 * @param lm MediaPipe 468 landmarks
 * @param d distance function (2d or 3d)
 * @param m midpoint function (2d or 3d)
 * @returns ratio map keyed by ID, or null if landmarks invalid
 */
function computeAllRatiosImpl(
  lm: readonly Landmark3D[],
  d: DistFn,
  m: MidFn,
): Record<string, number> | null {
  const fw = d(lm[234], lm[454]);
  const fh = d(lm[10], lm[152]);
  const ipd = d(lm[33], lm[263]);
  if (fw < 0.01 || fh < 0.01 || ipd < 0.01) return null;

  const leC = m(lm[33], lm[133]);
  const reC = m(lm[263], lm[362]);
  const eyeMid = m(leC, reC);

  const r: Record<string, number> = {};

  // === F: Face proportions ===
  r['F01'] = ipd / fw;
  r['F02'] = d(lm[10], eyeMid) / ipd;
  r['F03'] = d(eyeMid, lm[2]) / ipd;
  r['F04'] = d(lm[2], lm[152]) / fh;
  r['F05'] = d(lm[234], lm[1]) / d(lm[1], lm[454]);
  r['F06'] = d(lm[10], eyeMid) / d(lm[2], lm[152]);
  r['F07'] = Math.abs(lm[1].x - eyeMid.x) / ipd;

  // === EL: Left eye (bone-only) ===
  r['EL01'] = d(lm[33], lm[133]) / d(lm[159], lm[145]);
  r['EL02'] = d(lm[133], leC) / d(lm[33], leC);
  r['EL03'] = d(lm[133], lm[6]) / ipd;
  r['EL04'] = d(leC, lm[1]) / ipd;
  r['EL05'] = d(lm[159], lm[145]) / ipd;
  r['EL06'] = d(lm[33], lm[133]) / ipd;
  r['EL07'] = d(lm[159], lm[66]) / d(lm[159], lm[145]);
  r['EL08'] = d(leC, lm[6]) / ipd;

  // === ER: Right eye (bone-only) ===
  r['ER01'] = d(lm[263], lm[362]) / d(lm[386], lm[374]);
  r['ER02'] = d(lm[362], reC) / d(lm[263], reC);
  r['ER03'] = d(lm[362], lm[6]) / ipd;
  r['ER04'] = d(reC, lm[1]) / ipd;
  r['ER05'] = d(lm[386], lm[374]) / ipd;
  r['ER06'] = d(lm[263], lm[362]) / ipd;
  r['ER07'] = d(lm[386], lm[296]) / d(lm[386], lm[374]);
  r['ER08'] = d(reC, lm[6]) / ipd;

  // === B: Eyebrows (bone-only) ===
  r['B01'] = d(lm[66], eyeMid) / ipd;
  r['B02'] = d(lm[296], eyeMid) / ipd;
  r['B03'] = d(lm[66], eyeMid) / d(lm[296], eyeMid);
  r['B04'] = d(lm[105], lm[334]) / ipd;
  r['B05'] = d(lm[70], lm[300]) / ipd;
  r['B06'] = d(lm[70], lm[105]) / ipd;
  r['B07'] = d(lm[300], lm[334]) / ipd;
  r['B08'] = d(lm[70], lm[105]) / d(lm[300], lm[334]);

  // === N: Nose (bone + cartilage) ===
  r['N01'] = d(lm[48], lm[278]) / ipd;
  r['N02'] = d(lm[6], lm[2]) / ipd;
  r['N03'] = d(lm[6], lm[4]) / d(lm[6], lm[2]);
  r['N04'] = d(lm[98], lm[327]) / d(lm[48], lm[278]);
  r['N05'] = d(lm[48], lm[6]) / ipd;
  r['N06'] = d(lm[1], lm[48]) / d(lm[1], lm[278]);
  r['N07'] = d(lm[48], lm[278]) / d(lm[6], lm[2]);
  r['N08'] = d(lm[6], lm[10]) / ipd;
  r['N09'] = d(lm[1], lm[0]) / d(lm[6], lm[2]);
  r['N10'] = d(lm[4], lm[2]) / ipd;

  // === M: Mouth (soft tissue, NOT in whitelist) ===
  r['M01'] = d(lm[61], lm[291]) / fw;
  r['M02'] = d(lm[61], lm[291]) / ipd;
  r['M03'] = d(lm[0], lm[13]) / d(lm[14], lm[17]);
  r['M04'] = d(lm[0], lm[2]) / ipd;
  r['M05'] = d(lm[0], lm[152]) / fh;
  r['M06'] = d(lm[61], lm[152]) / fh;
  r['M07'] = d(lm[291], lm[152]) / fh;
  r['M08'] = d(lm[61], lm[0]) / d(lm[291], lm[0]);
  r['M09'] = d(lm[0], lm[17]) / d(lm[61], lm[291]);
  r['M10'] = d(lm[2], lm[0]) / d(lm[6], lm[2]);

  // === J: Jaw (fat-affected, NOT in whitelist) ===
  r['J01'] = d(lm[132], lm[361]) / fw;
  r['J02'] = d(lm[93], lm[323]) / fw;
  r['J03'] = d(lm[175], lm[396]) / d(lm[132], lm[361]);
  r['J04'] = d(lm[132], lm[152]) / d(lm[361], lm[152]);
  r['J05'] = d(lm[93], lm[132]) / fh;
  r['J06'] = d(lm[175], lm[396]) / d(lm[152], m(lm[175], lm[396]));
  r['J07'] = d(lm[58], lm[288]) / fw;
  r['J08'] = d(lm[93], lm[323]) / ipd;

  // === X: Cross-features (bone-only) ===
  r['X01'] = d(lm[6], lm[2]) / ipd;
  r['X02'] = d(eyeMid, lm[4]) / ipd;
  r['X03'] = d(eyeMid, lm[6]) / ipd;
  r['X04'] = d(lm[48], lm[278]) / d(lm[61], lm[291]);
  r['X05'] = d(lm[105], lm[6]) / ipd;
  r['X06'] = d(lm[334], lm[6]) / ipd;
  r['X07'] = d(lm[6], eyeMid) / d(lm[6], lm[2]);
  r['X08'] = d(lm[278], lm[6]) / ipd;

  return r;
}

/** 2D bone ratios (登入/正面基準用) */
function computeAllRatios2d(lm: readonly Landmark3D[]): Record<string, number> | null {
  return computeAllRatiosImpl(lm, dist2d, midpoint2d);
}

/** 3D bone ratios (3D 重建後的模型用) */
function computeAllRatios3d(lm: readonly Landmark3D[]): Record<string, number> | null {
  return computeAllRatiosImpl(lm, dist3d, midpoint3d);
}

// ============================================================
// 3D Reconstruction — inverse rotation + median fusion
// ============================================================

type RotMatrix = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

function extractRotation(mat: TransformMatrixData): RotMatrix {
  const d = mat.data;
  return [[d[0], d[1], d[2]], [d[4], d[5], d[6]], [d[8], d[9], d[10]]];
}

function transposeRotation(r: RotMatrix): RotMatrix {
  return [
    [r[0][0], r[1][0], r[2][0]],
    [r[0][1], r[1][1], r[2][1]],
    [r[0][2], r[1][2], r[2][2]],
  ];
}

function rotatePoint(r: RotMatrix, p: Landmark3D): Landmark3D {
  return {
    x: r[0][0] * p.x + r[0][1] * p.y + r[0][2] * p.z,
    y: r[1][0] * p.x + r[1][1] * p.y + r[1][2] * p.z,
    z: r[2][0] * p.x + r[2][1] * p.y + r[2][2] * p.z,
  };
}

/** 反向旋轉 landmarks 到 canonical space（消除頭部轉動） */
export function canonicalizeLandmarks(
  landmarks: readonly Landmark3D[],
  matrix: TransformMatrixData,
): readonly Landmark3D[] {
  const ri = transposeRotation(extractRotation(matrix));
  const n = landmarks.length;

  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    cx += landmarks[i].x;
    cy += landmarks[i].y;
    cz += (landmarks[i].z || 0);
  }
  cx /= n; cy /= n; cz /= n;

  return landmarks.map((lm) => {
    const centered: Landmark3D = { x: lm.x - cx, y: lm.y - cy, z: (lm.z || 0) - cz };
    return rotatePoint(ri, centered);
  });
}

/** 多角度 canonical landmarks → per-landmark median fusion → 3D model */
export function build3DModel(frames: readonly CapturedFrame[]): readonly Landmark3D[] | null {
  const canonSets: Landmark3D[][] = [];

  for (const fr of frames) {
    if (fr.matrix) {
      canonSets.push([...canonicalizeLandmarks(fr.landmarks, fr.matrix)]);
    } else {
      canonSets.push(fr.landmarks.map((l) => ({ x: l.x, y: l.y, z: l.z || 0 })));
    }
  }

  if (canonSets.length === 0) return null;
  const numLm = canonSets[0].length;

  return Array.from({ length: numLm }, (_, i) => {
    const xs = canonSets.map((s) => s[i].x);
    const ys = canonSets.map((s) => s[i].y);
    const zs = canonSets.map((s) => s[i].z);
    return { x: median(xs), y: median(ys), z: median(zs) };
  });
}

// ============================================================
// SHA-256
// ============================================================

async function sha256hex(str: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================
// DCT / pHash (4×4 = 15 bit, VPS 快速預篩用)
// ============================================================

function downscaleGray(g: GrayImage, size: number): Float64Array {
  const out = new Float64Array(size * size);
  const scaleX = g.width / size;
  const scaleY = g.height / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0, count = 0;
      const y0 = Math.floor(y * scaleY);
      const y1 = Math.min(Math.floor((y + 1) * scaleY), g.height);
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.min(Math.floor((x + 1) * scaleX), g.width);
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          sum += g.data[sy * g.width + sx];
          count++;
        }
      }
      out[y * size + x] = count > 0 ? sum / count : 0;
    }
  }
  return out;
}

function dct2d(input: Float64Array, size: number): Float64Array {
  const out = new Float64Array(size * size);
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      let sum = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          sum += input[y * size + x]
            * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size))
            * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size));
        }
      }
      const cu = u === 0 ? 1 / Math.sqrt(2) : 1;
      const cv = v === 0 ? 1 / Math.sqrt(2) : 1;
      out[v * size + u] = 0.25 * cu * cv * sum;
    }
  }
  return out;
}

/** pHash 4×4 (15 bit) — DCT 32×32 → 4×4 低頻 → median threshold */
export function computePHash4x4(gray: GrayImage): PHash {
  const INPUT_SIZE = 32;
  const DCT_SIZE = 4;
  const small = downscaleGray(gray, INPUT_SIZE);
  const dctResult = dct2d(small, INPUT_SIZE);

  const coeffs: number[] = [];
  for (let v = 0; v < DCT_SIZE; v++) {
    for (let u = 0; u < DCT_SIZE; u++) {
      if (u === 0 && v === 0) continue; // skip DC
      coeffs.push(dctResult[v * INPUT_SIZE + u]);
    }
  }

  const sorted = [...coeffs].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];

  const bits = coeffs.map((c) => (c > med ? '1' : '0')).join('');
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.substring(i, i + 4) || '0', 2).toString(16);
  }

  return { bits, hex, nBits: coeffs.length };
}

// ============================================================
// Public API
// ============================================================

/**
 * 計算骨骼比率 — 25 個穩定白名單比率
 *
 * @param landmarks MediaPipe 468 landmarks
 * @param binWidth 量化 bin 寬度，預設 0.25
 * @param use3d 使用 3D distance（3D model 用），預設 false
 */
export function computeBoneRatios(
  landmarks: readonly Landmark3D[],
  binWidth: number = DEFAULT_BIN_WIDTH,
  use3d: boolean = false,
): readonly BoneRatioResult[] {
  const allRatios = use3d
    ? computeAllRatios3d(landmarks)
    : computeAllRatios2d(landmarks);

  if (!allRatios) return [];

  return STABLE_RATIO_WHITELIST.map((id) => {
    const value = allRatios[id] ?? 0;
    return {
      id,
      value,
      binIndex: quantizeBin(value, binWidth),
      stable: id in allRatios,
    };
  });
}

/**
 * 從多幀計算 median bins（消除單幀噪音）
 *
 * @param multiFrameLandmarks 多幀 landmarks
 * @param binWidth bin 寬度
 * @param use3d 是否用 3D distance
 * @returns bin map (ratio id → bin index)
 */
export function computeMedianBins(
  multiFrameLandmarks: readonly (readonly Landmark3D[])[],
  binWidth: number = DEFAULT_BIN_WIDTH,
  use3d: boolean = false,
): ReadonlyMap<string, number> {
  const ratioFn = use3d ? computeAllRatios3d : computeAllRatios2d;
  const ratioSets = multiFrameLandmarks
    .map((lm) => ratioFn(lm))
    .filter((r): r is Record<string, number> => r !== null);

  if (ratioSets.length < 2) return new Map();

  const bins = new Map<string, number>();
  for (const id of STABLE_RATIO_WHITELIST) {
    const vals = ratioSets
      .map((s) => s[id])
      .filter((v): v is number => v !== undefined);
    if (vals.length >= 2) {
      bins.set(id, quantizeBin(median(vals), binWidth));
    }
  }
  return bins;
}

/**
 * 唯一 Face Structure ID（3D 註冊用）
 *
 * 流程：
 *   1. 多角度 frames → build3DModel() → median fusion
 *   2. 3D model → 25 穩定骨骼比率 → quantize → SHA-256 = face_hash
 *   3. 取最接近正面的 5 幀 → 2D median bins → frontalBins（存本機供登入）
 *   4. 可選：aligned image → pHash 4×4（VPS 快速預篩）
 *
 * @param frames 3D 掃描擷取的多角度幀
 * @param alignedImg 可選 ArcFace aligned 圖（用於 pHash）
 */
export async function computeStructuralId(
  frames: readonly CapturedFrame[],
  alignedImg?: ImageData,
): Promise<FaceStructureIdResult> {
  // Step 1: Build 3D model from multi-angle canonical landmarks
  const model = build3DModel(frames);
  if (!model) {
    throw new Error('Failed to build 3D model — insufficient valid frames');
  }

  // Step 2: Compute 3D bone ratios on canonical model
  const ratios3d = computeAllRatios3d(model);
  if (!ratios3d) {
    throw new Error('Failed to compute bone ratios — invalid 3D model landmarks');
  }

  // Step 3: Quantize whitelist ratios → hash
  const hashParts: string[] = [];
  const stableBoneRatios: BoneRatioResult[] = [];

  for (const id of STABLE_RATIO_WHITELIST) {
    const value = ratios3d[id];
    if (value !== undefined) {
      const bin = quantizeBin(value, DEFAULT_BIN_WIDTH);
      hashParts.push(`${id}:${bin}`);
      stableBoneRatios.push({ id, value, binIndex: bin, stable: true });
    }
  }

  const hash = await sha256hex(hashParts.join('|'));

  // Step 4: Extract frontal reference bins (top N near-frontal frames by yaw)
  const sortedByYaw = [...frames]
    .filter((f) => f.yaw !== undefined)
    .sort((a, b) => Math.abs(a.yaw!) - Math.abs(b.yaw!));
  const nearFrontal = sortedByYaw.slice(0, FRONTAL_FRAME_COUNT);

  const frontalBins = nearFrontal.length >= 2
    ? computeMedianBins(nearFrontal.map((f) => f.landmarks))
    : new Map<string, number>();

  // Step 5: pHash (optional)
  const pHash4x4 = alignedImg
    ? computePHash4x4(normalizeAlignedFace(alignedImg))
    : { bits: '', hex: '', nBits: 0 };

  return {
    hash,
    pHash4x4,
    stableBoneRatios,
    totalRatiosTested: BONE_RATIO_TOTAL,
    stableCount: stableBoneRatios.length,
    frontalBins,
  };
}

/**
 * 登入比對 — 多幀正面刷臉 vs 本機正面基準 bins
 *
 * @param loginFrames 登入時擷取的多幀正面 landmarks（建議 5 幀）
 * @param storedFrontalBins 本機存的正面基準 bins（註冊時 computeStructuralId 產出）
 * @returns 比對結果，matchRate ≥ 0.80 → 通過
 */
export function matchLoginBins(
  loginFrames: readonly (readonly Landmark3D[])[],
  storedFrontalBins: ReadonlyMap<string, number>,
): LoginMatchResult {
  const loginBins = computeMedianBins(loginFrames);

  let matchCount = 0;
  let totalCompared = 0;
  const details = new Map<string, { refBin: number; loginBin: number; match: boolean }>();

  for (const id of STABLE_RATIO_WHITELIST) {
    const refBin = storedFrontalBins.get(id);
    const loginBin = loginBins.get(id);
    if (refBin !== undefined && loginBin !== undefined) {
      totalCompared++;
      const match = refBin === loginBin;
      if (match) matchCount++;
      details.set(id, { refBin, loginBin, match });
    }
  }

  const matchRate = totalCompared > 0 ? matchCount / totalCompared : 0;

  return {
    matchCount,
    totalCompared,
    matchRate,
    passed: matchRate >= LOGIN_MATCH_THRESHOLD,
    details,
  };
}
