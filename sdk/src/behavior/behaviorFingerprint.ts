import { devLog } from '../utils/devLog';

/**
 * Phase 10: PIN Behavior Fingerprint Service
 *
 * 透過 PIN 輸入的行為特徵，本地偵測模擬器/腳本批量建號
 *
 * 收集的特徵：
 * - 時間特徵：按鍵持續時間、按鍵間隔
 * - 空間特徵：觸控位置、與按鍵中心的偏移
 * - 面積特徵：觸控橢圓的 radiusX/radiusY
 * - 一致性：兩次輸入的相似度
 */

// ============================================================================
// Types
// ============================================================================

/** 單次觸控數據 */
export interface PinTouchData {
  timestamp: number;
  x: number;
  y: number;
  key: string;
  radiusX: number;
  radiusY: number;
  rotationAngle: number;
  force: number;
}

/** 單次按鍵數據 */
export interface PinKeypress {
  key: string;
  touchStart: PinTouchData;
  touchEnd: PinTouchData | null;
  duration: number;
  intervalFromPrevious: number | null;
}

/** 單次 PIN 輸入的原始數據 */
export interface PinInputRawData {
  keypresses: PinKeypress[];        // 有效的按鍵（最終 PIN）
  allKeypresses: PinKeypress[];     // 完整歷史（包含刪除鍵和被刪除的按鍵）
  startTime: number;
  endTime: number;
}

/** 計算後的行為指紋 */
export interface PinBehaviorFingerprint {
  // 時間特徵
  timing: {
    keyDurations: number[];
    keyIntervals: number[];
    totalDuration: number;
    durationMean: number;
    durationStdDev: number;
    intervalMean: number;
    intervalStdDev: number;
    intervalCV: number; // 變異係數 = stdDev / mean
  };

  // 空間特徵
  spatial: {
    touchPositions: { x: number; y: number }[];
    positionOffsets: { dx: number; dy: number }[];
  };

  // 面積特徵
  touchArea: {
    radiusX: number[];
    radiusY: number[];
    avgRadius: number;
    radiusVariance: number;
    hasRealTouchArea: boolean; // 是否有真實觸控面積（非 0/1）
  };

  // Phase 25: 增強維度 — 節奏比率特徵
  rhythm: {
    intervalRatios: number[];          // 相鄰間隔比率 (interval[n+1]/interval[n])
    intervalRatioMean: number;
    intervalRatioCV: number;
    holdTimeSkewness: number;          // 按鍵持續時間偏態
  };

  // Phase 25: 增強維度 — 觸控物理特徵
  touchPhysics: {
    rotationAngleMean: number;         // 觸控旋轉角度平均
    rotationAngleCV: number;
    forceMean: number;                 // 按壓力度平均
    forceCV: number;
    positionDriftX: number;            // X 軸位置漂移（首尾差）
    positionDriftY: number;            // Y 軸位置漂移（首尾差）
  };

  // Phase 25: 增強維度 — 按鍵轉換特徵
  keyTransition: {
    transitionTimes: number[];         // 相鄰鍵對轉換時間
    transitionMean: number;
    transitionCV: number;
  };

  // Phase 25: 增強維度 — 動作感測器
  motion: {
    accelerometerMagnitude: number;    // 加速度計平均值（0 = 無數據）
    hasMotionData: boolean;
  };

  // 兩次輸入的一致性（第二次輸入後計算）- 用於驗證是否為同一人
  consistency: {
    timingCorrelation: number | null;      // 時間節奏相關性 (-1 到 1)
    spatialCorrelation: number | null;     // 位置模式相關性 (0 到 1，越高越相似)
    touchAreaCorrelation: number | null;   // 觸控面積相關性 (0 到 1，越高越相似)
    overallSimilarity: number | null;      // 綜合相似度 (0 到 1，越高越可能是同一人)
  };

  // 錯誤/刪除特徵（用於識別行為模式）
  errorPattern: {
    totalKeystrokes: number;       // 總按鍵次數（包含刪除）
    deleteCount: number;           // 刪除鍵按下次數
    deletedDigits: number;         // 被刪除的數字總數
    errorRate: number;             // 錯誤率 = deleteCount / totalKeystrokes
    correctionPositions: number[]; // 發生刪除的位置（第幾個按鍵後）
    hasMultipleDeletes: boolean;   // 是否有連續刪除
    maxConsecutiveDeletes: number; // 最大連續刪除次數
  };
}

