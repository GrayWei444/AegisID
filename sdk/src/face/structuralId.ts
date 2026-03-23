/**
 * AegisID Structural Face ID — v17 多基準最佳化 + 真實 3D 三角測量
 *
 * 目標：同一張臉 → 任何時間、任何光線、任何裝置 → 永遠相同的唯一 ID
 *
 * 架構：
 *   - 註冊：轉頭掃描 → 2D (25 bins) + 3D (11 bins) → SHA-256 唯一 ID → VPS 查重
 *   - 登入：正面刷臉 → 2D bins → 比對本機基準 → ≥80% match
 *   - 恢復：3D 掃描 + PIN → account_key → VPS 查表
 *
 * v17 改進（已驗證 3/3 穩定）：
 *   - 多基準：垂直用 fh, 水平用 (IPD+browW)/2, 自比率不需基準
 *   - 穩定量化：floor-biased (frac≥0.80 才 ceil)
 *   - 嚴格正面篩選：|yaw|<0.05 + pitch 42~58%, 最多 20 幀 median
 *   - Landmark-based rotation：不依賴 MediaPipe transform matrix
 *   - 真 3D 三角測量：全量幀 multi-ray least-squares
 *   - 32 個 3D 特徵（6 類），11 個穩定特徵用於 hash
 *
 * @see docs/UNIQUE-FACE-ID.md
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

export interface Landmark3D {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface TransformMatrixData {
  readonly data: readonly number[];
}

export interface CapturedFrame {
  readonly landmarks: readonly Landmark3D[];
  readonly matrix?: TransformMatrixData;
  readonly yaw?: number;
}

export type BoneRatioCategory = 'F' | 'EL' | 'ER' | 'B' | 'N' | 'M' | 'J' | 'X';

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

export interface IdentityHashes {
  readonly hash2D: string;
  readonly hash3D: string;
  readonly hashCombined: string;
}

export interface FaceStructureIdResult {
  readonly hashes: IdentityHashes;
  readonly frontalBins: ReadonlyMap<string, number>;
  readonly bins3D: ReadonlyMap<string, number>;
  readonly model3D: readonly Landmark3D[] | null;
  readonly stableCount2D: number;
  readonly stableCount3D: number;
}

export interface LoginMatchResult {
  readonly matchCount: number;
  readonly totalCompared: number;
  readonly matchRate: number;
  readonly passed: boolean;
  readonly details: ReadonlyMap<string, { refBin: number; loginBin: number; match: boolean }>;
}

interface ReferenceWidths {
  readonly ipd: number;
  readonly browW: number;
  readonly fh: number;
  readonly noseW: number;
  readonly innerE: number;
  readonly noseLen: number;
}

type RotMatrix = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

// ============================================================
// Constants
// ============================================================

export const DEFAULT_BIN_WIDTH = 0.25;

/**
 * v17 2D 穩定比率白名單 — 多基準最佳化
 * 測試結果：3/3 穩定
 */
export const STABLE_RATIO_WHITELIST = [
  'F02', 'F03',
  'EL02', 'EL03', 'EL04', 'EL06', 'EL08',
  'ER02', 'ER03', 'ER04', 'ER06', 'ER08',
  'B01', 'B02', 'B04', 'B05', 'B06', 'B07',
  'N01', 'N02', 'N03', 'N04', 'N10',
  'X03', 'X05',
] as const;

/**
 * v17 3D 穩定特徵白名單 — 全部使用 3D 距離或比率
 * 測試結果：3/3 穩定（移除 F02 chin, F03 jaw — CV>10%）
 */
export const STABLE_3D_FEATURES = [
  'T01_temple_width', 'T03_cheek_jaw_ratio', 'E04_orbital_width_R',
  'E05_intercanthal', 'N05_alar_width_3d', 'F05_face_side',
  'G02_face_width_height', 'T02_temple_recess', 'T05_bizygomatic',
  'E03_orbital_width_L', 'F04_bigonial',
] as const;

export const LOGIN_MATCH_THRESHOLD = 0.80;

// ============================================================
// Internal Helpers
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

