/**
 * Phase 26: Liveness Detection
 *
 * 主動活體偵測（註冊）：使用者需完成眨眼+轉頭兩步挑戰（Face ID 風格）
 * 被動活體偵測（登入）：背景偵測自然眨眼和微動，無感進行
 */

import { devLog } from '../../utils/devLog';
import type {
  FaceGeometry,
  LivenessChallenge,
  LivenessChallengeStatus,
  LivenessResult,
  ChallengeEmbeddingSnapshot,
} from './types';

// ============================================================================
// Constants
// ============================================================================

const THRESHOLDS = {
  /** EAR 低於此值 = 閉眼 */
  BLINK_EAR: 0.18,
  /** 鼻子偏移超過此值 = 轉頭 */
  HEAD_TURN_OFFSET: 0.12,
  /** 每個主動挑戰超時 (ms) */
  ACTIVE_CHALLENGE_TIMEOUT: 8000,
  /** 被動偵測需要的最少眨眼次數 */
  PASSIVE_MIN_BLINKS: 1,
  /** 被動偵測需要的最少微動量 */
  PASSIVE_MIN_MOTION: 0.005,
  /** 被動偵測超時 (ms) */
  PASSIVE_TIMEOUT: 5000,
} as const;

// ============================================================================
// Active Liveness (Registration)
// ============================================================================

/**
 * 主動活體偵測器
 *
 * 註冊時使用：依序要求使用者眨眼、轉頭（Face ID 風格）
 * 每個動作有 8 秒超時
 */
export class ActiveLivenessDetector {
  private challenges: LivenessChallenge[] = ['blink', 'turn_head'];
  private currentIndex = 0;
  private challengeStartTime = 0;
  private completed: Map<LivenessChallenge, LivenessChallengeStatus> = new Map();
  private wasEyesClosed = false;
  private wasHeadTurned = false;
  /** Phase 26b: 挑戰期間 embedding 快照 */
  private snapshots: ChallengeEmbeddingSnapshot[] = [];

  constructor() {
    this.reset();
  }

  /** 重置偵測器 */
  reset(): void {
    this.currentIndex = 0;
    this.challengeStartTime = Date.now();
    this.wasEyesClosed = false;
    this.wasHeadTurned = false;
    this.snapshots = [];
    this.completed = new Map([
      ['blink', 'waiting'],
      ['turn_head', 'waiting'],
    ]);
  }

  /** 取得目前的挑戰 */
  getCurrentChallenge(): LivenessChallenge | null {
    if (this.currentIndex >= this.challenges.length) return null;
    return this.challenges[this.currentIndex];
  }

  /** 取得已完成的挑戰數 */
  getProgress(): { current: number; total: number } {
    return { current: this.currentIndex, total: this.challenges.length };
  }

  /**
   * 處理一幀臉部幾何
   * @returns true 如果所有挑戰完成
   */
  processFrame(geometry: FaceGeometry): boolean {
    const challenge = this.getCurrentChallenge();
    if (!challenge) return true; // 全部完成

    // 檢查超時
    if (Date.now() - this.challengeStartTime > THRESHOLDS.ACTIVE_CHALLENGE_TIMEOUT) {
      devLog('[Liveness] Challenge timeout:', challenge);
      this.completed.set(challenge, 'timeout');
      return false; // 超時失敗
    }

    const avgEAR = (geometry.leftEAR + geometry.rightEAR) / 2;

    switch (challenge) {
      case 'blink': {
        // 偵測眨眼：EAR 先下降到閾值以下，再回復
        if (avgEAR < THRESHOLDS.BLINK_EAR) {
          this.wasEyesClosed = true;
        } else if (this.wasEyesClosed && avgEAR >= THRESHOLDS.BLINK_EAR) {
          devLog('[Liveness] Blink detected');
          this.completed.set('blink', 'detected');
          this.advanceChallenge();
        }
        break;
      }

      case 'turn_head': {
        // 偵測轉頭：鼻子偏移超過閾值，再回正
        if (Math.abs(geometry.noseOffsetX) > THRESHOLDS.HEAD_TURN_OFFSET) {
          this.wasHeadTurned = true;
        } else if (this.wasHeadTurned && Math.abs(geometry.noseOffsetX) <= THRESHOLDS.HEAD_TURN_OFFSET) {
          devLog('[Liveness] Head turn detected');
          this.completed.set('turn_head', 'detected');
          this.advanceChallenge();
        }
        break;
      }

    }

    return this.currentIndex >= this.challenges.length;
  }

  /** 前進到下一個挑戰 */
  private advanceChallenge(): void {
    this.currentIndex++;
    this.challengeStartTime = Date.now();
    this.wasEyesClosed = false;
    this.wasHeadTurned = false;
  }