/** 動作感測器數據（由 usePinBehavior 傳入） */
export interface MotionSensorData {
  accelerometerMagnitude: number;
}

/** 模擬器/腳本偵測結果 */
export interface EmulatorDetectionResult {
  score: number; // 0-100，越高越可疑
  isEmulator: boolean;
  isSuspicious: boolean;
  isDifferentPerson: boolean;  // 是否為不同人輸入
  sameProbability: number;     // 同一人的機率 (0-1)
  reasons: string[];
  fingerprint: PinBehaviorFingerprint;
}

// ============================================================================
// Helper Functions
// ============================================================================

/** 計算平均值 */
function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

/** 計算標準差 */
function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const avg = mean(arr);
  const squaredDiffs = arr.map((v) => Math.pow(v - avg, 2));
  return Math.sqrt(mean(squaredDiffs));
}

/** 計算變異係數 */
function coefficientOfVariation(arr: number[]): number {
  const avg = mean(arr);
  if (avg === 0) return 0;
  return stdDev(arr) / avg;
}

/** 計算方差 */
function variance(arr: number[]): number {
  if (arr.length < 2) return 0;
  const avg = mean(arr);
  return mean(arr.map((v) => Math.pow(v - avg, 2)));
}

/** 計算偏態 (skewness) */
function skewness(arr: number[]): number {
  if (arr.length < 3) return 0;
  const avg = mean(arr);
  const std = stdDev(arr);
  if (std === 0) return 0;
  const n = arr.length;
  const sum = arr.reduce((s, v) => s + Math.pow((v - avg) / std, 3), 0);
  return (n / ((n - 1) * (n - 2))) * sum;
}

/** 計算皮爾森相關係數 */
function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return 0;

  const n = x.length;
  const meanX = mean(x);
  const meanY = mean(y);

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const diffX = x[i] - meanX;
    const diffY = y[i] - meanY;
    numerator += diffX * diffY;
    denomX += diffX * diffX;
    denomY += diffY * diffY;
  }

  const denom = Math.sqrt(denomX * denomY);
  if (denom === 0) return 0;

  return numerator / denom;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * 從原始數據計算行為指紋
 */