/**
 * v17 穩定量化 — floor-biased
 * 只有 frac ≥ 0.80 才進位，大幅減少 bin 邊界跳動
 */
function quantizeBin(value: number, binWidth: number): number {
  const raw = value / binWidth;
  const frac = raw - Math.floor(raw);
  return frac >= 0.80 ? Math.ceil(raw) : Math.floor(raw);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function sha256hex(str: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================
// v17 Bone Ratios — 多基準最佳化
// ============================================================

/**
 * v17 骨骼比率計算
 *
 * 基準策略（CNN 穩定性測試結果）：
 *   垂直距離 → fh (face height, CV=0.24%)
 *   水平距離 → ref = (IPD + browW) / 2 (CV=0.24%)
 *   自比率 → 同類距離相除，不需基準（最穩定）
 */
function computeAllRatiosV17(
  lm: readonly Landmark3D[],
  d: DistFn,
  m: MidFn,
): Record<string, number> | null {
  const fw = d(lm[234], lm[454]);
  const fh = d(lm[10], lm[152]);
  const ipd = d(lm[33], lm[263]);
  const browW = d(lm[70], lm[300]);
  const ref = (ipd + browW) / 2;

  if (fw < 0.01 || fh < 0.01 || ipd < 0.01 || browW < 0.01) return null;

  const leC = m(lm[33], lm[133]);
  const reC = m(lm[263], lm[362]);
  const eyeMid = m(leC, reC);

  const r: Record<string, number> = {};

  // === F: Face proportions ===
  r['F01'] = ipd / fw;
  r['F02'] = d(lm[10], eyeMid) / fh;          // 垂直/垂直
  r['F03'] = d(eyeMid, lm[2]) / fh;           // 垂直/垂直
  r['F04'] = d(lm[2], lm[152]) / fh;
  r['F05'] = d(lm[234], lm[1]) / d(lm[1], lm[454]); // 自比率
  r['F06'] = d(lm[10], eyeMid) / d(lm[2], lm[152]); // 自比率
  r['F07'] = Math.abs(lm[1].x - eyeMid.x) / ref;

  // === EL: Left eye ===
  r['EL01'] = d(lm[33], lm[133]) / d(lm[159], lm[145]); // 自比率
  r['EL02'] = d(lm[133], leC) / d(lm[33], leC);          // 自比率
  r['EL03'] = d(lm[133], lm[6]) / ref;        // 水平/ref
  r['EL04'] = d(leC, lm[1]) / fh;             // 垂直/fh
  r['EL05'] = d(lm[159], lm[145]) / ref;
  r['EL06'] = d(lm[33], lm[133]) / ref;       // 水平/ref
  r['EL07'] = d(lm[159], lm[66]) / d(lm[159], lm[145]); // 自比率
  r['EL08'] = d(leC, lm[6]) / ref;

  // === ER: Right eye ===
  r['ER01'] = d(lm[263], lm[362]) / d(lm[386], lm[374]); // 自比率
  r['ER02'] = d(lm[362], reC) / d(lm[263], reC);          // 自比率
  r['ER03'] = d(lm[362], lm[6]) / ref;
  r['ER04'] = d(reC, lm[1]) / fh;             // 垂直/fh
  r['ER05'] = d(lm[386], lm[374]) / ref;
  r['ER06'] = d(lm[263], lm[362]) / ref;
  r['ER07'] = d(lm[386], lm[296]) / d(lm[386], lm[374]); // 自比率
  r['ER08'] = d(reC, lm[6]) / ref;

  // === B: Eyebrows ===
  r['B01'] = d(lm[66], eyeMid) / fh;          // 垂直/fh
  r['B02'] = d(lm[296], eyeMid) / fh;
  r['B03'] = d(lm[66], eyeMid) / d(lm[296], eyeMid); // 自比率
  r['B04'] = d(lm[105], lm[334]) / ref;       // 水平/ref
  r['B05'] = d(lm[70], lm[300]) / ref;
  r['B06'] = d(lm[70], lm[105]) / ref;
  r['B07'] = d(lm[300], lm[334]) / ref;
  r['B08'] = d(lm[70], lm[105]) / d(lm[300], lm[334]); // 自比率

  // === N: Nose ===
  r['N01'] = d(lm[48], lm[278]) / ref;        // 水平/ref
  r['N02'] = d(lm[6], lm[2]) / fh;            // 垂直/fh
  r['N03'] = d(lm[6], lm[4]) / d(lm[6], lm[2]);          // 自比率
  r['N04'] = d(lm[98], lm[327]) / d(lm[48], lm[278]);    // 自比率
  r['N05'] = d(lm[48], lm[6]) / ref;
  r['N06'] = d(lm[1], lm[48]) / d(lm[1], lm[278]);       // 自比率
  r['N07'] = d(lm[48], lm[278]) / d(lm[6], lm[2]);       // 自比率
  r['N08'] = d(lm[6], lm[10]) / fh;           // 垂直/fh
  r['N09'] = d(lm[1], lm[0]) / d(lm[6], lm[2]);          // 自比率
  r['N10'] = d(lm[4], lm[2]) / fh;            // 垂直/fh

  // === M: Mouth (NOT in whitelist) ===
  r['M01'] = d(lm[61], lm[291]) / fw;
  r['M02'] = d(lm[61], lm[291]) / ref;
  r['M03'] = d(lm[0], lm[13]) / d(lm[14], lm[17]);
  r['M04'] = d(lm[0], lm[2]) / fh;
  r['M05'] = d(lm[0], lm[152]) / fh;
  r['M06'] = d(lm[61], lm[152]) / fh;
  r['M07'] = d(lm[291], lm[152]) / fh;
  r['M08'] = d(lm[61], lm[0]) / d(lm[291], lm[0]);
  r['M09'] = d(lm[0], lm[17]) / d(lm[61], lm[291]);
  r['M10'] = d(lm[2], lm[0]) / d(lm[6], lm[2]);

  // === J: Jaw (NOT in whitelist) ===
  r['J01'] = d(lm[132], lm[361]) / fw;
  r['J02'] = d(lm[93], lm[323]) / fw;
  r['J03'] = d(lm[175], lm[396]) / d(lm[132], lm[361]);
  r['J04'] = d(lm[132], lm[152]) / d(lm[361], lm[152]);
  r['J05'] = d(lm[93], lm[132]) / fh;
  r['J06'] = d(lm[175], lm[396]) / d(lm[152], m(lm[175], lm[396]));
  r['J07'] = d(lm[58], lm[288]) / fw;
  r['J08'] = d(lm[93], lm[323]) / ref;

  // === X: Cross-features (X03, X05 保持 ipd — 測試工具驗證 3/3 穩定的版本) ===
  r['X01'] = d(lm[6], lm[2]) / ref;
  r['X02'] = d(eyeMid, lm[4]) / ref;
  r['X03'] = d(eyeMid, lm[6]) / ipd;          // 保持 ipd（測試工具一致）
  r['X04'] = d(lm[48], lm[278]) / d(lm[61], lm[291]);
  r['X05'] = d(lm[105], lm[6]) / ipd;         // 保持 ipd（測試工具一致）
  r['X06'] = d(lm[334], lm[6]) / ref;
  r['X07'] = d(lm[6], eyeMid) / d(lm[6], lm[2]);
  r['X08'] = d(lm[278], lm[6]) / ref;

  return r;
}

function computeAllRatios2d(lm: readonly Landmark3D[]): Record<string, number> | null {
  return computeAllRatiosV17(lm, dist2d, midpoint2d);
}

// ============================================================
// Landmark-based Rotation Estimation（不依賴 MediaPipe matrix）
// ============================================================

function findReferenceWidths(frames: readonly CapturedFrame[]): ReferenceWidths {
  let maxIpd = 0, maxBrowW = 0, maxNoseW = 0, maxInnerE = 0, maxNoseLen = 0, maxFh = 0;
  for (const f of frames) {
    const lm = f.landmarks;
    const ipd = Math.abs(lm[33].x - lm[263].x);
    const bw = Math.abs(lm[70].x - lm[300].x);
    const nw = Math.abs(lm[48].x - lm[278].x);
    const ie = Math.abs(lm[133].x - lm[362].x);
    const nl = Math.abs(lm[6].y - lm[2].y);
    const fh = Math.abs(lm[10].y - lm[152].y);
    if (ipd > maxIpd) maxIpd = ipd;
    if (bw > maxBrowW) maxBrowW = bw;
    if (nw > maxNoseW) maxNoseW = nw;
    if (ie > maxInnerE) maxInnerE = ie;
    if (nl > maxNoseLen) maxNoseLen = nl;
    if (fh > maxFh) maxFh = fh;
  }
  return { ipd: maxIpd, browW: maxBrowW, noseW: maxNoseW, innerE: maxInnerE, noseLen: maxNoseLen, fh: maxFh };
}

function estimateRotation(
  lm: readonly Landmark3D[],
  ref: ReferenceWidths,
): { yaw: number; pitch: number; roll: number } {
  const ipdNow = Math.abs(lm[33].x - lm[263].x);
  const noseW = Math.abs(lm[48].x - lm[278].x);
  const innerE = Math.abs(lm[133].x - lm[362].x);

  const cosYaw1 = Math.min(1, ipdNow / ref.ipd);
  const cosYaw2 = Math.min(1, noseW / ref.noseW);
  const cosYaw3 = Math.min(1, innerE / ref.innerE);
  const cosYaw = cosYaw1 * 0.5 + cosYaw2 * 0.25 + cosYaw3 * 0.25;
  let yaw = Math.acos(Math.max(0, Math.min(1, cosYaw)));

  const eyeMidX = (lm[33].x + lm[263].x) / 2;
  if (lm[1].x < eyeMidX) yaw = -yaw;

  const noseLen = Math.abs(lm[6].y - lm[2].y);
  const cosPitch = Math.min(1, noseLen / ref.noseLen);
  let pitch = Math.acos(Math.max(0, Math.min(1, cosPitch)));
  const noseRatio = (lm[1].y - lm[10].y) / (lm[152].y - lm[10].y);
  if (noseRatio < 0.45) pitch = -pitch;

  const roll = Math.atan2(lm[263].y - lm[33].y, lm[263].x - lm[33].x);

  return { yaw, pitch, roll };
}

function buildRotationMatrixFromAngles(yaw: number, pitch: number, roll: number): RotMatrix {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  return [
    [cy * cr + sy * sp * sr, -cy * sr + sy * sp * cr, sy * cp],
    [cp * sr, cp * cr, -sp],
    [-sy * cr + cy * sp * sr, sy * sr + cy * sp * cr, cy * cp],
  ];
}

// ============================================================
// 3D Triangulation — multi-ray least-squares
// ============================================================

function transposeR(r: RotMatrix): RotMatrix {
  return [
    [r[0][0], r[1][0], r[2][0]],
    [r[0][1], r[1][1], r[2][1]],
    [r[0][2], r[1][2], r[2][2]],
  ];
}

function matVec3(m: RotMatrix, v: readonly number[]): number[] {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function vecLen(v: readonly number[]): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function vecScale(v: readonly number[], s: number): number[] {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function vecSub(a: readonly number[], b: readonly number[]): number[] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vecDot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vecAdd(a: readonly number[], b: readonly number[]): number[] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function pixelToRay(u: number, v: number, fx: number, fy: number, cx: number, cy: number): number[] {
  const dx = (u - cx) / fx;
  const dy = (v - cy) / fy;
  const dz = 1.0;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return [dx / len, dy / len, dz / len];
}

function triangulateMultiRay(rays: readonly { origin: number[]; dir: number[] }[]): number[] | null {
  if (rays.length < 2) return null;

  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];

  for (const ray of rays) {
    const dd = ray.dir;
    const o = ray.origin;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        A[r][c] += (r === c ? 1 : 0) - dd[r] * dd[c];
      }
      let sum = 0;
      for (let c2 = 0; c2 < 3; c2++) {
        sum += ((r === c2 ? 1 : 0) - dd[r] * dd[c2]) * o[c2];
      }
      b[r] += sum;
    }
  }

  const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
            - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
            + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);

  if (Math.abs(det) < 1e-12) return null;
  const inv = 1.0 / det;

  return [
    inv * (b[0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (b[1] * A[2][2] - A[1][2] * b[2]) + A[0][2] * (b[1] * A[2][1] - A[1][1] * b[2])),
    inv * (A[0][0] * (b[1] * A[2][2] - A[1][2] * b[2]) - b[0] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * b[2] - b[1] * A[2][0])),
    inv * (A[0][0] * (A[1][1] * b[2] - b[1] * A[2][1]) - A[0][1] * (A[1][0] * b[2] - b[1] * A[2][0]) + b[0] * (A[1][0] * A[2][1] - A[1][1] * A[2][0])),
  ];
}

