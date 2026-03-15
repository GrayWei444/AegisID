import { devLog } from '../utils/devLog';

/**
 * Phase 10/25: usePinBehavior Hook
 *
 * 收集 PIN 輸入時的行為特徵
 * Phase 25: 加入 DeviceMotion 動作感測器收集
 */

import { useCallback, useRef, useState } from 'react';
import type {
  PinTouchData,
  PinKeypress,
  PinInputRawData,
  PinBehaviorFingerprint,
  EmulatorDetectionResult,
} from './behaviorFingerprint';
import {
  calculateFingerprint,
  detectEmulatorOrBot,
} from './behaviorFingerprint';
import { MotionCollector } from '../services/motionSensor';

interface UsePinBehaviorReturn {
  /** 開始收集新的 PIN 輸入 */
  startCollection: () => void;

  /** 記錄按鍵開始 (touchstart) */
  recordKeyStart: (key: string, event: TouchEvent | React.TouchEvent) => void;

  /** 記錄按鍵結束 (touchend) */
  recordKeyEnd: (key: string, event: TouchEvent | React.TouchEvent) => void;

  /** 完成收集並計算指紋 */
  finishCollection: () => PinBehaviorFingerprint | null;

  /** 執行模擬器偵測 */
  detectEmulator: () => EmulatorDetectionResult | null;

  /** 重置所有數據 */
  reset: () => void;

  /** 載入儲存的基線指紋（用於 verify 模式比對） */
  loadBaseline: (baseline: PinBehaviorFingerprint) => void;

  /** 第一次輸入的指紋 */
  firstFingerprint: PinBehaviorFingerprint | null;

  /** 第二次輸入的指紋 */
  secondFingerprint: PinBehaviorFingerprint | null;

  /** 偵測結果 */
  detectionResult: EmulatorDetectionResult | null;

  /** 當前收集的原始數據 */
  currentRawData: PinInputRawData | null;
}

