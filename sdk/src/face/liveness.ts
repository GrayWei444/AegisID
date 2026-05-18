/**
 * Phase 26: Liveness Detection
 *
 * 主動活體偵測（註冊）：使用者需完成眨眼+轉頭兩步挑戰（Face ID 風格）
 * 被動活體偵測（登入）：背景偵測自然眨眼和微動，無感進行
 */

import { devLog } from '../utils/devLog';
import type { OcclusionResult } from './cnnInference';
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
  /** EAR 低於此值 = 閉眼。v20.10: 0.22 → 0.26 — 用戶實測 0.22 太嚴，
   * 眼睛明顯張開時也判閉眼失敗。0.26 對應實際眨眼瞬間（眼瞼閉合時 EAR ~0.05-0.20） */
  BLINK_EAR: 0.26,
  /** 鼻子 X 偏移超過此值 = 確定左右轉頭 */
  HEAD_TURN_OFFSET: 0.18,
  /** 鼻子 Y 偏移超過此值 = 確定上下抬/低頭（pitch 範圍比 yaw 小，threshold 要更低）*/
  HEAD_PITCH_OFFSET: 0.10,
  /** 回正判定：偏移低於此值 = 已回正。v20.10: 0.06 → 0.12 — 用戶實測 0.06
   * 過嚴卡在「請回正中央」永遠不過 → 12s timeout → 整個挑戰失敗 */
  HEAD_CENTER_OFFSET: 0.12,
  /** 每個主動挑戰超時 (ms) — v20.13: 12s → 8s 配合分階段引導 (左/右/上/下 各獨立 8s)
   *  超時 = 該階段沒收到足夠 zone 幀數 → 整個 challenge 失敗 → user 重試 */
  ACTIVE_CHALLENGE_TIMEOUT: 8000,
  /** 被動偵測需要的最少眨眼次數 */
  PASSIVE_MIN_BLINKS: 1,
  /** 被動偵測需要的最少微動量 */
  PASSIVE_MIN_MOTION: 0.005,
  /** 被動偵測超時 (ms) */
  /** v20.11: 5s → 15s — 用戶實測 5s 太短，HSV 守門 + 相機啟動時間 + 自然眨眼 一輪可能不夠 */
  PASSIVE_TIMEOUT: 15000,
} as const;

// ============================================================================
// Active Liveness (Registration)
// ============================================================================

/**
 * 主動活體偵測器
 *
 * 註冊時使用（Apple Face ID 風格 3D 掃描）：
 *   1. 眨眼（活體確認）
 *   2. 慢速左右掃描（一次完成：右轉 → 左轉 → 回正）
 *
 * 持續錄影收集 CapturedFrame[]（每 100ms 一幀），
 * 供 structuralId.ts 的 build3DModel() 建立精確的 3D 骨骼模型
 */
export class ActiveLivenessDetector {
  // v20.13 五階段（取代舊「+字掃描」狀態機）：
  //   blink → turn_left → turn_right → turn_up → turn_down
  // 每階段獨立 8s timeout（ACTIVE_CHALLENGE_TIMEOUT）。
  // 階段完成判定改用「zone-coverage」— useFaceRecognition 收滿該方向的 yaw zone 後
  // 呼叫 markCurrentChallengeDone() 推進。**不**再用 noseOffsetX threshold。
  private challenges: LivenessChallenge[] = ['blink', 'turn_left', 'turn_right', 'turn_up', 'turn_down'];
  private currentIndex = 0;
  private challengeStartTime = 0;
  private completed: Map<LivenessChallenge, LivenessChallengeStatus> = new Map();
  private wasEyesClosed = false;
  private _lastEarLog = 0;
  /** 自適應眨眼偵測：收集基線 openness（pixel-based），用相對下降偵測。
   *  改 openness 取代 EAR — EAR landmark 戴眼鏡時被鏡框卡住不可靠（見 cnnInference.computeEyeOpenness） */
  private opennessBaseline = 0;
  private opennessSamples: number[] = [];
  private opennessBaselineReady = false;
  /** 由 useFaceRecognition 每幀注入：當前的眼部 pixel 睜眼度（avg of L/R） */
  private latestOpenness = 1;
  /** 由 useFaceRecognition 在 zone 收滿時呼叫，標記當前 turn 階段完成 */
  private currentTurnDone = false;
  /** Phase 26b: 挑戰期間 embedding 快照 */
  private snapshots: ChallengeEmbeddingSnapshot[] = [];
  /** 遮擋挑戰是否已注入（防止重複注入） */
  private occlusionInjected = false;
  /** 外部傳入的遮擋偵測函式 */
  private occlusionGetter: (() => OcclusionResult) | null = null;

  constructor() {
    this.reset();
  }