/**
 * 真實 3D 重建 — landmark-based rotation + 多幀三角測量
 */
export function buildTrue3DModel(frames: readonly CapturedFrame[]): readonly Landmark3D[] | null {
  const valid = frames.filter((f) => f.landmarks && f.landmarks.length >= 468);
  if (valid.length < 5) return null;

  const refWidths = findReferenceWidths(valid);
  const numLm = valid[0].landmarks.length;
  const fx = 0.9, fy = 0.9, cx = 0.5, cy = 0.5;
  const camDist = 5.0;

  const frameData = valid.map((f) => {
    const rot = estimateRotation(f.landmarks, refWidths);
    return { lm: f.landmarks, R: buildRotationMatrixFromAngles(rot.yaw, rot.pitch, rot.roll) };
  });

  const model: Landmark3D[] = [];

  for (let li = 0; li < numLm; li++) {
    const rays: { origin: number[]; dir: number[] }[] = [];

    for (const fd of frameData) {
      const lm = fd.lm[li];
      const rayDir = pixelToRay(lm.x, lm.y, fx, fy, cx, cy);
      const Ri = transposeR(fd.R);
      let faceRayDir = matVec3(Ri, rayDir);
      const frl = vecLen(faceRayDir);
      faceRayDir = vecScale(faceRayDir, 1.0 / frl);
      const camFacePos = matVec3(Ri, [0, 0, -camDist]);
      rays.push({ origin: camFacePos, dir: faceRayDir });
    }

    const pt = triangulateMultiRay(rays);
    if (pt) {
      model.push({ x: pt[0], y: pt[1], z: pt[2] });
    } else {
      const flm = valid[0].landmarks[li];
      model.push({ x: flm.x - 0.5, y: flm.y - 0.5, z: 0 });
    }
  }

  // IPD 3D 歸一化
  const ipd3d = dist3d(model[33], model[263]);
  if (ipd3d < 0.001) return null;

  const scale = 1.0 / ipd3d;
  return model.map((p) => ({ x: p.x * scale, y: p.y * scale, z: p.z * scale }));
}

