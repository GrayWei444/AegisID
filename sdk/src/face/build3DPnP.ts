/**
 * AegisID v20 — PnP-based 3D Face Reconstruction
 *
 * 取代 v17 buildTrue3DModel（landmark-rotation + multi-ray）的 v39 PnP 演算法。
 * 來源：tools/face-id-test.html buildPnPModel（v39, 2026-04 後期）
 *
 * 流程：
 *   1. 每幀對 MediaPipe canonical face model 跑 Perspective-n-Point Gauss-Newton 解 R, T
 *   2. R 從 landmark-based YPR 初始化（避免大 yaw 時 GN 發散）
 *   3. 多射線三角測量：每個 landmark 的所有有效幀 ray → least-squares 求 3D 點
 *   4. tkCanonicalize：對齊軸 + 反射修正 + EOD（eye-outer distance）正規化
 *
 * 為什麼比 v17 好：
 *   - v17 假設 orthographic（不考慮透視），大 yaw 時 IPD 會被透視壓縮 → 推算錯
 *   - v20 PnP 用真實 perspective camera model，每幀位姿從 canonical face 推得精準
 *   - PnP 收斂失敗的幀自動丟棄（< PNP_ERR_THRESH=0.05）
 */

import { CANONICAL_FACE_468 } from './canonicalFace468';
import type { Landmark3D, CapturedFrame } from './structuralId';

// ============================================================================
// Camera intrinsics (normalized image coords 0..1)
// ============================================================================

const CAM_FX = 0.9;
const CAM_FY = 0.9;
const CAM_CX = 0.5;
const CAM_CY = 0.5;

const CANON_EYE_OUTER_CM = 8.8918;
const PNP_ERR_THRESH = 0.05;

// ============================================================================
// Reference widths across frames (for yaw normalization)
// ============================================================================

interface RefWidths {
  ipd: number;
  noseW: number;
  innerE: number;
  browW: number;
  jawW: number;
  noseLen: number;
  fh: number;
}

function findReferenceWidths3D(frames: readonly Float32Array[]): RefWidths {
  let maxIpd = 0, maxNoseW = 0, maxInnerE = 0, maxBrowW = 0, maxJawW = 0, maxNoseLen = 0, maxFh = 0;
  for (const lm of frames) {
    const ipd = Math.abs(lm[33 * 3] - lm[263 * 3]);
    const noseW = Math.abs(lm[129 * 3] - lm[358 * 3]);
    const innerE = Math.abs(lm[133 * 3] - lm[362 * 3]);
    const browW = Math.abs(lm[70 * 3] - lm[300 * 3]);
    const jawW = Math.abs(lm[172 * 3] - lm[397 * 3]);
    const noseLen = Math.abs(lm[6 * 3 + 1] - lm[2 * 3 + 1]);
    const fh = Math.abs(lm[10 * 3 + 1] - lm[152 * 3 + 1]);
    if (ipd > maxIpd) maxIpd = ipd;
    if (noseW > maxNoseW) maxNoseW = noseW;
    if (innerE > maxInnerE) maxInnerE = innerE;
    if (browW > maxBrowW) maxBrowW = browW;
    if (jawW > maxJawW) maxJawW = jawW;
    if (noseLen > maxNoseLen) maxNoseLen = noseLen;
    if (fh > maxFh) maxFh = fh;
  }
  return { ipd: maxIpd, noseW: maxNoseW, innerE: maxInnerE, browW: maxBrowW, jawW: maxJawW, noseLen: maxNoseLen, fh: maxFh };
}

// ============================================================================
// Rotation estimation (multi-signal yaw direction voting)
// ============================================================================

