/**
 * Locality-Sensitive Hashing (LSH) for Behavior Fingerprint
 *
 * LSH 的核心概念：
 * - 相似的輸入向量會產生相似的 hash
 * - 不同於傳統 hash（微小差異 → 完全不同的 hash）
 * - 用於跨 session 比對同一人的行為特徵
 *
 * 實作方式：Random Hyperplane LSH
 * 1. 生成多個隨機超平面（hyperplane）
 * 2. 對於每個超平面，判斷向量在超平面的哪一側
 * 3. 同側 = 1，異側 = 0
 * 4. 組合所有位元形成 hash
 *
 * 相似的向量在大多數超平面上會落在同一側
 * → 產生相似的 hash（只有少數位元不同）
 */

// ============================================================================
// Types
// ============================================================================

/** LSH 配置 */
export interface LSHConfig {
  /** 特徵向量維度 */
  dimensions: number;
  /** hash 位元數（超平面數量） */
  numBits: number;
  /** 隨機種子（用於重現相同的超平面） */
  seed: number;
}

/** LSH Hash 結果 */
export interface LSHHashResult {
  /** 二進位 hash 字串 (e.g., "10110101...") */
  binaryHash: string;
  /** 十六進位 hash 字串 (e.g., "b5a3...") */
  hexHash: string;
  /** 原始特徵向量 */
  featureVector: number[];
  /** 特徵名稱對應 */
  featureNames: string[];
}

/** 比對結果 */
export interface LSHCompareResult {
  /** 漢明距離（不同位元數） */
  hammingDistance: number;
  /** 相似度 (0-1)，1 = 完全相同 */
  similarity: number;
  /** 是否可能是同一人 */
  isSamePerson: boolean;
  /** 詳細說明 */
  details: string;
}

// ============================================================================
// LSH Core Implementation
// ============================================================================

/**
 * 簡易的 seeded PRNG (Mulberry32)
 * 用於生成可重現的隨機超平面
 */
function mulberry32(seed: number): () => number {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * 生成隨機超平面
 * 每個超平面是一個 n 維向量
 */
function generateHyperplanes(config: LSHConfig): number[][] {
  const random = mulberry32(config.seed);
  const hyperplanes: number[][] = [];

  for (let i = 0; i < config.numBits; i++) {
    const plane: number[] = [];
    for (let j = 0; j < config.dimensions; j++) {
      // 使用標準正態分佈（Box-Muller 轉換）
      const u1 = random();
      const u2 = random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      plane.push(z);
    }
    hyperplanes.push(plane);
  }

  return hyperplanes;
}

/**
 * 計算向量與超平面的內積
 * 內積 > 0 表示在超平面的正側，< 0 表示負側
 */
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * 計算 LSH Hash
 */
export function computeLSHHash(
  featureVector: number[],
  featureNames: string[],
  config: LSHConfig
): LSHHashResult {
  // 驗證向量維度
  if (featureVector.length !== config.dimensions) {
    throw new Error(`Feature vector dimension mismatch: expected ${config.dimensions}, got ${featureVector.length}`);
  }

  // 生成超平面（使用固定 seed 確保可重現）
  const hyperplanes = generateHyperplanes(config);

  // 對每個超平面計算 hash bit
  let binaryHash = '';
  for (const plane of hyperplanes) {
    const dot = dotProduct(featureVector, plane);
    binaryHash += dot >= 0 ? '1' : '0';
  }

  // 轉換為十六進位
  const hexHash = binaryToHex(binaryHash);

  return {
    binaryHash,
    hexHash,
    featureVector,
    featureNames,
  };
}

/**
 * 二進位字串轉十六進位
 */
function binaryToHex(binary: string): string {
  // 補齊到 4 的倍數
  const padded = binary.padStart(Math.ceil(binary.length / 4) * 4, '0');

  let hex = '';
  for (let i = 0; i < padded.length; i += 4) {
    const chunk = padded.slice(i, i + 4);
    hex += parseInt(chunk, 2).toString(16);
  }

  return hex;
}

/**
 * 計算漢明距離（不同位元數）
 */
export function hammingDistance(hash1: string, hash2: string): number {
  if (hash1.length !== hash2.length) {
    throw new Error('Hash length mismatch');
  }

  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] !== hash2[i]) {
      distance++;
    }
  }

  return distance;
}