export function calculateFingerprint(
  rawData: PinInputRawData,
  previousFingerprint?: PinBehaviorFingerprint,
  motionData?: MotionSensorData
): PinBehaviorFingerprint {
  const { keypresses } = rawData;

  // 時間特徵
  const keyDurations = keypresses.map((k) => k.duration);
  const keyIntervals = keypresses
    .map((k) => k.intervalFromPrevious)
    .filter((i): i is number => i !== null);

  const timing = {
    keyDurations,
    keyIntervals,
    totalDuration: rawData.endTime - rawData.startTime,
    durationMean: mean(keyDurations),
    durationStdDev: stdDev(keyDurations),
    intervalMean: mean(keyIntervals),
    intervalStdDev: stdDev(keyIntervals),
    intervalCV: coefficientOfVariation(keyIntervals),
  };

  // 空間特徵
  const touchPositions = keypresses.map((k) => ({
    x: k.touchStart.x,
    y: k.touchStart.y,
  }));

  // TODO: 計算與按鍵中心的偏移（需要知道按鍵實際位置）
  const positionOffsets = touchPositions.map(() => ({ dx: 0, dy: 0 }));

  const spatial = {
    touchPositions,
    positionOffsets,
  };

  // 面積特徵
  const radiusX = keypresses.map((k) => k.touchStart.radiusX);
  const radiusY = keypresses.map((k) => k.touchStart.radiusY);
  const avgRadii = keypresses.map((k) => (k.touchStart.radiusX + k.touchStart.radiusY) / 2);

  const touchArea = {
    radiusX,
    radiusY,
    avgRadius: mean(avgRadii),
    radiusVariance: variance(avgRadii),
    // 真實觸控 radiusX/radiusY 通常 > 0.1（Samsung Z Fold 6 約 0.3-1.3）
    // 模擬器/腳本通常是 0 或完全相同的整數值
    hasRealTouchArea: avgRadii.some((r) => r > 0.1 && r < 100),
  };

  // Phase 25: 節奏比率特徵
  const intervalRatios: number[] = [];
  for (let i = 1; i < keyIntervals.length; i++) {
    if (keyIntervals[i - 1] > 0) {
      intervalRatios.push(keyIntervals[i] / keyIntervals[i - 1]);
    }
  }
  const rhythm = {
    intervalRatios,
    intervalRatioMean: mean(intervalRatios),
    intervalRatioCV: coefficientOfVariation(intervalRatios),
    holdTimeSkewness: skewness(keyDurations),
  };

  // Phase 25: 觸控物理特徵
  const rotationAngles = keypresses.map((k) => k.touchStart.rotationAngle);
  const forces = keypresses.map((k) => k.touchStart.force);
  const firstPos = touchPositions[0];
  const lastPos = touchPositions[touchPositions.length - 1];
  const touchPhysics = {
    rotationAngleMean: mean(rotationAngles),
    rotationAngleCV: coefficientOfVariation(rotationAngles),
    forceMean: mean(forces),
    forceCV: coefficientOfVariation(forces),
    positionDriftX: lastPos ? lastPos.x - (firstPos?.x ?? 0) : 0,
    positionDriftY: lastPos ? lastPos.y - (firstPos?.y ?? 0) : 0,
  };

  // Phase 25: 按鍵轉換特徵（相鄰按鍵的 touchEnd → 下一個 touchStart 時間差）
  const transitionTimes: number[] = [];
  for (let i = 1; i < keypresses.length; i++) {
    const prevEnd = keypresses[i - 1].touchEnd?.timestamp ?? 0;
    const currStart = keypresses[i].touchStart.timestamp;
    if (prevEnd > 0) {
      transitionTimes.push(currStart - prevEnd);
    }
  }
  const keyTransition = {
    transitionTimes,
    transitionMean: mean(transitionTimes),
    transitionCV: coefficientOfVariation(transitionTimes),
  };

  // Phase 25: 動作感測器數據
  const motion = {
    accelerometerMagnitude: motionData?.accelerometerMagnitude ?? 0,
    hasMotionData: (motionData?.accelerometerMagnitude ?? 0) > 0,
  };

  // 一致性（與上一次輸入比較）- 用於驗證是否為同一人
  let consistency: PinBehaviorFingerprint['consistency'] = {
    timingCorrelation: null,
    spatialCorrelation: null,
    touchAreaCorrelation: null,
    overallSimilarity: null,
  };

  if (previousFingerprint) {
    const correlations: number[] = [];

    // 1. 比較時間模式（按鍵持續時間 + 間隔）
    if (
      previousFingerprint.timing.keyDurations.length === keyDurations.length &&
      keyDurations.length >= 2
    ) {
      const durationCorr = pearsonCorrelation(
        previousFingerprint.timing.keyDurations,
        keyDurations
      );

      // 比較間隔模式
      if (
        previousFingerprint.timing.keyIntervals.length === keyIntervals.length &&
        keyIntervals.length >= 2
      ) {
        const intervalCorr = pearsonCorrelation(
          previousFingerprint.timing.keyIntervals,
          keyIntervals
        );
        // 平均兩個相關係數
        consistency.timingCorrelation = (durationCorr + intervalCorr) / 2;
      } else {
        consistency.timingCorrelation = durationCorr;
      }

      // 將相關係數轉換為 0-1 範圍的相似度
      if (consistency.timingCorrelation !== null) {
        correlations.push((consistency.timingCorrelation + 1) / 2);
      }
    }

    // 2. 比較位置模式（同一按鍵的觸控位置應該相近）
    if (
      previousFingerprint.spatial.touchPositions.length === touchPositions.length &&
      touchPositions.length >= 2
    ) {
      // 計算每個按鍵位置的歐幾里得距離
      let totalDistance = 0;
      let validPairs = 0;

      for (let i = 0; i < touchPositions.length; i++) {
        const prev = previousFingerprint.spatial.touchPositions[i];
        const curr = touchPositions[i];

        // 計算距離（像素）
        const dx = prev.x - curr.x;
        const dy = prev.y - curr.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        totalDistance += distance;
        validPairs++;
      }

      if (validPairs > 0) {
        const avgDistance = totalDistance / validPairs;
        // 將距離轉換為相似度：距離越小越相似
        // 假設同一人按同一按鍵的偏差通常在 20px 以內
        // 距離 0 = 相似度 1，距離 50px+ = 相似度接近 0
        consistency.spatialCorrelation = Math.max(0, 1 - avgDistance / 50);
        correlations.push(consistency.spatialCorrelation);
      }
    }

    // 3. 比較觸控面積（同一手指的 radiusX/Y 應該相近）
    if (
      previousFingerprint.touchArea.radiusX.length === radiusX.length &&
      radiusX.length >= 2 &&
      previousFingerprint.touchArea.hasRealTouchArea &&
      touchArea.hasRealTouchArea
    ) {
      // 計算每次觸控的面積差異
      let totalDiff = 0;
      let validPairs = 0;

      for (let i = 0; i < radiusX.length; i++) {
        const prevAvg = (previousFingerprint.touchArea.radiusX[i] + previousFingerprint.touchArea.radiusY[i]) / 2;
        const currAvg = (radiusX[i] + radiusY[i]) / 2;

        if (prevAvg > 0 && currAvg > 0) {
          // 計算相對差異（比例）
          const ratio = Math.min(prevAvg, currAvg) / Math.max(prevAvg, currAvg);
          totalDiff += ratio;
          validPairs++;
        }
      }

      if (validPairs > 0) {
        // 平均相似度
        consistency.touchAreaCorrelation = totalDiff / validPairs;
        correlations.push(consistency.touchAreaCorrelation);
      }
    }

    // 4. 計算綜合相似度（加權平均）
    // 時間相關性變異大（同一人每次輸入節奏不同），權重應該較低
    // 位置和觸控面積更穩定，權重較高
    if (correlations.length > 0) {
      // correlations 順序: [時間, 位置, 觸控面積]
      // 時間相關性權重 0.2，位置 0.4，觸控面積 0.4
      const weights = [0.2, 0.4, 0.4];  // 對應 timing, spatial, touchArea

      let weightedSum = 0;
      let totalWeight = 0;

      for (let i = 0; i < correlations.length; i++) {
        const weight = weights[i] || 0.33;  // fallback 權重
        weightedSum += correlations[i] * weight;
        totalWeight += weight;
      }

      consistency.overallSimilarity = totalWeight > 0 ? weightedSum / totalWeight : null;
    }
  }

  // 錯誤/刪除特徵計算
  const allKeypresses = rawData.allKeypresses || rawData.keypresses;
  const deleteKeys = allKeypresses.filter(k => k.key === 'del');
  const deleteCount = deleteKeys.length;
  const totalKeystrokes = allKeypresses.length;

  // 計算刪除位置（在第幾個按鍵後發生刪除）
  const correctionPositions: number[] = [];
  let digitCount = 0;
  for (const k of allKeypresses) {
    if (k.key === 'del') {
      correctionPositions.push(digitCount);
      digitCount = Math.max(0, digitCount - 1);
    } else {
      digitCount++;
    }
  }

  // 計算最大連續刪除次數
  let maxConsecutiveDeletes = 0;
  let currentConsecutive = 0;
  for (const k of allKeypresses) {
    if (k.key === 'del') {
      currentConsecutive++;
      maxConsecutiveDeletes = Math.max(maxConsecutiveDeletes, currentConsecutive);
    } else {
      currentConsecutive = 0;
    }
  }

  const errorPattern: PinBehaviorFingerprint['errorPattern'] = {
    totalKeystrokes,
    deleteCount,
    deletedDigits: deleteCount, // 每次刪除刪一個數字
    errorRate: totalKeystrokes > 0 ? deleteCount / totalKeystrokes : 0,
    correctionPositions,
    hasMultipleDeletes: maxConsecutiveDeletes > 1,
    maxConsecutiveDeletes,
  };

  return {
    timing,
    spatial,
    touchArea,
    rhythm,
    touchPhysics,
    keyTransition,
    motion,
    consistency,
    errorPattern,
  };
}