// Keep legacy build3DModel for backward compatibility
export { buildTrue3DModel as build3DModel };

// ============================================================
// 3D Feature Computation — 32 features, 6 categories
// ============================================================

export function compute3DFeatures(model: readonly Landmark3D[]): Record<string, number> {
  const m = model;
  const d3n = dist3d;

  function avgPt(...pts: Landmark3D[]): Landmark3D {
    let sx = 0, sy = 0, sz = 0;
    for (const p of pts) { sx += p.x; sy += p.y; sz += p.z; }
    const n = pts.length;
    return { x: sx / n, y: sy / n, z: sz / n };
  }

  const eyeL = m[33], eyeR = m[263], eyeInL = m[133], eyeInR = m[362];
  const eyeMid = avgPt(eyeL, eyeR);
  const earL = m[234], earR = m[454];
  const cheekL = m[93], cheekR = m[323];
  const browL = m[66], browR = m[296];
  const forehead = m[10], chin = m[152];
  const jawL = m[132], jawR = m[361];
  const noseTip = m[1], nasion = m[6], subnasale = m[2];
  const alarL = m[48], alarR = m[278];
  const templeL = m[127], templeR = m[356];
  const foreheadL = m[54], foreheadR = m[284];
  const lipTop = m[0], mouthL = m[61], mouthR = m[291];
  const eyePlaneZ = (eyeL.z + eyeR.z) / 2;
  const earPlaneZ = (earL.z + earR.z) / 2;

  const r: Record<string, number> = {};

  // G: Global Face Shape
  const bizygomatic = d3n(cheekL, cheekR);
  const faceDepth = Math.abs(noseTip.z - earPlaneZ);
  const faceHeight3D = d3n(forehead, chin);
  r['G01_face_width_depth'] = bizygomatic / (faceDepth || 0.01);
  r['G02_face_width_height'] = bizygomatic / (faceHeight3D || 0.01);
  r['G03_upper_lower_face'] = d3n(forehead, eyeMid) / (d3n(eyeMid, chin) || 0.01);
  r['G04_face_depth'] = faceDepth;

  // T: Temple & Cheekbone
  r['T01_temple_width'] = d3n(templeL, templeR);
  r['T02_temple_recess'] = (d3n(templeL, cheekL) + d3n(templeR, cheekR)) / 2;
  const bigonial = d3n(jawL, jawR);
  r['T03_cheek_jaw_ratio'] = bizygomatic / (bigonial || 0.01);
  const cheekMid = avgPt(cheekL, cheekR);
  r['T04_cheekbone_proj'] = d3n(cheekMid, eyeMid);
  r['T05_bizygomatic'] = bizygomatic;

  // E: Eye Orbital
  const browZ = (browL.z + browR.z) / 2;
  r['E01_orbital_depth'] = Math.abs(browZ - eyePlaneZ);
  r['E02_brow_ridge'] = Math.abs(browZ - forehead.z);
  r['E03_orbital_width_L'] = d3n(eyeL, eyeInL);
  r['E04_orbital_width_R'] = d3n(eyeR, eyeInR);
  r['E05_intercanthal'] = d3n(eyeInL, eyeInR);
  r['E06_orbital_nasion_L'] = d3n(eyeInL, nasion);
  r['E07_orbital_nasion_R'] = d3n(eyeInR, nasion);

  // N: Nasal 3D
  r['N01_nose_protrusion'] = Math.abs(noseTip.z - eyePlaneZ);
  r['N02_nasion_depth'] = Math.abs(nasion.z - eyePlaneZ);
  // Bridge curvature
  const ntVec = [subnasale.x - nasion.x, subnasale.y - nasion.y, subnasale.z - nasion.z];
  const nbVec = [m[4].x - nasion.x, m[4].y - nasion.y, m[4].z - nasion.z];
  const ntLen = vecLen(ntVec);
  if (ntLen > 0.001) {
    const ntDir = vecScale(ntVec, 1 / ntLen);
    const projLen = vecDot(nbVec, ntDir);
    const projPt = vecScale(ntDir, projLen);
    r['N03_bridge_curvature'] = vecLen(vecSub(nbVec, projPt));
  } else {
    r['N03_bridge_curvature'] = 0;
  }
  r['N04_nose_length_3d'] = d3n(nasion, subnasale);
  r['N05_alar_width_3d'] = d3n(alarL, alarR);
  r['N06_nose_lip_depth'] = Math.abs(noseTip.z - lipTop.z);
  r['N07_alar_angle'] = d3n(avgPt(alarL, alarR), nasion);

  // F: Forehead & Chin
  r['F01_forehead_curve'] = Math.abs(forehead.z - (foreheadL.z + foreheadR.z) / 2);
  r['F02_chin_protrusion'] = Math.abs(chin.z - eyePlaneZ);
  r['F03_jaw_angle'] = (d3n(chin, jawL) + d3n(chin, jawR)) / 2;
  r['F04_bigonial'] = bigonial;
  r['F05_face_side'] = (d3n(cheekL, earL) + d3n(cheekR, earR)) / 2;

  // A: Asymmetry
  r['A01_cheek_asymm'] = Math.abs(cheekL.z - cheekR.z);
  r['A02_orbital_asymm'] = Math.abs((browL.z - eyeL.z) - (browR.z - eyeR.z));
  r['A03_jaw_asymm'] = Math.abs(d3n(chin, jawL) - d3n(chin, jawR));
  r['A04_mouth_asymm'] = Math.abs(d3n(noseTip, mouthL) - d3n(noseTip, mouthR));

  return r;
}