function estimateRotationV2(lm: Float32Array, ref: RefWidths): { yaw: number; pitch: number; roll: number } {
  const ipdNow = Math.abs(lm[33 * 3] - lm[263 * 3]);
  const noseWNow = Math.abs(lm[129 * 3] - lm[358 * 3]);
  const innerENow = Math.abs(lm[133 * 3] - lm[362 * 3]);
  const browWNow = Math.abs(lm[70 * 3] - lm[300 * 3]);
  const jawWNow = Math.abs(lm[172 * 3] - lm[397 * 3]);

  const cos1 = Math.min(1, ipdNow / ref.ipd);
  const cos2 = Math.min(1, noseWNow / ref.noseW);
  const cos3 = Math.min(1, innerENow / ref.innerE);
  const cos4 = Math.min(1, browWNow / ref.browW);
  const cos5 = Math.min(1, jawWNow / ref.jawW);
  const coss = [cos1, cos2, cos3, cos4, cos5].sort((a, b) => a - b);
  const cosYaw = coss[2];
  let yaw = Math.acos(Math.max(0, Math.min(1, cosYaw)));

  const eyeMidX = (lm[33 * 3] + lm[263 * 3]) / 2;
  const noseX = lm[1 * 3];
  const Ledge = lm[234 * 3], Redge = lm[454 * 3];
  const LcheekDist = Math.abs(lm[116 * 3] - noseX);
  const RcheekDist = Math.abs(lm[345 * 3] - noseX);
  const LsideWidth = Math.abs(noseX - Ledge);
  const RsideWidth = Math.abs(Redge - noseX);

  let votes = 0;
  if (noseX > eyeMidX) votes++; else votes--;
  if (RsideWidth > LsideWidth) votes--; else votes++;
  if (RcheekDist > LcheekDist) votes--; else votes++;
  const LeyeToNose = Math.abs(lm[33 * 3] - noseX);
  const ReyeToNose = Math.abs(lm[263 * 3] - noseX);
  if (ReyeToNose < LeyeToNose) votes++; else votes--;

  if (votes < 0) yaw = -yaw;

  const noseLenNow = Math.abs(lm[6 * 3 + 1] - lm[2 * 3 + 1]);
  const cosPitch = Math.min(1, noseLenNow / ref.noseLen);
  let pitch = Math.acos(Math.max(0, Math.min(1, cosPitch)));
  const noseYRatio = (lm[1 * 3 + 1] - lm[10 * 3 + 1]) / (lm[152 * 3 + 1] - lm[10 * 3 + 1] + 1e-9);
  if (noseYRatio < 0.45) pitch = -pitch;

  const roll = Math.atan2(lm[263 * 3 + 1] - lm[33 * 3 + 1], lm[263 * 3] - lm[33 * 3]);
  return { yaw, pitch, roll };
}

type Mat3 = number[][]; // [3][3]

function buildRotMatYPR(yaw: number, pitch: number, roll: number): Mat3 {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  return [
    [cy * cr + sy * sp * sr, -cy * sr + sy * sp * cr, sy * cp],
    [cp * sr, cp * cr, -sp],
    [-sy * cr + cy * sp * sr, sy * sr + cy * sp * cr, cy * cp],
  ];
}

function transposeR3(R: Mat3): Mat3 {
  return [
    [R[0][0], R[1][0], R[2][0]],
    [R[0][1], R[1][1], R[2][1]],
    [R[0][2], R[1][2], R[2][2]],
  ];
}

function mulRV3(R: Mat3, v: number[]): number[] {
  return [
    R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
    R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
    R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
  ];
}

function mulR3R3(A: Mat3, B: Mat3): Mat3 {
  const C: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
  }
  return C;
}

function rodrigues3(d: number[]): Mat3 {
  const th = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
  if (th < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const c = Math.cos(th), s = Math.sin(th);
  const x = d[0] / th, y = d[1] / th, z = d[2] / th;
  const C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}

// ============================================================================
// Camera ray + triangulation
// ============================================================================

function pixelToRay3(u: number, v: number, fx = CAM_FX, fy = CAM_FY): number[] {
  const dx = (u - CAM_CX) / fx;
  const dy = (v - CAM_CY) / fy;
  const dz = 1.0;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return [dx / len, dy / len, dz / len];
}

interface Ray { origin: number[]; dir: number[]; }

function triangulateRays(rays: Ray[]): number[] | null {
  if (rays.length < 2) return null;
  const A: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (const ray of rays) {
    const d = ray.dir, o = ray.origin;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        A[r][c] += (r === c ? 1 : 0) - d[r] * d[c];
      }
      let sum = 0;
      for (let c2 = 0; c2 < 3; c2++) {
        sum += ((r === c2 ? 1 : 0) - d[r] * d[c2]) * o[c2];
      }
      b[r] += sum;
    }
  }
  const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
            - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
            + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return [
    inv * (b[0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (b[1] * A[2][2] - A[1][2] * b[2]) + A[0][2] * (b[1] * A[2][1] - A[1][1] * b[2])),
    inv * (A[0][0] * (b[1] * A[2][2] - A[1][2] * b[2]) - b[0] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * b[2] - b[1] * A[2][0])),
    inv * (A[0][0] * (A[1][1] * b[2] - b[1] * A[2][1]) - A[0][1] * (A[1][0] * b[2] - b[1] * A[2][0]) + b[0] * (A[1][0] * A[2][1] - A[1][1] * A[2][0])),
  ];
}