export function usePinBehavior(): UsePinBehaviorReturn {
  // 狀態
  const [firstFingerprint, setFirstFingerprint] = useState<PinBehaviorFingerprint | null>(null);
  const [secondFingerprint, setSecondFingerprint] = useState<PinBehaviorFingerprint | null>(null);
  const [detectionResult, setDetectionResult] = useState<EmulatorDetectionResult | null>(null);

  // Refs for tracking current input
  const currentKeypresses = useRef<PinKeypress[]>([]);      // 有效按鍵（最終 PIN）
  const allKeypresses = useRef<PinKeypress[]>([]);          // 完整歷史（包含刪除）
  const currentStartTime = useRef<number>(0);
  const pendingTouchStart = useRef<Map<string, PinTouchData>>(new Map());
  const lastKeyEndTime = useRef<number | null>(null);
  const isCollecting = useRef<boolean>(false);

  // Phase 25: 動作感測器收集器
  const motionCollector = useRef(new MotionCollector());

  /**
   * 從 TouchEvent 提取觸控數據
   */
  const extractTouchData = useCallback(
    (key: string, event: TouchEvent | React.TouchEvent): PinTouchData => {
      const nativeEvent = 'nativeEvent' in event ? event.nativeEvent : event;
      const touch = nativeEvent.changedTouches[0];

      return {
        timestamp: Date.now(),
        x: touch?.clientX ?? 0,
        y: touch?.clientY ?? 0,
        key,
        radiusX: touch?.radiusX ?? 0,
        radiusY: touch?.radiusY ?? 0,
        rotationAngle: touch?.rotationAngle ?? 0,
        force: touch?.force ?? 0,
      };
    },
    []
  );

  /**
   * 開始收集新的 PIN 輸入
   */
  const startCollection = useCallback(() => {
    currentKeypresses.current = [];
    allKeypresses.current = [];
    currentStartTime.current = Date.now();
    pendingTouchStart.current.clear();
    lastKeyEndTime.current = null;
    isCollecting.current = true;

    // Phase 25: 啟動動作感測器（非阻塞，不影響 PIN 輸入流程）
    motionCollector.current.start().catch(() => {
      devLog('[PinBehavior] Motion sensor not available');
    });

    devLog('[PinBehavior] Started collection');
  }, []);

  /**
   * 記錄按鍵開始 (touchstart)
   */
  const recordKeyStart = useCallback(
    (key: string, event: TouchEvent | React.TouchEvent) => {
      if (!isCollecting.current) return;

      const touchData = extractTouchData(key, event);
      pendingTouchStart.current.set(key, touchData);

      devLog('[PinBehavior] Key start:', key, {
        x: touchData.x.toFixed(0),
        y: touchData.y.toFixed(0),
        radiusX: touchData.radiusX.toFixed(1),
        radiusY: touchData.radiusY.toFixed(1),
      });
    },
    [extractTouchData]
  );

  /**
   * 記錄按鍵結束 (touchend)
   *
   * 策略：
   * - allKeypresses: 記錄所有按鍵（包含刪除），用於錯誤模式分析
   * - currentKeypresses: 只保留有效 PIN 按鍵，用於比對
   */
  const recordKeyEnd = useCallback(
    (key: string, event: TouchEvent | React.TouchEvent) => {
      if (!isCollecting.current) return;

      const touchEndData = extractTouchData(key, event);
      const touchStartData = pendingTouchStart.current.get(key);

      if (touchStartData) {
        const duration = touchEndData.timestamp - touchStartData.timestamp;
        const intervalFromPrevious =
          lastKeyEndTime.current !== null ? touchStartData.timestamp - lastKeyEndTime.current : null;

        const keypress: PinKeypress = {
          key,
          touchStart: touchStartData,
          touchEnd: touchEndData,
          duration,
          intervalFromPrevious,
        };

        // 總是記錄到完整歷史
        allKeypresses.current.push(keypress);

        if (key === 'del') {
          // 刪除鍵：從有效按鍵中移除最後一個
          if (currentKeypresses.current.length > 0) {
            const removed = currentKeypresses.current.pop();
            devLog('[PinBehavior] Delete pressed, removed:', removed?.key, 'Total deletes:',
              allKeypresses.current.filter(k => k.key === 'del').length);

            // 更新 lastKeyEndTime 為前一個有效按鍵的結束時間
            const lastKeypress = currentKeypresses.current[currentKeypresses.current.length - 1];
            if (lastKeypress?.touchEnd) {
              lastKeyEndTime.current = lastKeypress.touchEnd.timestamp;
            } else {
              lastKeyEndTime.current = null;
            }
          }
        } else {
          // 數字鍵：加入有效按鍵
          currentKeypresses.current.push(keypress);
          lastKeyEndTime.current = touchEndData.timestamp;

          devLog('[PinBehavior] Key end:', key, {
            duration: duration.toFixed(0) + 'ms',
            interval: intervalFromPrevious !== null ? intervalFromPrevious.toFixed(0) + 'ms' : 'first',
            validKeys: currentKeypresses.current.length,
            totalKeys: allKeypresses.current.length,
          });
        }

        pendingTouchStart.current.delete(key);
      }
    },
    [extractTouchData]
  );

  // 用 ref 追蹤最新的指紋（因為 state 更新是異步的）
  const latestSecondFingerprint = useRef<PinBehaviorFingerprint | null>(null);

  /**
   * 完成收集並計算指紋
   */
  const finishCollection = useCallback((): PinBehaviorFingerprint | null => {
    if (!isCollecting.current || currentKeypresses.current.length === 0) {
      return null;
    }

    isCollecting.current = false;

    // Phase 25: 停止動作感測器並取得摘要
    motionCollector.current.stop();
    const motionSummary = motionCollector.current.getSummary();

    const rawData: PinInputRawData = {
      keypresses: [...currentKeypresses.current],
      allKeypresses: [...allKeypresses.current],  // 包含完整歷史
      startTime: currentStartTime.current,
      endTime: Date.now(),
    };

    devLog('[PinBehavior] Finishing collection:', {
      validKeys: rawData.keypresses.length,
      totalKeys: rawData.allKeypresses.length,
      deleteCount: rawData.allKeypresses.filter(k => k.key === 'del').length,
      motionSamples: motionSummary.sampleCount,
    });

    // 計算指紋（如果有第一次的指紋，用於計算一致性）
    const fingerprint = calculateFingerprint(
      rawData,
      firstFingerprint ?? undefined,
      motionSummary.hasData ? { accelerometerMagnitude: motionSummary.accelerometerMagnitude } : undefined
    );

    // 儲存指紋
    if (firstFingerprint === null) {
      setFirstFingerprint(fingerprint);
      latestSecondFingerprint.current = null;
      devLog('[PinBehavior] First fingerprint calculated:', {
        deleteCount: fingerprint.errorPattern.deleteCount,
        errorRate: (fingerprint.errorPattern.errorRate * 100).toFixed(1) + '%',
      });
    } else {
      setSecondFingerprint(fingerprint);
      latestSecondFingerprint.current = fingerprint;  // 同步更新 ref
      devLog('[PinBehavior] Second fingerprint calculated:', {
        deleteCount: fingerprint.errorPattern.deleteCount,
        errorRate: (fingerprint.errorPattern.errorRate * 100).toFixed(1) + '%',
      });
    }

    return fingerprint;
  }, [firstFingerprint]);

  /**
   * 執行模擬器偵測
   */
  const detectEmulator = useCallback((): EmulatorDetectionResult | null => {
    // 使用 ref 取得最新的第二次指紋（因為 state 更新是異步的）
    const fingerprintToAnalyze = latestSecondFingerprint.current ?? secondFingerprint ?? firstFingerprint;

    if (!fingerprintToAnalyze) {
      devLog('[PinBehavior] No fingerprint to analyze');
      return null;
    }

    devLog('[PinBehavior] Analyzing fingerprint:', {
      hasConsistency: fingerprintToAnalyze.consistency.overallSimilarity !== null,
      overallSimilarity: fingerprintToAnalyze.consistency.overallSimilarity,
    });

    const result = detectEmulatorOrBot(fingerprintToAnalyze);
    setDetectionResult(result);

    devLog('[PinBehavior] Detection result:', {
      score: result.score,
      isEmulator: result.isEmulator,
      isDifferentPerson: result.isDifferentPerson,
      sameProbability: result.sameProbability,
      reasons: result.reasons,
    });

    return result;
  }, [firstFingerprint, secondFingerprint]);

  /**
   * 重置所有數據
   */
  const reset = useCallback(() => {
    currentKeypresses.current = [];
    allKeypresses.current = [];
    currentStartTime.current = 0;
    pendingTouchStart.current.clear();
    lastKeyEndTime.current = null;
    isCollecting.current = false;
    latestSecondFingerprint.current = null;
    motionCollector.current.reset();
    setFirstFingerprint(null);
    setSecondFingerprint(null);
    setDetectionResult(null);

    devLog('[PinBehavior] Reset');
  }, []);

  /**
   * 載入儲存的基線指紋（用於 verify 模式）
   * 這會把基線設為 firstFingerprint，讓之後的輸入可以與其比對
   */
  const loadBaseline = useCallback((baseline: PinBehaviorFingerprint) => {
    setFirstFingerprint(baseline);
    devLog('[PinBehavior] Loaded baseline fingerprint for comparison');
  }, []);

  /**
   * 取得當前收集的原始數據
   */
  const getCurrentRawData = (): PinInputRawData | null => {
    if (currentKeypresses.current.length === 0) return null;
    return {
      keypresses: [...currentKeypresses.current],
      allKeypresses: [...allKeypresses.current],
      startTime: currentStartTime.current,
      endTime: Date.now(),
    };
  };

  return {
    startCollection,
    recordKeyStart,
    recordKeyEnd,
    finishCollection,
    detectEmulator,
    reset,
    loadBaseline,
    firstFingerprint,
    secondFingerprint,
    detectionResult,
    currentRawData: getCurrentRawData(),
  };
}

export default usePinBehavior;
