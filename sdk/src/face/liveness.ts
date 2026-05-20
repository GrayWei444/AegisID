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
  /** Active challenges timeout (ms) — 通用 fallback。各 challenge 可有專屬 timeout：
   *  blink → 8s, turn_head → 30s（4 個方向 free-order 偵測，總時間預算） */
  ACTIVE_CHALLENGE_TIMEOUT: 30000,
  BLINK_TIMEOUT: 8000,
  TURN_HEAD_TIMEOUT: 30000,
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
  // v20.13b 兩階段 challenge + free-order turn 偵測：
  //   blink (8s timeout) → turn_head (30s timeout, 4 directions free-order)
  // turn_head 完成判定：4 個方向（左/右/上/下）的 yaw/pitch zone 都被收滿（任意順序）。
  // UI prompt 依「下一個未完成」順序顯示（左 → 右 → 上 → 下），但實際完成順序自由。
  // 為什麼 free-order：用戶轉頭順序不一定，影片時序也不固定 — 偵測到實際轉到位才算數。
  private challenges: LivenessChallenge[] = ['blink', 'turn_head'];
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
  /** turn_head 4 個方向命中狀態，free-order。由 useFaceRecognition 在 zone 收滿時呼叫 markTurnDirection 設定 */
  private turnHits = { left: false, right: false, up: false, down: false };
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
    // 預設兩階段。E2E 可透過 localStorage.AEGIS_E2E_FACE_PHASE 設定單階段測試：
    //   'blink-only' → 只跑 blink（用 face-blink.y4m 測 blink 演算法）
    //   'turn-only'  → 只跑 turn（用 face-turn.y4m 測 turn 演算法）
    //   未設或 'all'  → 兩階段都跑（正式登入流程）
    // 真實用戶不會設這 flag，所以 prod 永遠是兩階段。
    let phase: string | null = null;
    try { phase = typeof localStorage !== 'undefined' ? localStorage.getItem('AEGIS_E2E_FACE_PHASE') : null; } catch { /* SSR */ }
    if (phase === 'blink-only') this.challenges = ['blink'];
    else if (phase === 'turn-only') this.challenges = ['turn_head'];
    else this.challenges = ['blink', 'turn_head'];
    this.currentIndex = 0;
    this.challengeStartTime = Date.now();
    this.wasEyesClosed = false;
    this.opennessBaseline = 0;
    this.opennessSamples = [];
    this.opennessBaselineReady = false;
    this.latestOpenness = 1;
    this._lastEarLog = 0;
    this.turnHits = { left: false, right: false, up: false, down: false };
    this.snapshots = [];
    this.occlusionInjected = false;
    this.completed = new Map(this.challenges.map(c => [c, 'waiting' as LivenessChallengeStatus]));
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

  /** turn_head 4 方向命中狀態（給 UI 進度顯示用） */
  getScanHits(): { right: boolean; left: boolean; up: boolean; down: boolean; phase: 'yaw' | 'pitch' | 'final_center' } {
    // phase 依 UI 顯示「下一個未完成方向」決定：左/右 → yaw, 上/下 → pitch
    const next = this.getNextPendingTurnDirection();
    let phase: 'yaw' | 'pitch' | 'final_center' = 'yaw';
    if (next === 'up' || next === 'down') phase = 'pitch';
    else if (next === null) phase = 'final_center';
    return {
      left: this.turnHits.left,
      right: this.turnHits.right,
      up: this.turnHits.up,
      down: this.turnHits.down,
      phase,
    };
  }

  /** 由 useFaceRecognition 在「該方向 zone 收滿」時呼叫，標記該方向完成（free-order） */
  markTurnDirection(direction: 'left' | 'right' | 'up' | 'down'): void {
    if (!this.turnHits[direction]) {
      this.turnHits[direction] = true;
      console.error(`[Liveness] Turn ${direction} detected (free-order)`);
    }
  }

  /** UI 用：取得下一個未完成方向
   *  v20.14: 左右一組、上下一組（不強制單向順序，但兩組內成對）：
   *    - 左右組都沒完 → 提示 'left'（任選一邊起步）
   *    - 左右組只一邊完 → 提示另一邊
   *    - 左右完 → 進入上下組（同樣邏輯）
   *    - 上下完 → null（done）
   */
  getNextPendingTurnDirection(): 'left' | 'right' | 'up' | 'down' | null {
    // Group 1: yaw — 左右
    if (!this.turnHits.left || !this.turnHits.right) {
      if (!this.turnHits.left && !this.turnHits.right) return 'left';
      return this.turnHits.left ? 'right' : 'left';
    }
    // Group 2: pitch — 上下
    if (!this.turnHits.up || !this.turnHits.down) {
      if (!this.turnHits.up && !this.turnHits.down) return 'up';
      return this.turnHits.up ? 'down' : 'up';
    }
    return null;
  }

  /**
   * 處理一幀臉部幾何
   * @returns true 如果所有挑戰完成
   */
  processFrame(geometry: FaceGeometry): boolean {
    const challenge = this.getCurrentChallenge();
    if (!challenge) return true; // 全部完成

    // 檢查超時（per-challenge）
    const timeoutMs = challenge === 'blink' ? THRESHOLDS.BLINK_TIMEOUT
      : (challenge === 'turn_head' || challenge === 'turn_left' || challenge === 'turn_right' || challenge === 'turn_up' || challenge === 'turn_down')
        ? THRESHOLDS.TURN_HEAD_TIMEOUT
        : THRESHOLDS.ACTIVE_CHALLENGE_TIMEOUT;
    if (Date.now() - this.challengeStartTime > timeoutMs) {
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

      case 'turn_head':
      case 'turn_right':       // 舊型 backward compat
      case 'turn_left':
      case 'turn_up':
      case 'turn_down': {
        // v20.13b free-order：4 個方向（左/右/上/下）各自由 useFaceRecognition 在 zone
        // 收滿時呼叫 markTurnDirection('left'/'right'/'up'/'down') 設定。
        // 全部 4 個 hit → challenge 完成。順序自由（影片時序/用戶習慣不固定）。
        if (this.turnHits.left && this.turnHits.right && this.turnHits.up && this.turnHits.down) {
          console.error('[Liveness] Turn challenge complete — all 4 directions hit');
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
    // turnHits 不重置 — free-order 模式下偵測到的方向跨 challenge 持續累積
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