// ============================================================================
// 6×6 linear solve (Gaussian elimination + partial pivoting)
// ============================================================================

function solve6x6(A: Float64Array, b: Float64Array): number[] | null {
  const n = 6;
  const M = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i * (n + 1) + j] = A[i * n + j];
    M[i * (n + 1) + n] = b[i];
  }
  for (let k = 0; k < n; k++) {
    let maxV = Math.abs(M[k * (n + 1) + k]), maxR = k;
    for (let r = k + 1; r < n; r++) {
      const v = Math.abs(M[r * (n + 1) + k]);
      if (v > maxV) { maxV = v; maxR = r; }
    }
    if (maxV < 1e-12) return null;
    if (maxR !== k) {
      for (let c = k; c <= n; c++) {
        const tmp = M[k * (n + 1) + c]; M[k * (n + 1) + c] = M[maxR * (n + 1) + c]; M[maxR * (n + 1) + c] = tmp;
      }
    }
    for (let r2 = k + 1; r2 < n; r2++) {
      const factor = M[r2 * (n + 1) + k] / M[k * (n + 1) + k];
      for (let c2 = k; c2 <= n; c2++) {
        M[r2 * (n + 1) + c2] -= factor * M[k * (n + 1) + c2];
      }
    }
  }
  const x = new Array<number>(n);
  for (let i2 = n - 1; i2 >= 0; i2--) {
    let sum = M[i2 * (n + 1) + n];
    for (let j2 = i2 + 1; j2 < n; j2++) sum -= M[i2 * (n + 1) + j2] * x[j2];
    x[i2] = sum / M[i2 * (n + 1) + i2];
  }
  return x;
}

// ============================================================================
// Perspective-n-Point Gauss-Newton solver
// ============================================================================

interface PnPResult {
  R: Mat3;
  T: number[];
  finalErr: number;
  iters: number;
}

function solvePerspectivePnP(
  model3D: Float32Array,
  obs2D: Float32Array,
  Rinit: Mat3,
  Tinit: number[],
  fx: number,
  maxIter = 8,
): PnPResult {
  let R: Mat3 = [Rinit[0].slice(), Rinit[1].slice(), Rinit[2].slice()];
  let T = Tinit.slice();
  const N = 468;
  const FX = fx;
  let finalErr = Infinity;
  let iters = 0;

  for (let it = 0; it < maxIter; it++) {
    iters = it + 1;
    const JtJ = new Float64Array(36);
    const Jtr = new Float64Array(6);
    let sqErr = 0;
    let nValid = 0;

    for (let i = 0; i < N; i++) {
      const px = model3D[i * 3], py = model3D[i * 3 + 1], pz = model3D[i * 3 + 2];
      const Xc = R[0][0] * px + R[0][1] * py + R[0][2] * pz + T[0];
      const Yc = R[1][0] * px + R[1][1] * py + R[1][2] * pz + T[1];
      const Zc = R[2][0] * px + R[2][1] * py + R[2][2] * pz + T[2];
      if (Math.abs(Zc) < 1e-6) continue;

      const invZ = 1 / Zc;
      const uProj = CAM_CX + FX * Xc * invZ;
      const vProj = CAM_CY + FX * Yc * invZ;
      const ru = uProj - obs2D[i * 3];
      const rv = vProj - obs2D[i * 3 + 1];
      sqErr += ru * ru + rv * rv;
      nValid++;

      const c0x = -R[0][1] * pz + R[0][2] * py;
      const c0y = -R[1][1] * pz + R[1][2] * py;
      const c0z = -R[2][1] * pz + R[2][2] * py;
      const c1x =  R[0][0] * pz - R[0][2] * px;
      const c1y =  R[1][0] * pz - R[1][2] * px;
      const c1z =  R[2][0] * pz - R[2][2] * px;
      const c2x = -R[0][0] * py + R[0][1] * px;
      const c2y = -R[1][0] * py + R[1][1] * px;
      const c2z = -R[2][0] * py + R[2][1] * px;

      const duX = FX * invZ, duZ = -FX * Xc * invZ * invZ;
      const dvY = FX * invZ, dvZ = -FX * Yc * invZ * invZ;

      const Ju0 = duX * c0x + duZ * c0z;
      const Ju1 = duX * c1x + duZ * c1z;
      const Ju2 = duX * c2x + duZ * c2z;
      const Ju3 = duX, Ju4 = 0, Ju5 = duZ;
      const Jv0 = dvY * c0y + dvZ * c0z;
      const Jv1 = dvY * c1y + dvZ * c1z;
      const Jv2 = dvY * c2y + dvZ * c2z;
      const Jv3 = 0, Jv4 = dvY, Jv5 = dvZ;

      const Ju = [Ju0, Ju1, Ju2, Ju3, Ju4, Ju5];
      const Jv = [Jv0, Jv1, Jv2, Jv3, Jv4, Jv5];

      for (let a = 0; a < 6; a++) {
        for (let b = 0; b < 6; b++) {
          JtJ[a * 6 + b] += Ju[a] * Ju[b] + Jv[a] * Jv[b];
        }
        Jtr[a] += Ju[a] * ru + Jv[a] * rv;
      }
    }

    if (nValid < 20) { finalErr = Infinity; break; }
    finalErr = Math.sqrt(sqErr / nValid);

    for (let dd = 0; dd < 6; dd++) JtJ[dd * 6 + dd] *= 1.001;
    const negJtr = new Float64Array(6);
    for (let i = 0; i < 6; i++) negJtr[i] = -Jtr[i];
    const delta = solve6x6(JtJ, negJtr);
    if (!delta) break;

    const dR = rodrigues3([delta[0], delta[1], delta[2]]);
    R = mulR3R3(R, dR);
    T = [T[0] + delta[3], T[1] + delta[4], T[2] + delta[5]];

    let dN = 0;
    for (let kk = 0; kk < 6; kk++) dN += delta[kk] * delta[kk];
    if (Math.sqrt(dN) < 1e-7) break;
  }
  return { R, T, finalErr, iters };
}