/**
 * 比較兩個 LSH Hash
 *
 * LSH 相似度說明：
 * - 32 bits hash，每個 bit 有 50% 機率相同（隨機情況）
 * - 同一人的行為特徵相似，大部分 bits 應該相同
 * - 閾值 0.65 = 允許 ~11 個 bits 不同（32 * 0.35）
 * - 這對於行為變異是合理的容忍度
 */
export function compareLSHHash(
  hash1: LSHHashResult,
  hash2: LSHHashResult,
  threshold: number = 0.65  // 調低閾值：同一人行為有自然變異
): LSHCompareResult {
  const distance = hammingDistance(hash1.binaryHash, hash2.binaryHash);
  const similarity = 1 - (distance / hash1.binaryHash.length);
  const isSamePerson = similarity >= threshold;

  let details = '';
  if (similarity >= 0.85) {
    details = '極高相似度，幾乎確定是同一人';
  } else if (similarity >= 0.75) {
    details = '高相似度，很可能是同一人';
  } else if (similarity >= 0.65) {
    details = '中等相似度，可能是同一人';
  } else if (similarity >= 0.55) {
    details = '低相似度，可能不是同一人';
  } else {
    details = '極低相似度，幾乎確定不是同一人';
  }

  return {
    hammingDistance: distance,
    similarity,
    isSamePerson,
    details,
  };
}

// ============================================================================
// Behavior Fingerprint → LSH Feature Vector
// ============================================================================

import type { PinBehaviorFingerprint } from './behaviorFingerprint';

/**
 * PIN 行為指紋的 LSH 配置 (Phase 25 升級: 8→20 維, 32→64 bit)
 *
 * 特徵向量 (20 維):
 *  1. 按鍵持續時間平均值     9. 間隔比率平均        17. Y 位置漂移
 *  2. 按鍵持續時間 CV       10. 間隔比率 CV         18. 鍵對轉換平均
 *  3. 按鍵間隔平均值        11. 持續時間偏態        19. 鍵對轉換 CV
 *  4. 按鍵間隔 CV           12. 觸控旋轉角度平均    20. 加速度計
 *  5. 觸控面積平均值        13. 觸控旋轉角度 CV
 *  6. 觸控面積 CV           14. 按壓力度平均
 *  7. 錯誤率                15. 按壓力度 CV
 *  8. 總輸入時間            16. X 位置漂移
 */
export const PIN_LSH_CONFIG: LSHConfig = {
  dimensions: 20,
  numBits: 64,  // 64 位 hash（Phase 25 升級）
  seed: 20260312,  // 新種子（維度變更需重新生成超平面）
};

export const PIN_FEATURE_NAMES = [
  'durationMean',           //  1
  'durationCV',             //  2
  'intervalMean',           //  3
  'intervalCV',             //  4
  'touchAreaMean',          //  5
  'touchAreaCV',            //  6
  'errorRate',              //  7
  'totalDuration',          //  8
  'intervalRatioMean',      //  9
  'intervalRatioCV',        // 10
  'holdTimeSkewness',       // 11
  'rotationAngleMean',      // 12
  'rotationAngleCV',        // 13
  'forceMean',              // 14
  'forceCV',                // 15
  'positionDriftX',         // 16
  'positionDriftY',         // 17
  'transitionMean',         // 18
  'transitionCV',           // 19
  'accelerometerMagnitude', // 20
];

/**
 * 正規化函數
 * 將值映射到 [-1, 1] 範圍
 */
function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0;
  // 映射到 [0, 1]，然後轉換到 [-1, 1]
  const normalized = (value - min) / (max - min);
  return normalized * 2 - 1;
}

/**
 * 從 PIN 行為指紋提取 LSH 特徵向量 (Phase 25: 20 維)
 *
 * 正規化參數基於實際觀察值收窄範圍，增加敏感度。
 * 無數據的維度（如加速度計不可用）填 0，不影響其他維度。
 */