  /** 重置偵測器 */
  reset(): void {
    this.challenges = ['blink', 'turn_left', 'turn_right', 'turn_up', 'turn_down'];
    this.currentIndex = 0;
    this.challengeStartTime = Date.now();
    this.wasEyesClosed = false;
    this.opennessBaseline = 0;
    this.opennessSamples = [];
    this.opennessBaselineReady = false;
    this.latestOpenness = 1;
    this._lastEarLog = 0;
    this.currentTurnDone = false;
    this.snapshots = [];
    this.occlusionInjected = false;
    this.completed = new Map([
      ['blink', 'waiting'],
      ['turn_left', 'waiting'],
      ['turn_right', 'waiting'],
      ['turn_up', 'waiting'],
      ['turn_down', 'waiting'],
    ]);
  }

  /** 設定遮擋偵測函式（由 hook 注入） */
  setOcclusionGetter(getter: () => OcclusionResult): void {
    this.occlusionGetter = getter;
  }

  /**
   * 預收 blink baseline sample（face 偵測到後、blink 挑戰真正開始之前呼叫）
   *
   * 為什麼要這個 API：blink 挑戰開始就立即收 baseline，user 第一次眨眼很常掉進
   * baseline window 被 break 丟掉（影片只眨一次的場景永遠過不了）。
   * 改成 face 一被偵測到就開始預收，等 baseline ready 才把 UI 切到 'challenge'
   * 顯示「請眨眼」prompt — user 看到 prompt 時 baseline 已準備好，第一次眨眼直接被偵測。
   *
   * v20.13 改 openness 取代 EAR（pixel-based 比 landmark 距離可靠）。
   */
  collectOpennessBaselineSample(openness: number): void {
    if (this.opennessBaselineReady) return;
    this.opennessSamples.push(openness);
    if (this.opennessSamples.length >= 10) {
      const sorted = [...this.opennessSamples].sort((a, b) => a - b);
      this.opennessBaseline = sorted[Math.floor(sorted.length / 2)];
      this.opennessBaselineReady = true;
      // v20.13: baseline ready 才是 user 看到「請眨眼」prompt 的時刻 —
      // 從此刻起算 8s 才公平（baseline 收集時間不該扣 user 的 budget）
      this.challengeStartTime = Date.now();
      console.error(`[Liveness] Blink baseline: openness=${this.opennessBaseline.toFixed(3)} (from ${this.opennessSamples.length} samples, pre-challenge)`);
    }
  }

  /** 由 useFaceRecognition 每幀注入當前 openness — 給 evaluate() 跑 blink 判定用 */
  setLatestOpenness(openness: number): void {
    this.latestOpenness = openness;
  }

  /** Blink baseline 是否已收集完成（達 10 sample） */
  isOpennessBaselineReady(): boolean {
    return this.opennessBaselineReady;
  }