// ============================================================================
// Canonicalize 3D output (axis alignment + reflection + EOD normalization)
// ============================================================================

function tkCanonicalize(S: Float32Array): Float32Array {
  const P = 478;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < P; i++) { cx += S[i * 3]; cy += S[i * 3 + 1]; cz += S[i * 3 + 2]; }
  cx /= P; cy /= P; cz /= P;

  let axx = S[263 * 3] - S[33 * 3];
  let axy = S[263 * 3 + 1] - S[33 * 3 + 1];
  let axz = S[263 * 3 + 2] - S[33 * 3 + 2];
  const aLen = Math.sqrt(axx * axx + axy * axy + axz * axz) || 1;
  axx /= aLen; axy /= aLen; axz /= aLen;

  let yx = S[152 * 3] - S[1 * 3];
  let yy = S[152 * 3 + 1] - S[1 * 3 + 1];
  let yz = S[152 * 3 + 2] - S[1 * 3 + 2];
  const dot = yx * axx + yy * axy + yz * axz;
  yx -= dot * axx; yy -= dot * axy; yz -= dot * axz;
  const yLen = Math.sqrt(yx * yx + yy * yy + yz * yz) || 1;
  yx /= yLen; yy /= yLen; yz /= yLen;

  let zx = axy * yz - axz * yy;
  let zy = axz * yx - axx * yz;
  let zz = axx * yy - axy * yx;
  const zLen = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1;
  zx /= zLen; zy /= zLen; zz /= zLen;

  const out = new Float32Array(P * 3);
  for (let i = 0; i < P; i++) {
    const X = S[i * 3] - cx, Y = S[i * 3 + 1] - cy, Z = S[i * 3 + 2] - cz;
    out[i * 3] = axx * X + axy * Y + axz * Z;
    out[i * 3 + 1] = yx * X + yy * Y + yz * Z;
    out[i * 3 + 2] = zx * X + zy * Y + zz * Z;
  }

  // Reflection: nose tip should have z > 0
  if (out[1 * 3 + 2] < 0) {
    for (let i = 0; i < P; i++) out[i * 3 + 2] = -out[i * 3 + 2];
  }

  // Normalize by 3D eye-outer distance
  const dx2 = out[263 * 3] - out[33 * 3];
  const dy2 = out[263 * 3 + 1] - out[33 * 3 + 1];
  const dz2 = out[263 * 3 + 2] - out[33 * 3 + 2];
  const eod = Math.sqrt(dx2 * dx2 + dy2 * dy2 + dz2 * dz2);
  if (eod > 1e-9) {
    const inv = 1 / eod;
    for (let i = 0; i < P * 3; i++) out[i] *= inv;
  }
  return out;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * 把 CapturedFrame[] 的 Landmark3D[] 攤平成 Float32Array(478*3) per frame
 */
