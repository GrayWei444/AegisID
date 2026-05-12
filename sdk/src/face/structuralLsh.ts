/**
 * AegisID Face Structure LSH — 解決「別人/半臉也能登進去」漏洞
 *
 * 核心想法：
 *   - 註冊：登錄正面骨骼比率 → de-mean → 隨機超平面投影 → 128-bit LSH hash
 *   - 登入：再算一次 LSH hash → 漢明距離比對 → 機率匹配（不是 exact bin equality）
 *
 * 為何能擋「別人」：
 *   原本的 matchLoginBins 用 BIN_WIDTH=0.25 量化後 exact equality，
 *   每個 ratio 只剩 2-4 種 bin 值，25 個 ratio 純機率撞中 ≥80% 機會很大。
 *   LSH 直接在 raw 連續值上比，128 bits 提供細緻的角度比對，
 *   不同人的特徵向量角度有顯著差異 → 高漢明距離。
 *
 * 為何能擋「半臉」：
 *   MediaPipe 對被遮的 landmark 會用 3DMM 推測「平均臉」幻覺值。
 *   半臉狀態下，被遮那邊的 ratio 偏向 population mean。
 *   去 mean 後這些 ratio 變成接近 0，與真臉的非 0 z-score 方向偏離 →
 *   多 bit 翻轉 → 漢明距離拉高。
 *
 * 設計選擇：
 *   - de-mean：減去 population mean（POP_MEANS 常數），讓 LSH 量到「個人差異」而非總值
 *   - normalize：除以 typical scale，讓每個 ratio 對 projection 貢獻相當
 *   - 128 bits：在區分性與穩定性之間平衡（同人 ~5-15 bits, 不同人 >25 bits）
 */

import { computeLSHHash, hammingDistance, type LSHConfig } from '../lsh/lshFingerprint';
import { STABLE_RATIO_WHITELIST } from './structuralId';

// ============================================================================
// 常數：population mean / scale 估值
//
// 這些值是基於 v17 ratio 公式的 domain 估值，作為去 mean 的中心。
// 真實 population 數據累積後可重新校準（見 logs/ 與 face-id-test.html）。
// 註：mean/scale 都是「估值」，不要求精確 — 只要同一裝置同一份常數，
// LSH 對相對差異敏感，絕對值偏一點不影響討差距。
// ============================================================================

/**
 * v17 25 個穩定 2D 比率的 population mean 估值
 * 用於 de-mean，使 LSH 量「個人偏差」而非總值
 */
const POP_MEANS: Record<string, number> = {
  // F: Face proportions
  F02: 0.40,  // forehead/face_height
  F03: 0.16,  // eyeMid-noseTip / face_height
  // EL: Left eye
  EL02: 0.62,  // 內眦/外眦 corner ratio
  EL03: 0.48,  // 內眦到鼻樑 / ref
  EL04: 0.32,  // 眼中心到鼻尖 / fh
  EL06: 0.44,  // IPD-half / ref
  EL08: 0.50,  // 眼中心到鼻樑 / ref
  // ER: Right eye
  ER02: 0.62,
  ER03: 0.48,
  ER04: 0.32,
  ER06: 0.44,
  ER08: 0.50,
  // B: Eyebrows
  B01: 0.16,  // 眉/眼中心 / fh
  B02: 0.16,
  B04: 0.62,  // 眉內側距離 / ref
  B05: 0.95,  // 眉外側距離 / ref
  B06: 0.30,  // 眉外側-眉內側 L / ref
  B07: 0.30,  // 眉外側-眉內側 R / ref
  // N: Nose
  N01: 0.46,  // 鼻翼寬 / ref
  N02: 0.18,  // 鼻長 / fh
  N03: 0.42,  // 鼻尖點凸出比
  N04: 0.55,  // 鼻孔/鼻翼寬比
  N10: 0.10,  // 鼻尖 y-跨度 / fh
  // X: Cross
  X03: 0.55,  // eyeMid-nasion / IPD
  X05: 0.30,  // 眉內側-nasion / IPD
};