/**
 * 偵測模擬器或腳本，以及是否為不同人輸入
 *
 * 評分邏輯：
 * - 觸控面積為 0：高度可疑（模擬器特徵）
 * - 觸控面積完全相同：可疑（自動化腳本）
 * - 按鍵間隔太規則：可疑（機器人）
 * - 兩次輸入一致性過低：可能是不同人
 *
 * 閾值：
 * - score >= 60：判定為模擬器
 * - score >= 40：標記為可疑
 * - overallSimilarity < 0.4：判定為不同人
 */
export function detectEmulatorOrBot(fingerprint: PinBehaviorFingerprint): EmulatorDetectionResult {
  // E2E 測試模式：跳過模擬器偵測（僅限 DEV 環境）
  if (import.meta.env.DEV && typeof window !== 'undefined' && localStorage.getItem('AEGIS_E2E_TEST') === 'true') {
    devLog('[BehaviorFingerprint] E2E 測試模式：跳過模擬器偵測');
    return {
      isEmulator: false,
      isSuspicious: false,
      isDifferentPerson: false,
      score: 0,
      sameProbability: 1,
      reasons: ['E2E test mode - detection bypassed'],
      fingerprint: fingerprint,
    };
  }

  let score = 0;
  const reasons: string[] = [];

  // ========== 模擬器/腳本偵測 ==========

  // 1. 觸控面積異常 (模擬器通常沒有真實觸控)
  if (!fingerprint.touchArea.hasRealTouchArea) {
    if (fingerprint.touchArea.avgRadius === 0) {
      score += 40;
      reasons.push('觸控面積為 0 (模擬器特徵)');
    } else if (fingerprint.touchArea.avgRadius <= 0.1) {
      score += 30;
      reasons.push('觸控面積極小 (可能是模擬器)');
    }
  }

  // 2. 觸控面積完全相同或變異極小 (真人手指不可能，觸控筆/模擬器特徵)
  // 真人手指每次按壓角度、力度都會略有不同，radiusVariance 不可能為 0 或極小
  // 檢查 1: 方差為 0（完全相同）
  if (fingerprint.touchArea.avgRadius > 0 && fingerprint.touchArea.radiusVariance === 0) {
    // 觸控面積完全相同是極強的觸控筆/模擬器特徵
    // 真人手指不可能每次都完全一樣
    score += 70;  // 提高分數：直接超過 60 分閾值
    reasons.push('每次觸控面積完全相同 (觸控筆/模擬器，強烈特徵)');
  }
  // 檢查 2: 方差極小（< 0.01）且有多次按鍵
  // 真人手指的 radiusVariance 通常 > 0.1
  else if (
    fingerprint.touchArea.avgRadius > 0 &&
    fingerprint.touchArea.radiusVariance < 0.01 &&
    fingerprint.touchArea.radiusX.length >= 4
  ) {
    score += 50;  // 提高分數
    reasons.push(`觸控面積變異極小: ${fingerprint.touchArea.radiusVariance.toFixed(4)} (觸控筆/模擬器特徵)`);
  }

  // 3. 按鍵間隔太規則 (機械化特徵)
  // CV < 5% 表示間隔幾乎完全相同，真人不可能
  if (fingerprint.timing.intervalCV < 0.05 && fingerprint.timing.keyIntervals.length >= 3) {
    score += 30;
    reasons.push(`間隔變異係數過低: ${(fingerprint.timing.intervalCV * 100).toFixed(1)}%`);
  }
  // 額外檢查：間隔 CV 在 5-10% 也算可疑
  else if (fingerprint.timing.intervalCV < 0.10 && fingerprint.timing.keyIntervals.length >= 4) {
    score += 15;
    reasons.push(`間隔變異係數偏低: ${(fingerprint.timing.intervalCV * 100).toFixed(1)}% (可疑)`);
  }

  // 3b. 按鍵持續時間太規則 (機械化特徵)
  // 真人每次按壓時間會有自然變異，CV 通常 > 15%
  const durationCV = fingerprint.timing.durationMean > 0
    ? fingerprint.timing.durationStdDev / fingerprint.timing.durationMean
    : 0;
  if (durationCV < 0.05 && fingerprint.timing.keyDurations.length >= 4) {
    score += 25;
    reasons.push(`按鍵持續時間變異過低: ${(durationCV * 100).toFixed(1)}% (機械化特徵)`);
  } else if (durationCV < 0.10 && fingerprint.timing.keyDurations.length >= 4) {
    score += 10;
    reasons.push(`按鍵持續時間變異偏低: ${(durationCV * 100).toFixed(1)}% (可疑)`);
  }

  // 4. 按鍵持續時間異常短
  // 真人觸控通常 50-200ms，< 20ms 幾乎不可能
  if (fingerprint.timing.durationMean < 20) {
    score += 20;
    reasons.push(`按鍵持續時間過短: ${fingerprint.timing.durationMean.toFixed(0)}ms`);
  }

  // 5. 總輸入時間異常短
  // 6 位 PIN 通常需要 1-5 秒，< 500ms 幾乎不可能
  if (fingerprint.timing.totalDuration < 500) {
    score += 15;
    reasons.push(`總輸入時間過短: ${fingerprint.timing.totalDuration.toFixed(0)}ms`);
  }

  // 6. 兩次輸入完全一致 (複製貼上/腳本特徵)
  if (fingerprint.consistency.timingCorrelation !== null) {
    if (fingerprint.consistency.timingCorrelation > 0.98) {
      score += 30;
      reasons.push(
        `兩次輸入時間模式過於一致: ${(fingerprint.consistency.timingCorrelation * 100).toFixed(1)}%`
      );
    }
  }

  // 7. 綜合機械化判斷：多個指標同時呈現機械化特徵
  // 如果觸控面積、間隔、持續時間都很規律，幾乎確定是機器
  const mechanicalIndicators = [
    fingerprint.touchArea.radiusVariance < 0.01,  // 觸控面積太規律
    fingerprint.timing.intervalCV < 0.10,          // 間隔太規律
    durationCV < 0.10,                             // 持續時間太規律
  ].filter(Boolean).length;

  if (mechanicalIndicators >= 2 && fingerprint.timing.keyDurations.length >= 4) {
    score += 20;
    reasons.push(`多項指標呈現機械化特徵 (${mechanicalIndicators}/3)`);
  }

  // 8. 有真實觸控特徵時，降低可疑分數
  // 但必須確保有足夠的變異度
  // 注意：如果 radiusVariance === 0，即使 hasRealTouchArea 也不扣分（觸控筆特徵）
  if (
    fingerprint.touchArea.hasRealTouchArea &&
    fingerprint.touchArea.radiusVariance > 0.05 &&
    fingerprint.timing.intervalCV > 0.10 &&
    durationCV > 0.10
  ) {
    score = Math.max(0, score - 15);
    reasons.push('有真實手指觸控特徵 (-15分)');
  } else if (
    fingerprint.touchArea.hasRealTouchArea &&
    fingerprint.touchArea.radiusVariance > 0.01 &&  // 必須有變異
    fingerprint.touchArea.radiusVariance !== 0       // 不是完全相同
  ) {
    score = Math.max(0, score - 5);
  }

  // 9. 有刪除/錯誤操作時，降低模擬器可疑分數（因為機器人不會打錯）
  if (fingerprint.errorPattern.deleteCount > 0) {
    const errorBonus = Math.min(fingerprint.errorPattern.deleteCount * 5, 15);  // 最多降 15 分
    score = Math.max(0, score - errorBonus);
    reasons.push(`有 ${fingerprint.errorPattern.deleteCount} 次刪除操作 (人類特徵 -${errorBonus}分)`);
  }

  // ========== 不同人偵測 ==========
  // 閾值說明：
  // - 同一人用同一手指輸入兩次，相似度變化較大（50%-85%）
  // - 主要用於日誌記錄，不用於阻擋
  // - 實際阻擋由 AuthScreen 的 combinedScore < 0.3 控制

  let isDifferentPerson = false;
  let sameProbability = 1.0;  // 預設為同一人

  if (fingerprint.consistency.overallSimilarity !== null) {
    sameProbability = fingerprint.consistency.overallSimilarity;

    devLog('[Detection] Checking similarity:', {
      overallSimilarity: fingerprint.consistency.overallSimilarity,
      threshold: 0.50,
      willBeDifferent: fingerprint.consistency.overallSimilarity < 0.50,
    });

    // 綜合相似度 < 0.50 判定為不同人（降低閾值，避免誤報）
    // 注意：這只是標記，實際阻擋由 combinedScore < 0.3 控制
    if (fingerprint.consistency.overallSimilarity < 0.50) {
      isDifferentPerson = true;
      reasons.push(`兩次輸入相似度過低: ${(fingerprint.consistency.overallSimilarity * 100).toFixed(1)}% (可能是不同人)`);
      devLog('[Detection] Setting isDifferentPerson = true due to low similarity');
    }

    // 位置差異過大（僅記錄，不判定不同人）
    if (fingerprint.consistency.spatialCorrelation !== null && fingerprint.consistency.spatialCorrelation < 0.5) {
      reasons.push(`觸控位置差異過大: ${(fingerprint.consistency.spatialCorrelation * 100).toFixed(1)}%`);
      // 只有極端情況才判定不同人
      if (!isDifferentPerson && fingerprint.consistency.spatialCorrelation < 0.3) {
        isDifferentPerson = true;
      }
    }

    // 觸控面積差異過大（換手指）（僅記錄，不判定不同人）
    if (fingerprint.consistency.touchAreaCorrelation !== null && fingerprint.consistency.touchAreaCorrelation < 0.5) {
      reasons.push(`觸控面積差異過大: ${(fingerprint.consistency.touchAreaCorrelation * 100).toFixed(1)}% (可能換了手指)`);
      // 只有極端情況才判定不同人
      if (!isDifferentPerson && fingerprint.consistency.touchAreaCorrelation < 0.3) {
        isDifferentPerson = true;
      }
    }
  }

  devLog('[Detection] Final result:', {
    score,
    isDifferentPerson,
    sameProbability,
    reasonsCount: reasons.length,
  });

  return {
    score: Math.min(score, 100),
    isEmulator: score >= 60,
    isSuspicious: score >= 40,
    isDifferentPerson,
    sameProbability,
    reasons,
    fingerprint,
  };
}