  /**
   * 注入遮擋挑戰到序列最前面（在 blink 之前）
   * 只在首次偵測到遮擋時呼叫，不會重複注入
   */
  injectOcclusionChallenges(occlusion: OcclusionResult): void {
    if (this.occlusionInjected) return;
    this.occlusionInjected = true;

    const toInject: LivenessChallenge[] = [];
    if (occlusion.hasMask) toInject.push('remove_mask');

    if (toInject.length === 0) return;

    // 插入到序列最前面
    this.challenges = [...toInject, ...this.challenges];
    // 重置 index 到 0（從遮擋挑戰開始）
    this.currentIndex = 0;
    this.challengeStartTime = Date.now();
    // 重置眨眼狀態，避免中斷的 blink 進度導致之後自動通過
    this.wasEyesClosed = false;

    // 更新 completed map
    for (const c of toInject) {
      this.completed.set(c, 'waiting');
    }

    devLog('[Liveness] Occlusion challenges injected:', toInject);
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

  /** v20.13 取得當前 turn 階段命中狀態（給 UI 進度顯示用 — 取代舊 +字 scanHits）
   *  phase 對映：blink→'yaw'、turn_left→'yaw'、turn_right→'yaw'、turn_up→'pitch'、turn_down→'pitch'、其他→'final_center' */
  getScanHits(): { right: boolean; left: boolean; up: boolean; down: boolean; phase: 'yaw' | 'pitch' | 'final_center' } {
    const cur = this.getCurrentChallenge();
    const completed = (c: LivenessChallenge) => this.completed.get(c) === 'detected';
    let phase: 'yaw' | 'pitch' | 'final_center' = 'yaw';
    if (cur === 'turn_up' || cur === 'turn_down') phase = 'pitch';
    else if (cur === null) phase = 'final_center';
    return {
      left: completed('turn_left'),
      right: completed('turn_right'),
      up: completed('turn_up'),
      down: completed('turn_down'),
      phase,
    };
  }

  /** 由 useFaceRecognition 在「當前 turn 階段的 zone 收滿目標幀」時呼叫，標記階段完成 */
  markCurrentTurnDone(): void {
    this.currentTurnDone = true;
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
    const noseX = geometry.noseOffsetX;

    // Openness/EAR 診斷輸出
    // - Prod：每 2 秒 throttle 一次（防 log flood）
    // - Debug (localStorage.AEGIS_EAR_DUMP=true)：每幀都印（spec 收集完整時間軸用）
    if (challenge === 'blink') {
      let earDump = false;
      try { earDump = typeof localStorage !== 'undefined' && localStorage.getItem('AEGIS_EAR_DUMP') === 'true'; } catch { /* SSR */ }
      const shouldLog = earDump || !this._lastEarLog || Date.now() - this._lastEarLog > 2000;
      if (shouldLog) {
        if (!earDump) this._lastEarLog = Date.now();
        console.error(`[Liveness] openness:${this.latestOpenness.toFixed(3)} EAR:${avgEAR.toFixed(3)} closed:${this.wasEyesClosed}`);
      }
    }

    switch (challenge) {
      case 'remove_mask': {
        // 遮擋挑戰：等待用戶移除口罩
        if (this.occlusionGetter) {
          const current = this.occlusionGetter();
          if (!current.hasMask) {
            devLog('[Liveness] Mask removed');
            this.completed.set('remove_mask', 'detected');
            this.advanceChallenge();
          }
        }
        break;
      }

      case 'blink': {
        // v20.13 改 openness (pixel-based) 取代 EAR (landmark-based)：
        //   戴眼鏡時 MediaPipe 把 eye landmark 卡在鏡框邊，EAR 變化幅度被壓縮 (0.10-0.15)，
        //   閉眼閾值差千分之幾就過不了。改用眼部 region pixel 級分析（虹膜深色 / luminance variance），
        //   不依賴 landmark 距離。
        //
        // openness 由 useFaceRecognition.handleRegisterFrame 每幀呼叫 setLatestOpenness 注入。
        // baseline 由 collectOpennessBaselineSample 預收（face_detected 階段、blink 挑戰開始前）。
        if (!this.opennessBaselineReady) {
          // baseline 沒 ready 通常不會走到這（pre-challenge collection 處理）。
          // 保險：若未 ready，這裡也收 sample（fallback）
          this.opennessSamples.push(this.latestOpenness);
          if (this.opennessSamples.length >= 10) {
            const sorted = [...this.opennessSamples].sort((a, b) => a - b);
            this.opennessBaseline = sorted[Math.floor(sorted.length / 2)];
            this.opennessBaselineReady = true;
            console.error(`[Liveness] Blink baseline (fallback): openness=${this.opennessBaseline.toFixed(3)}`);
          }
          break;
        }

        // 閉眼判定：openness 掉到 baseline × 40% 以下 = 閉
        const closeThreshold = this.opennessBaseline * 0.4;
        // 睜眼判定：openness 回到 baseline × 50% 以上 = 重新睜開
        // （從深閉的 0.10 升回 0.5 已是明顯睜眼動作，不必非得回到 baseline）
        const openThreshold = this.opennessBaseline * 0.5;

        if (this.latestOpenness < closeThreshold) {
          this.wasEyesClosed = true;
        } else if (this.wasEyesClosed && this.latestOpenness > openThreshold) {
          console.error(`[Liveness] Blink detected! openness=${this.latestOpenness.toFixed(3)} baseline=${this.opennessBaseline.toFixed(3)} close<${closeThreshold.toFixed(3)} open>${openThreshold.toFixed(3)}`);
          this.completed.set('blink', 'detected');
          this.advanceChallenge();
        }
        break;
      }

      case 'turn_head':       // 舊型 (留作 backward compat，不會被新 challenges list 觸發)
      case 'turn_right':
      case 'turn_left':
      case 'turn_up':
      case 'turn_down': {
        // v20.13 分階段：完成判定改由 useFaceRecognition 收滿該方向 zone 後呼叫
        // markCurrentTurnDone() 設定 currentTurnDone=true 推進。**不**再用 noseOffsetX threshold。
        // Stage timeout (8s) 由 processFrame 開頭的通用 timeout 檢查負責 → 自動 fail。
        if (this.currentTurnDone) {
          console.error(`[Liveness] ${challenge} complete (zone target reached)`);
          this.completed.set(challenge, 'detected');
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
    this.challengeStartTime = Date.now();  // ← 每階段獨立 timeout 計時
    this.wasEyesClosed = false;
    this.currentTurnDone = false;          // ← 重置 zone-coverage 旗標供下一階段
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
      // v20.13: 改用「任一先前階段已完成 OR 眼睛閉過」當「scan 進行中」訊號
      const anyPrior = this.completed.get('turn_left') === 'detected'
        || this.completed.get('turn_right') === 'detected'
        || this.completed.get('turn_up') === 'detected'
        || this.completed.get('turn_down') === 'detected';
      return this.wasEyesClosed || anyPrior ? 'during' : 'before';
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