/**
 * v17 ratio 的 typical scale 估值
 * 用於正規化使每個 ratio 對 LSH projection 的貢獻量級相當
 *
 * 設定原則：scale ≈ 該 ratio 的合理 within-population std × 5
 *           （5 sigma 容忍同人變異）
 */
const POP_SCALES: Record<string, number> = {
  F02: 0.05, F03: 0.04,
  EL02: 0.08, EL03: 0.06, EL04: 0.05, EL06: 0.06, EL08: 0.06,
  ER02: 0.08, ER03: 0.06, ER04: 0.05, ER06: 0.06, ER08: 0.06,
  B01: 0.04, B02: 0.04, B04: 0.08, B05: 0.10, B06: 0.06, B07: 0.06,
  N01: 0.06, N02: 0.04, N03: 0.06, N04: 0.10, N10: 0.03,
  X03: 0.10, X05: 0.06,
};

// ============================================================================
// LSH 配置
// ============================================================================

/**
 * Face Structure LSH — 25 維特徵 → 128 bit hash
 * Seed: 20260509 (新)
 */
export const FACE_STRUCTURE_LSH_CONFIG: LSHConfig = {
  dimensions: STABLE_RATIO_WHITELIST.length, // 25
  numBits: 128,
  seed: 20260509,
};

/**
 * 同人 / 不同人 漢明距離分界
 *
 * 預設值（會在實測後 tune）：
 *   同人 (登入通過):  Hamming ≤ 24 (相似度 ≥ 81%)
 *   不同人 (拒絕):    Hamming > 32 (相似度 ≤ 75%)
 *   中間區暫時當「不確定」並拒絕（保守策略）
 */
export const FACE_LSH_HAMMING_THRESHOLD = 24;
export const FACE_LSH_HAMMING_REJECT = 32;

// ============================================================================
// Public API
// ============================================================================

/**
 * 從 v17 raw ratios（id → 連續值）建構 25 維 LSH 特徵向量
 *
 * 每個 ratio：(value - mean) / scale
 * 缺值用 0 補（投影貢獻為 0）
 */
export function buildLshFeatureVector(rawRatios: Record<string, number>): number[] {
  return STABLE_RATIO_WHITELIST.map((id) => {
    const v = rawRatios[id];
    if (v === undefined || !Number.isFinite(v)) return 0;
    const mean = POP_MEANS[id] ?? 0;
    const scale = POP_SCALES[id] ?? 1;
    return (v - mean) / scale;
  });
}

/**
 * 從 v17 raw ratios 計算 face structure LSH hash
 *
 * @returns binary string (128 bits)
 */
export function computeFaceStructureLsh(rawRatios: Record<string, number>): string {
  const features = buildLshFeatureVector(rawRatios);
  const result = computeLSHHash(features, [...STABLE_RATIO_WHITELIST], FACE_STRUCTURE_LSH_CONFIG);
  return result.binaryHash;
}

/**
 * Face Structure LSH 比對結果
 */
export interface LshMatchResult {
  /** 漢明距離（0~128） */
  readonly hammingDistance: number;
  /** 相似度 (0~1, 1=完全相同) */
  readonly similarity: number;
  /** 是否通過閾值（同人） */
  readonly passed: boolean;
  /** 是否處於「不確定」區間（暫時當不通過） */
  readonly uncertain: boolean;
}

/**
 * 比對兩個 face structure LSH hash
 */
export function matchFaceStructureLsh(
  storedHash: string,
  loginHash: string,
): LshMatchResult {
  if (storedHash.length !== loginHash.length) {
    throw new Error(
      `LSH hash length mismatch: stored=${storedHash.length}, login=${loginHash.length}`,
    );
  }
  const distance = hammingDistance(storedHash, loginHash);
  const similarity = 1 - distance / storedHash.length;
  const passed = distance <= FACE_LSH_HAMMING_THRESHOLD;
  const uncertain = distance > FACE_LSH_HAMMING_THRESHOLD && distance <= FACE_LSH_HAMMING_REJECT;
  return { hammingDistance: distance, similarity, passed, uncertain };
}