/**
 * 格式化指紋數據供顯示
 */
export function formatFingerprintForDisplay(fingerprint: PinBehaviorFingerprint): string {
  const lines: string[] = [];

  lines.push('=== PIN 行為指紋 ===\n');

  lines.push('【時間特徵】');
  lines.push(`  總輸入時間: ${fingerprint.timing.totalDuration.toFixed(0)}ms`);
  lines.push(`  按鍵持續時間: ${fingerprint.timing.keyDurations.map((d) => d.toFixed(0)).join(', ')}ms`);
  lines.push(`  按鍵間隔: ${fingerprint.timing.keyIntervals.map((i) => i.toFixed(0)).join(', ')}ms`);
  lines.push(`  持續時間平均: ${fingerprint.timing.durationMean.toFixed(1)}ms`);
  lines.push(`  持續時間標準差: ${fingerprint.timing.durationStdDev.toFixed(1)}ms`);
  lines.push(`  間隔平均: ${fingerprint.timing.intervalMean.toFixed(1)}ms`);
  lines.push(`  間隔變異係數 (CV): ${(fingerprint.timing.intervalCV * 100).toFixed(1)}%`);

  lines.push('\n【觸控位置】');
  fingerprint.spatial.touchPositions.forEach((pos, i) => {
    lines.push(`  按鍵${i + 1}: (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)})`);
  });

  lines.push('\n【觸控面積】');
  lines.push(`  radiusX: ${fingerprint.touchArea.radiusX.map((r) => r.toFixed(2)).join(', ')}`);
  lines.push(`  radiusY: ${fingerprint.touchArea.radiusY.map((r) => r.toFixed(2)).join(', ')}`);
  lines.push(`  平均半徑: ${fingerprint.touchArea.avgRadius.toFixed(2)}`);
  lines.push(`  半徑方差: ${fingerprint.touchArea.radiusVariance.toFixed(4)}`);
  lines.push(`  有真實觸控: ${fingerprint.touchArea.hasRealTouchArea ? '是' : '否'}`);

  // 計算持續時間 CV
  const durationCVDisplay = fingerprint.timing.durationMean > 0
    ? fingerprint.timing.durationStdDev / fingerprint.timing.durationMean
    : 0;

  lines.push('\n【機械化指標】');
  lines.push(`  間隔 CV: ${(fingerprint.timing.intervalCV * 100).toFixed(1)}% ${fingerprint.timing.intervalCV < 0.10 ? '⚠️' : '✓'}`);
  lines.push(`  持續時間 CV: ${(durationCVDisplay * 100).toFixed(1)}% ${durationCVDisplay < 0.10 ? '⚠️' : '✓'}`);
  lines.push(`  面積方差: ${fingerprint.touchArea.radiusVariance.toFixed(4)} ${fingerprint.touchArea.radiusVariance < 0.01 ? '⚠️' : '✓'}`);
  const mechanicalCount = [
    fingerprint.touchArea.radiusVariance < 0.01,
    fingerprint.timing.intervalCV < 0.10,
    durationCVDisplay < 0.10,
  ].filter(Boolean).length;
  lines.push(`  機械化指標: ${mechanicalCount}/3 ${mechanicalCount >= 2 ? '⚠️ 可疑' : '✓ 正常'}`);

  if (fingerprint.consistency.overallSimilarity !== null) {
    lines.push('\n【兩次一致性】');
    if (fingerprint.consistency.timingCorrelation !== null) {
      lines.push(`  時間相關性: ${(fingerprint.consistency.timingCorrelation * 100).toFixed(1)}%`);
    }
    if (fingerprint.consistency.spatialCorrelation !== null) {
      lines.push(`  位置相似度: ${(fingerprint.consistency.spatialCorrelation * 100).toFixed(1)}%`);
    }
    if (fingerprint.consistency.touchAreaCorrelation !== null) {
      lines.push(`  觸控面積相似度: ${(fingerprint.consistency.touchAreaCorrelation * 100).toFixed(1)}%`);
    }
    lines.push(`  綜合相似度: ${(fingerprint.consistency.overallSimilarity * 100).toFixed(1)}%`);
  }

  // 錯誤/刪除模式
  lines.push('\n【錯誤/刪除模式】');
  lines.push(`  總按鍵次數: ${fingerprint.errorPattern.totalKeystrokes}`);
  lines.push(`  刪除次數: ${fingerprint.errorPattern.deleteCount}`);
  lines.push(`  錯誤率: ${(fingerprint.errorPattern.errorRate * 100).toFixed(1)}%`);
  if (fingerprint.errorPattern.correctionPositions.length > 0) {
    lines.push(`  刪除位置: 第 ${fingerprint.errorPattern.correctionPositions.join(', ')} 位後`);
  }
  if (fingerprint.errorPattern.hasMultipleDeletes) {
    lines.push(`  最大連續刪除: ${fingerprint.errorPattern.maxConsecutiveDeletes} 次`);
  }

  return lines.join('\n');
}

/**
 * 格式化偵測結果供顯示
 */
export function formatDetectionResultForDisplay(result: EmulatorDetectionResult): string {
  const lines: string[] = [];

  lines.push('=== 行為指紋偵測結果 ===\n');
  lines.push(`風險分數: ${result.score}/100`);
  lines.push(`是否為模擬器: ${result.isEmulator ? '是' : '否'}`);
  lines.push(`是否可疑: ${result.isSuspicious ? '是' : '否'}`);
  lines.push(`是否為不同人: ${result.isDifferentPerson ? '是 ⚠️' : '否'}`);
  lines.push(`同一人機率: ${(result.sameProbability * 100).toFixed(1)}%`);

  if (result.reasons.length > 0) {
    lines.push('\n【偵測原因】');
    result.reasons.forEach((reason, i) => {
      lines.push(`  ${i + 1}. ${reason}`);
    });
  } else {
    lines.push('\n未發現可疑特徵');
  }

  return lines.join('\n');
}