  // =========================================================================
  // Phase 26b: Embedding Snapshots
  // =========================================================================

  /** 新增 embedding 快照（由 useFaceRecognition 在邊挑戰邊擷取時呼叫） */
  addSnapshot(snapshot: ChallengeEmbeddingSnapshot): void {
    this.snapshots.push(snapshot);
  }

  /** 取得所有 embedding 快照 */
  getSnapshots(): ChallengeEmbeddingSnapshot[] {
    return [...this.snapshots];
  }

  /** 取得目前挑戰的 phase（用於快照分類） */
  getCurrentPhase(): 'before' | 'during' | 'after' {
    const challenge = this.getCurrentChallenge();
    if (!challenge) return 'after';
    const status = this.completed.get(challenge);
    if (status === 'waiting') {
      // 挑戰尚未偵測到動作
      return this.wasEyesClosed || this.wasHeadTurned ? 'during' : 'before';
    }
    return 'after';
  }

  /** 取得結果 */
  getResult(): LivenessResult {
    const challenges = this.challenges.map(type => ({
      type,
      status: this.completed.get(type) ?? 'waiting' as LivenessChallengeStatus,
    }));

    const passedCount = challenges.filter(c => c.status === 'detected').length;
    const allPassed = passedCount === this.challenges.length;

    return {
      passed: allPassed,
      mode: 'active',
      challenges,
      confidence: passedCount / this.challenges.length,
    };
  }
}

// ============================================================================
// Passive Liveness (Login)
// ============================================================================

/**
 * 被動活體偵測器
 *
 * 登入時使用：背景偵測自然眨眼和微小頭部動作
 * 使用者只需正常看著相機，無感進行
 */
export class PassiveLivenessDetector {
  private startTime = 0;
  private blinkCount = 0;
  private wasEyesClosed = false;
  private nosePositions: number[] = [];
  private frameCount = 0;

  constructor() {
    this.reset();
  }

  /** 重置 */
  reset(): void {
    this.startTime = Date.now();
    this.blinkCount = 0;
    this.wasEyesClosed = false;
    this.nosePositions = [];
    this.frameCount = 0;
  }

  /**
   * 處理一幀
   * @returns true 如果被動活體通過
   */
  processFrame(geometry: FaceGeometry): boolean {
    this.frameCount++;

    // 偵測自然眨眼
    const avgEAR = (geometry.leftEAR + geometry.rightEAR) / 2;
    if (avgEAR < THRESHOLDS.BLINK_EAR) {
      this.wasEyesClosed = true;
    } else if (this.wasEyesClosed) {
      this.wasEyesClosed = false;
      this.blinkCount++;
      devLog('[Liveness/Passive] Natural blink detected, count:', this.blinkCount);
    }

    // 記錄鼻子位置用於微動分析
    this.nosePositions.push(geometry.noseOffsetX);

    // 檢查是否足夠數據
    const elapsed = Date.now() - this.startTime;
    if (elapsed < 1000) return false; // 至少觀察 1 秒

    // 計算微動量（鼻子位置標準差）
    const motion = this.computeMotion();

    // 通過條件：至少 1 次眨眼 OR 足夠微動
    const hasBlink = this.blinkCount >= THRESHOLDS.PASSIVE_MIN_BLINKS;
    const hasMotion = motion >= THRESHOLDS.PASSIVE_MIN_MOTION;

    return hasBlink || hasMotion;
  }

  /** 是否超時 */
  isTimedOut(): boolean {
    return Date.now() - this.startTime > THRESHOLDS.PASSIVE_TIMEOUT;
  }

  /** 計算微動量 */
  private computeMotion(): number {
    if (this.nosePositions.length < 5) return 0;
    const recent = this.nosePositions.slice(-20);
    const avg = recent.reduce((s, v) => s + v, 0) / recent.length;
    const variance = recent.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / recent.length;
    return Math.sqrt(variance);
  }

  /** 取得結果 */
  getResult(): LivenessResult {
    const motion = this.computeMotion();
    const hasBlink = this.blinkCount >= THRESHOLDS.PASSIVE_MIN_BLINKS;
    const hasMotion = motion >= THRESHOLDS.PASSIVE_MIN_MOTION;
    const passed = hasBlink || hasMotion;

    // 信心度：基於眨眼數和微動量
    const blinkScore = Math.min(this.blinkCount / 2, 1);
    const motionScore = Math.min(motion / 0.02, 1);
    const confidence = Math.max(blinkScore, motionScore);

    return {
      passed,
      mode: 'passive',
      challenges: [
        { type: 'blink', status: hasBlink ? 'detected' : 'waiting' },
      ],
      confidence,
    };
  }
}