// ============================================================
// Public API
// ============================================================

export function computeBoneRatios(
  landmarks: readonly Landmark3D[],
  binWidth: number = DEFAULT_BIN_WIDTH,
): readonly BoneRatioResult[] {
  const allRatios = computeAllRatios2d(landmarks);
  if (!allRatios) return [];

  return STABLE_RATIO_WHITELIST.map((id) => {
    const value = allRatios[id] ?? 0;
    return { id, value, binIndex: quantizeBin(value, binWidth), stable: id in allRatios };
  });
}

export function computeMedianBins(
  multiFrameLandmarks: readonly (readonly Landmark3D[])[],
  binWidth: number = DEFAULT_BIN_WIDTH,
): ReadonlyMap<string, number> {
  const ratioSets = multiFrameLandmarks
    .map((lm) => computeAllRatios2d(lm))
    .filter((r): r is Record<string, number> => r !== null);

  if (ratioSets.length < 2) return new Map();

  const bins = new Map<string, number>();
  for (const id of STABLE_RATIO_WHITELIST) {
    const vals = ratioSets.map((s) => s[id]).filter((v): v is number => v !== undefined);
    if (vals.length >= 2) {
      bins.set(id, quantizeBin(median(vals), binWidth));
    }
  }
  return bins;
}