export function extractPinLSHFeatures(fingerprint: PinBehaviorFingerprint): number[] {
  const { timing, touchArea, errorPattern, rhythm, touchPhysics, keyTransition, motion } = fingerprint;

  // 計算觸控面積的變異係數
  const touchAreaCV = touchArea.avgRadius > 0
    ? Math.sqrt(touchArea.radiusVariance) / touchArea.avgRadius
    : 0;

  // 計算按鍵持續時間的變異係數
  const durationCV = timing.durationMean > 0
    ? timing.durationStdDev / timing.durationMean
    : 0;

  // 構建特徵向量（20 維）
  const features: number[] = [
    //  1. 按鍵持續時間平均值 (30-150ms)
    normalize(timing.durationMean, 30, 150),
    //  2. 按鍵持續時間 CV (0.2-1.0)
    normalize(durationCV, 0.2, 1.0),
    //  3. 按鍵間隔平均值 (200-600ms)
    normalize(timing.intervalMean, 200, 600),
    //  4. 按鍵間隔 CV (0.1-0.4)
    normalize(timing.intervalCV, 0.1, 0.4),
    //  5. 觸控面積平均值 (15-35)
    normalize(touchArea.avgRadius, 15, 35),
    //  6. 觸控面積 CV (0.1-0.5)
    normalize(touchAreaCV, 0.1, 0.5),
    //  7. 錯誤率 (0-1)
    Math.min(1, errorPattern.errorRate),
    //  8. 總輸入時間 (2000-6000ms)
    normalize(timing.totalDuration, 2000, 6000),

    // === Phase 25 新增維度 ===

    //  9. 間隔比率平均 (0.5-2.0，1.0=等速)
    normalize(rhythm.intervalRatioMean, 0.5, 2.0),
    // 10. 間隔比率 CV (0.1-0.8)
    normalize(rhythm.intervalRatioCV, 0.1, 0.8),
    // 11. 按鍵持續時間偏態 (-2 到 2)
    normalize(rhythm.holdTimeSkewness, -2, 2),
    // 12. 觸控旋轉角度平均 (0-180 度)
    normalize(touchPhysics.rotationAngleMean, 0, 180),
    // 13. 觸控旋轉角度 CV (0-1)
    normalize(touchPhysics.rotationAngleCV, 0, 1),
    // 14. 按壓力度平均 (0-1)
    normalize(touchPhysics.forceMean, 0, 1),
    // 15. 按壓力度 CV (0-1)
    normalize(touchPhysics.forceCV, 0, 1),
    // 16. X 軸位置漂移 (-100 到 100 px)
    normalize(touchPhysics.positionDriftX, -100, 100),
    // 17. Y 軸位置漂移 (-200 到 200 px)
    normalize(touchPhysics.positionDriftY, -200, 200),
    // 18. 鍵對轉換時間平均 (50-400ms)
    normalize(keyTransition.transitionMean, 50, 400),
    // 19. 鍵對轉換時間 CV (0.1-0.6)
    normalize(keyTransition.transitionCV, 0.1, 0.6),
    // 20. 加速度計平均（0=無數據，0.5-3.0 正常持握）
    normalize(motion.accelerometerMagnitude, 0, 3),
  ];

  // 確保所有值在 [-1, 1] 範圍內
  return features.map(f => Math.max(-1, Math.min(1, f)));
}

/**
 * 從 PIN 行為指紋計算 LSH Hash
 */
export function computePinLSHHash(fingerprint: PinBehaviorFingerprint): LSHHashResult {
  const features = extractPinLSHFeatures(fingerprint);
  return computeLSHHash(features, PIN_FEATURE_NAMES, PIN_LSH_CONFIG);
}

// ============================================================================
// Formatting for Display
// ============================================================================

/**
 * 格式化 LSH Hash 結果供顯示
 */
export function formatLSHHashForDisplay(hash: LSHHashResult): string {
  const lines: string[] = [];

  lines.push('=== LSH Hash ===');
  lines.push(`Hex: ${hash.hexHash}`);
  lines.push(`Binary: ${hash.binaryHash}`);
  lines.push(`Bits: ${hash.binaryHash.length}`);
  lines.push('');
  lines.push('特徵向量:');
  hash.featureNames.forEach((name, i) => {
    lines.push(`  ${name}: ${hash.featureVector[i].toFixed(4)}`);
  });

  return lines.join('\n');
}

/**
 * 格式化比較結果供顯示
 */
export function formatCompareResultForDisplay(result: LSHCompareResult): string {
  const lines: string[] = [];

  lines.push('=== LSH 比對結果 ===');
  lines.push(`漢明距離: ${result.hammingDistance} bits`);
  lines.push(`相似度: ${(result.similarity * 100).toFixed(1)}%`);
  lines.push(`判定: ${result.isSamePerson ? '可能是同一人 ✓' : '可能不是同一人 ✗'}`);
  lines.push(`詳情: ${result.details}`);

  return lines.join('\n');
}