function flattenFrames(frames: readonly CapturedFrame[]): Float32Array[] {
  const out: Float32Array[] = [];
  for (const f of frames) {
    if (!f.landmarks || f.landmarks.length < 468) continue;
    const N = Math.min(f.landmarks.length, 478);
    const arr = new Float32Array(478 * 3);
    for (let i = 0; i < N; i++) {
      const lm = f.landmarks[i];
      arr[i * 3] = lm.x;
      arr[i * 3 + 1] = lm.y;
      arr[i * 3 + 2] = lm.z;
    }
    out.push(arr);
  }
  return out;
}

/**
 * v20 PnP 3D 重建主入口
 *
 * 1. 每幀：solvePerspectivePnP 解 R, T（從 landmark-based YPR 初始化）
 * 2. 丟掉收斂失敗的幀（finalErr >= PNP_ERR_THRESH）
 * 3. 多射線三角測量：每個 landmark 跨幀 ray → least-squares 3D 點
 * 4. tkCanonicalize：對齊軸 + EOD 正規化
 *
 * @returns 478 個 Landmark3D 點（Y/Z 軸已 canonical 化），或 null 如果幀數不夠
 */
export function buildPnPModel(frames: readonly CapturedFrame[]): readonly Landmark3D[] | null {
  const flat = flattenFrames(frames);
  if (flat.length < 5) return null;

  const P = 478;
  const F = flat.length;
  const ref = findReferenceWidths3D(flat);

  const poses: Array<{ R: Mat3; T: number[] } | null> = new Array(F);
  const validFlags = new Array<boolean>(F);

  for (let f = 0; f < F; f++) {
    const lm = flat[f];
    const uL = lm[263 * 3], uR = lm[33 * 3];
    const vL = lm[263 * 3 + 1], vR = lm[33 * 3 + 1];
    const ipdPx = Math.sqrt((uL - uR) ** 2 + (vL - vR) ** 2);
    const tzInit = ipdPx > 1e-4 ? CAM_FX * CANON_EYE_OUTER_CM / ipdPx : 35.0;
    const uMid = (lm[33 * 3] + lm[263 * 3] + lm[1 * 3]) / 3;
    const vMid = (lm[33 * 3 + 1] + lm[263 * 3 + 1] + lm[1 * 3 + 1]) / 3;
    const Tinit = [(uMid - CAM_CX) * tzInit / CAM_FX, (vMid - CAM_CY) * tzInit / CAM_FX, tzInit];

    const rot = estimateRotationV2(lm, ref);
    const Rinit = buildRotMatYPR(rot.yaw, rot.pitch, rot.roll);

    const res = solvePerspectivePnP(CANONICAL_FACE_468, lm, Rinit, Tinit, CAM_FX, 20);
    poses[f] = { R: res.R, T: res.T };
    validFlags[f] = isFinite(res.finalErr) && res.finalErr < PNP_ERR_THRESH;
  }

  // 多射線三角測量
  const model = new Float32Array(P * 3);
  for (let li = 0; li < P; li++) {
    const rays: Ray[] = [];
    for (let f = 0; f < F; f++) {
      if (!validFlags[f]) continue;
      const lm = flat[f];
      const u = lm[li * 3], v = lm[li * 3 + 1];
      const dirCam = pixelToRay3(u, v, CAM_FX, CAM_FX);
      const pose = poses[f]!;
      const Rt = transposeR3(pose.R);
      const dirFace = mulRV3(Rt, dirCam);
      const dl = Math.sqrt(dirFace[0] ** 2 + dirFace[1] ** 2 + dirFace[2] ** 2) || 1;
      const dirNorm = [dirFace[0] / dl, dirFace[1] / dl, dirFace[2] / dl];
      const camFacePos = mulRV3(Rt, [-pose.T[0], -pose.T[1], -pose.T[2]]);
      rays.push({ origin: camFacePos, dir: dirNorm });
    }
    const pt = rays.length >= 2 ? triangulateRays(rays) : null;
    if (pt) {
      model[li * 3] = pt[0]; model[li * 3 + 1] = pt[1]; model[li * 3 + 2] = pt[2];
    }
  }

  // Canonicalize（軸對齊 + 反射修正 + EOD 正規化）
  const canonical = tkCanonicalize(model);

  // Float32Array → Landmark3D[]
  const out: Landmark3D[] = new Array(P);
  for (let i = 0; i < P; i++) {
    out[i] = { x: canonical[i * 3], y: canonical[i * 3 + 1], z: canonical[i * 3 + 2] };
  }
  return out;
}