/**
 * 選取嚴格正面幀 — |yaw| < 0.05 AND pitch 42~58%
 */
export function selectStrictFrontalFrames(
  frames: readonly CapturedFrame[],
  maxFrames: number = 20,
): readonly CapturedFrame[] {
  let center = frames.filter((f) => {
    if (!f.yaw || Math.abs(f.yaw) >= 0.05) return false;
    const noseY = f.landmarks[1].y;
    const topY = f.landmarks[10].y;
    const botY = f.landmarks[152].y;
    const noseRatio = (noseY - topY) / (botY - topY);
    return noseRatio > 0.42 && noseRatio < 0.58;
  });

  if (center.length < 8) {
    center = frames.filter((f) => f.yaw !== undefined && Math.abs(f.yaw!) < 0.08);
  }

  return [...center]
    .sort((a, b) => Math.abs(a.yaw!) - Math.abs(b.yaw!))
    .slice(0, maxFrames);
}

/**
 * v17 唯一 Face Structure ID（註冊用）
 *
 * 同時計算 2D + 3D + Combined hash
 */
export async function computeStructuralId(
  frames: readonly CapturedFrame[],
): Promise<FaceStructureIdResult> {
  // Step 1: 嚴格正面篩選 → 2D median bins
  const frontalFrames = selectStrictFrontalFrames(frames);
  if (frontalFrames.length < 3) {
    throw new Error('Not enough frontal frames for 2D ID');
  }

  const frontalBins = computeMedianBins(frontalFrames.map((f) => f.landmarks));

  // Step 2: 2D hash
  const hash2DParts: string[] = [];
  for (const id of STABLE_RATIO_WHITELIST) {
    const bin = frontalBins.get(id);
    if (bin !== undefined) hash2DParts.push(`${id}:${bin}`);
  }
  const hash2D = await sha256hex(hash2DParts.join('|'));

  // Step 3: 真 3D 三角測量
  const model3D = buildTrue3DModel(frames);
  let hash3D = '';
  let hashCombined = '';
  const bins3D = new Map<string, number>();

  if (model3D) {
    const features3D = compute3DFeatures(model3D);

    // Step 4: 3D bins + hash
    const hash3DParts: string[] = [];
    for (const fk of STABLE_3D_FEATURES) {
      const val = features3D[fk];
      if (val !== undefined) {
        const bin = quantizeBin(val, DEFAULT_BIN_WIDTH);
        bins3D.set(fk, bin);
        hash3DParts.push(`${fk}:${bin}`);
      }
    }
    hash3D = await sha256hex(hash3DParts.join('|'));

    // Step 5: Combined hash
    hashCombined = await sha256hex(hash2DParts.join('|') + '||' + hash3DParts.join('|'));
  }

  return {
    hashes: { hash2D, hash3D, hashCombined },
    frontalBins,
    bins3D,
    model3D,
    stableCount2D: hash2DParts.length,
    stableCount3D: bins3D.size,
  };
}

export async function computeAccountKey(faceHash: string, pin: string): Promise<string> {
  return sha256hex(`${faceHash}:${pin}`);
}

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
  return { matchCount, totalCompared, matchRate, passed: matchRate >= LOGIN_MATCH_THRESHOLD, details };
}

// ============================================================
// Image Normalization (kept for pHash compatibility)
// ============================================================

export function toGrayscale(img: ImageData): GrayImage {
  const px = img.data;
  const n = img.width * img.height;
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
  }
  return { data: gray, width: img.width, height: img.height };
}

export function histogramEqualize(g: GrayImage): GrayImage {
  const d = g.data;
  const n = d.length;
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[d[i]]++;
  const cdf = new Uint32Array(256);
  cdf[0] = hist[0];
  for (let i = 1; i < 256; i++) cdf[i] = cdf[i - 1] + hist[i];
  let cdfMin = 0;
  for (let i = 0; i < 256; i++) { if (cdf[i] > 0) { cdfMin = cdf[i]; break; } }
  const out = new Uint8Array(n);
  const scale = 255 / (n - cdfMin || 1);
  for (let i = 0; i < n; i++) out[i] = Math.round((cdf[d[i]] - cdfMin) * scale);
  return { data: out, width: g.width, height: g.height };
}

export function applyFaceMask(g: GrayImage): GrayImage {
  const { data: d, width: w, height: h } = g;
  const out = new Uint8Array(d.length);
  const cx2 = w / 2, cy2 = h * 68 / 112, rx = w * 40 / 112, ry = h * 44 / 112;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx2) / rx, dy = (y - cy2) / ry;
      out[y * w + x] = (dx * dx + dy * dy <= 1.0) ? d[y * w + x] : 128;
    }
  }
  return { data: out, width: w, height: h };
}

export function normalizeAlignedFace(alignedImg: ImageData): GrayImage {
  return applyFaceMask(histogramEqualize(toGrayscale(alignedImg)));
}

export function computePHash4x4(gray: GrayImage): PHash {
  const INPUT_SIZE = 32;
  const DCT_SIZE = 4;
  const small = new Float64Array(INPUT_SIZE * INPUT_SIZE);
  const scX = gray.width / INPUT_SIZE, scY = gray.height / INPUT_SIZE;
  for (let y = 0; y < INPUT_SIZE; y++) {
    for (let x = 0; x < INPUT_SIZE; x++) {
      let sum = 0, count = 0;
      const y0 = Math.floor(y * scY), y1 = Math.min(Math.floor((y + 1) * scY), gray.height);
      const x0 = Math.floor(x * scX), x1 = Math.min(Math.floor((x + 1) * scX), gray.width);
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) { sum += gray.data[sy * gray.width + sx]; count++; }
      small[y * INPUT_SIZE + x] = count > 0 ? sum / count : 0;
    }
  }
  const dctOut = new Float64Array(INPUT_SIZE * INPUT_SIZE);
  for (let v = 0; v < INPUT_SIZE; v++) for (let u = 0; u < INPUT_SIZE; u++) {
    let s = 0;
    for (let y = 0; y < INPUT_SIZE; y++) for (let x = 0; x < INPUT_SIZE; x++)
      s += small[y * INPUT_SIZE + x] * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * INPUT_SIZE)) * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * INPUT_SIZE));
    dctOut[v * INPUT_SIZE + u] = 0.25 * (u === 0 ? 1 / Math.sqrt(2) : 1) * (v === 0 ? 1 / Math.sqrt(2) : 1) * s;
  }
  const coeffs: number[] = [];
  for (let v = 0; v < DCT_SIZE; v++) for (let u = 0; u < DCT_SIZE; u++) { if (u === 0 && v === 0) continue; coeffs.push(dctOut[v * INPUT_SIZE + u]); }
  const sorted = [...coeffs].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const bits = coeffs.map((c) => (c > med ? '1' : '0')).join('');
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.substring(i, i + 4) || '0', 2).toString(16);
  return { bits, hex, nBits: coeffs.length };
}
