/**
 * Face Recognition Hook — 骨骼比率系統 (structuralId)
 *
 * 管理相機串流、臉部偵測迴圈、活體狀態機
 *
 * 兩種模式：
 * - register: 主動活體偵測（眨眼+轉頭），收集 CapturedFrame[] → computeStructuralId()
 * - verify: 被動活體偵測（自然眨眼+微動），收集正面 frames → matchLoginBins()
 *
 * Anti-spoof 仍使用 MiniFASNet CNN。
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { devLog, devWarn } from '../utils/devLog';
import {
  initFaceLandmarker,
  detectFace,
  extractFaceGeometry,
} from './faceMesh';
import {
  ActiveLivenessDetector,
  PassiveLivenessDetector,
} from './liveness';
import {
  computeStructuralId,
  matchLoginLSH,
} from './structuralId';
import type { CapturedFrame, Landmark3D } from './structuralId';
import {
  initCnnModels,
  isCnnReady,
  detectSpoof,
  closeCnnModels,
  resetBboxSmoothing,
  recordFrame,
  getOcclusionResult,
  computeEyeOpenness,
  type OcclusionResult,
} from './cnnInference';
import {
  saveBoneRatioData,
  getBoneRatioData,
} from './storage';
import {
  framePass as gateFramePass,
  calibrateBaseline as gateCalibrateBaseline,
  loadBaseline as gateLoadBaseline,
  saveBaseline as gateSaveBaseline,
  type GateBaseline,
} from './occlusionGate';
import type {
  FaceDetectionStatus,
  FaceDetectionResult,
  FaceLandmark,
  LivenessChallenge,
  LivenessResult,
  AntiSpoofResult,
  SpoofDetectionResult,
  BoneRatioPlainData,
} from './types';

// ============================================================================
// Constants
// ============================================================================

/** 登入比對閾值 (骨骼比率 matchRate) */
const LOGIN_MATCH_THRESHOLD = 0.80;

/** 最少擷取幀數（verify 模式） */
const MIN_VERIFY_FRAMES = 5;

/** 偵測迴圈間隔 (ms) */
// 200ms = 5fps detection. 100ms 在 Android Chrome 會 GPU pipeline backlog 卡死。
// 5fps 對眨眼/轉頭活體偵測足夠（眨眼動作 100-300ms，轉頭數秒）。
const DETECTION_INTERVAL = 200;
/** v20.14: detection throttle in **video time** (seconds).
 *  detection loop 改 requestVideoFrameCallback 逐 video frame 觸發，
 *  用 mediaTime (video timestamp) throttle → 同影片每次跑取到完全相同的 video frame 序列
 *  → 收到完全相同 frame 集合 → hash2D + hash3D 都 deterministic。
 *  真實 camera: mediaTime ≈ wall clock，行為不變（每 200ms detect 一次）。 */
const DETECTION_INTERVAL_SEC = 0.2;

/** 註冊模式：同 zone 最小擷取間隔 (ms)，避免同角度過多重複幀 */
const REGISTER_CAPTURE_INTERVAL = 120;
/** Capture throttle in **video time** (seconds), not wall clock.
 *  真實 camera: video.currentTime ≈ wall clock，行為不變
 *  fake camera: video time deterministic on video content → 同影片跨次跑同 frame 集合 */
const REGISTER_CAPTURE_INTERVAL_SEC = 0.12;
/** v20.14: 每方向 done 需累積的 frames 數量
 *  - 對應 v15 「累積足夠 frames」設計
 *  - 不分淺/深 zone，該方向總和 ≥ N 即算轉到位
 *  - 真實 user 持續轉到 prompt 提示「下一個方向」即可
 *  - fake camera：影片中 user 在某方向停留時間 / capture interval = 累積 frames */
const TURN_DONE_FRAMES = 4;

/**
 * Yaw zone 定義
 * v20.14: 擴大 far-* 邊界涵蓋 v20.13d faceWidth-based yaw 範圍（peak 1.6+）。
 *   原 max=0.50 / min=-0.50 切點是 v17 eyeSpan-based yaw 範圍下的設計，
 *   v20.13d yaw 公式改 faceWidth 後 peak 1.2-1.6，深側臉幀會 fallback 回 center →
 *   far-left/far-right zone 永遠收不到深側臉。改 10 / -10 確保深側臉都進對應 zone。
 */
const YAW_ZONES = [
  { min: 0.20, max: 10, target: 4 },   // far-left（v20.14 max 0.50→10）
  { min: 0.08, max: 0.20, target: 4 }, // left
  { min: -0.08, max: 0.08, target: 6 }, // center
  { min: -0.20, max: -0.08, target: 4 }, // right
  { min: -10, max: -0.20, target: 4 }, // far-right（v20.14 min -0.50→-10）
] as const;

// v20.7: pitch zones — 上下也收幀（增加 3D triangulation 多樣性）
// v20.14: 同樣擴大 far-* 邊界 + 統一 target=4 (跟 TURN_DONE_FRAMES 對齊)
const PITCH_ZONES = [
  { min: 0.18, max: 10, target: 4 },   // far-up
  { min: 0.08, max: 0.18, target: 4 }, // up (3→4: 對齊 TURN_DONE_FRAMES)
  { min: -0.08, max: 0.08, target: 0 }, // center pitch
  { min: -0.18, max: -0.08, target: 4 }, // down (3→4)
  { min: -10, max: -0.18, target: 4 }, // far-down
] as const;

function getYawZone(yaw: number): number {
  for (let i = 0; i < YAW_ZONES.length; i++) {
    if (yaw >= YAW_ZONES[i].min && yaw < YAW_ZONES[i].max) return i;
  }
  if (yaw >= 0.50) return 0;
  if (yaw < -0.50) return 4;
  return 2;
}

function getPitchZone(pitch: number): number {
  for (let i = 0; i < PITCH_ZONES.length; i++) {
    if (pitch >= PITCH_ZONES[i].min && pitch < PITCH_ZONES[i].max) return i;
  }
  if (pitch >= 0.50) return 0;
  if (pitch < -0.50) return 4;
  return 2;
}

/** CNN 推論間隔 (ms) — 每 500ms 跑一次 CNN */
const CNN_INTERVAL = 500;

/** 診斷日誌間隔 (ms) */
const DIAGNOSTIC_LOG_INTERVAL = 3000;

// ============================================================================
// Types
// ============================================================================

export interface UseFaceRecognitionOptions {
  /** 註冊 or 驗證 */
  mode: 'register' | 'verify';
  /** 比對閾值（verify 模式），default 0.80 */
  matchThreshold?: number;
  /** 自動登入閾值（verify 模式），default 0.85 */
  autoLoginThreshold?: number;
}

export interface VerifyFaceResult {
  matched: boolean;
  similarity: number;
  autoLoginReady: boolean;
}

interface UseFaceRecognitionReturn {
  /** 目前偵測狀態 */
  status: FaceDetectionStatus;
  /** 目前活體挑戰（僅 register 模式） */
  currentChallenge: LivenessChallenge | null;
  /** v20.13b turn_head 階段下一個未完成的方向（UI prompt 用） */
  nextTurnDirection: 'left' | 'right' | 'up' | 'down' | null;
  /** 活體挑戰進度 */
  challengeProgress: { current: number; total: number };
  /** 活體偵測結果 */
  livenessResult: LivenessResult | null;
  /** 骨骼比率 matchRate（verify 模式） */
  similarity: number | null;
  /** 是否已驗證通過 */
  isVerified: boolean;
  /** CNN 模型是否就緒 */
  cnnReady: boolean;
  /** 防偽分析結果 */
  antiSpoofResult: AntiSpoofResult | null;
  /** 遮擋偵測結果（口罩/帽子） */
  occlusion: OcclusionResult;
  /** 3D 掃描 zone 進度（註冊模式）: { left, center, right } */
  scanZones: { left: number; center: number; right: number } | null;
  /** v20.3 +字掃描四向命中狀態（給進度 UI）*/
  scanHits: { right: boolean; left: boolean; up: boolean; down: boolean; phase: 'yaw' | 'pitch' | 'final_center' } | null;
  /** 3D 掃描 zone 目標幀數 */
  scanZoneTargets: { left: number; center: number; right: number };
  /** 目前掃描引導階段 */
  scanPhase: 'center' | 'right' | 'left' | 'complete' | null;
  /** 剛完成的挑戰（顯示 ✓ 過渡動畫用，持續 ~1 秒後清除） */
  completedChallenge: LivenessChallenge | null;
  /** 當前 yaw 值（頭部方向，-0.5=右 ~ 0.5=左） */
  currentYaw: number;
  /** video element ref */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** v20 Gate baseline 是否已校準（從 localStorage 載入或剛 calibrateGate）*/
  gateBaselineReady: boolean;
  /** v20 Gate 當前幀遮擋狀態（null = OK；{region} = 該區域遮擋）*/
  gateOcclusion: { region: string | null } | null;
  /** v20 Gate 校準 — 採 ~2s 乾淨臉建 baseline，存 localStorage 持久化 */
  calibrateGate: (durationMs?: number) => Promise<boolean>;
  /** 啟動相機 + 偵測 */
  startCamera: () => Promise<void>;
  /** 停止相機 */
  stopCamera: () => void;
  /** 註冊臉部（register 模式完成後呼叫） */
  registerFace: (encryptionKey: CryptoKey) => Promise<boolean>;
  /** 驗證臉部（verify 模式，自動執行） */
  verifyFace: (encryptionKey: CryptoKey) => Promise<VerifyFaceResult>;
  /** 重置狀態 */
  reset: () => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useFaceRecognition({
  mode,
  matchThreshold = LOGIN_MATCH_THRESHOLD,
  autoLoginThreshold = 0.85,
}: UseFaceRecognitionOptions): UseFaceRecognitionReturn {
  const [status, setStatus] = useState<FaceDetectionStatus>('idle');
  const [currentChallenge, setCurrentChallenge] = useState<LivenessChallenge | null>(null);
  const [nextTurnDirection, setNextTurnDirection] = useState<'left' | 'right' | 'up' | 'down' | null>(null);
  const [challengeProgress, setChallengeProgress] = useState({ current: 0, total: 2 });
  const [livenessResult, setLivenessResult] = useState<LivenessResult | null>(null);
  const [similarity, setSimilarity] = useState<number | null>(null);
  const [isVerified, setIsVerified] = useState(false);
  const [cnnReady, setCnnReady] = useState(false);
  const [antiSpoofResult, setAntiSpoofResult] = useState<AntiSpoofResult | null>(null);
  const [scanZones, setScanZones] = useState<{ left: number; center: number; right: number } | null>(null);
  const [scanHits, setScanHits] = useState<{ right: boolean; left: boolean; up: boolean; down: boolean; phase: 'yaw' | 'pitch' | 'final_center' } | null>(null);
  const [currentYaw, setCurrentYaw] = useState<number>(0);
  const [scanPhase, setScanPhase] = useState<'center' | 'right' | 'left' | 'complete' | null>(null);
  const [completedChallenge, setCompletedChallenge] = useState<LivenessChallenge | null>(null);
  const prevChallengeRef = useRef<LivenessChallenge | null>(null);
  const challengePausedRef = useRef(false);

  // Zone targets（5 zone 合併成 3 組顯示）
  const scanZoneTargets = {
    left: YAW_ZONES[0].target + YAW_ZONES[1].target,    // far-left + left
    center: YAW_ZONES[2].target,                          // center
    right: YAW_ZONES[3].target + YAW_ZONES[4].target,   // right + far-right
  };

  // Keep statusRef in sync with state
  const setStatusAndRef = useCallback((s: FaceDetectionStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  /** v20.14: requestVideoFrameCallback handle（用於 stopCamera cancel） */
  const rvfcHandleRef = useRef<number>(0);
  /** v20.14: detection throttle 用 video time（mediaTime），deterministic on video content */
  const lastDetectVideoTimeRef = useRef<number>(0);
  const activeDetectorRef = useRef<ActiveLivenessDetector | null>(null);
  const passiveDetectorRef = useRef<PassiveLivenessDetector | null>(null);
  const isRunningRef = useRef(false);
  const lastTimestampRef = useRef(0);
  const statusRef = useRef<FaceDetectionStatus>('idle');

  // 骨骼比率系統：收集 CapturedFrame[]
  const capturedFramesRef = useRef<CapturedFrame[]>([]);
  // 註冊完成後暫存的骨骼比率結果
  const boneRatioResultRef = useRef<BoneRatioPlainData | null>(null);
  // Yaw zone 計數（註冊模式，確保左/中/右均勻分佈）
  const zoneCountsRef = useRef<number[]>([0, 0, 0, 0, 0]);
  // v20.7: pitch zone 計數（搭配 PITCH_ZONES）
  const pitchZoneCountsRef = useRef<number[]>([0, 0, 0, 0, 0]);
  const lastCaptureMsRef = useRef(0);
  /** v20.14: video.currentTime-based capture throttle (取代 wall clock) */
  const lastCaptureVideoTimeRef = useRef(0);

  // Anti-spoof 相關 refs
  const lastCnnTimestampRef = useRef(0);
  const spoofVotesRef = useRef<SpoofDetectionResult[]>([]);
  const cnnRunningRef = useRef(false);

  // Verify mode: 被動活體已通過但尚未完成
  const livenessPassedRef = useRef(false);
  // v20.6: 遮擋判斷只在挑戰前 check 一次。一旦過 → 整個挑戰流程不再 gate
  const occlusionConfirmedRef = useRef(false);

  // Diagnostic counters
  const faceDetectedCountRef = useRef(0);
  const noFaceCountRef = useRef(0);
  const lastDiagnosticLogRef = useRef(0);
  const firstFaceLoggedRef = useRef(false);

  // v20 Occlusion Gate state
  const gateBaselineRef = useRef<GateBaseline | null>(null);
  const [gateBaselineReady, setGateBaselineReady] = useState(false);
  const [gateOcclusion, setGateOcclusion] = useState<{ region: string | null } | null>(null);
  const gateRejectedFramesRef = useRef(0);

  // Load baseline on mount (cached from previous calibration)
  useEffect(() => {
    gateLoadBaseline().then((b) => {
      gateBaselineRef.current = b;
      setGateBaselineReady(b !== null);
      if (b) devLog('[FaceRec/Gate] Baseline loaded (n=', b.n, ', ts=', new Date(b.ts).toISOString(), ')');
      else devLog('[FaceRec/Gate] No baseline — calibrateGate() must be called before register/verify');
    });
  }, []);

  // =========================================================================
  // Camera Management
  // =========================================================================

  const startCamera = useCallback(async () => {
    try {
      setStatusAndRef('loading');

      // Reset bbox smoothing for new session
      resetBboxSmoothing();

      // 先啟動相機 + MediaPipe（必須），CNN 在背景載入（不阻塞相機啟動）
      // 不寫死 width/height — 手機前鏡頭 sensor native 多為 portrait (720x1280 等)，
      // 強制要求 640x480 會讓瀏覽器把畫面壓進 4:3 框，產生 vertically-squashed 畫面，
      // MediaPipe landmark Y 軸全擠在一起 (EAR ~0.039)。讓瀏覽器給原生比例最穩。
      // facingMode: 'user' = 前鏡頭。失敗則 fallback 不指定（E2E / 容器環境）
      let cameraStream: MediaStream | null = null;
      const mediapipePromise = initFaceLandmarker();
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
        });
      } catch (firstErr) {
        console.error('[FaceRec] Camera facingMode:user failed, trying fallback:', (firstErr as any)?.name);
        try {
          cameraStream = await navigator.mediaDevices.getUserMedia({
            video: true,
          });
          console.error('[FaceRec] Camera fallback succeeded (no constraint)');
        } catch (secondErr) {
          console.error('[FaceRec] Camera fallback also failed:', (secondErr as any)?.name, (secondErr as any)?.message);
          throw secondErr;
        }
      }
      const [cameraResult, mediapipeResult] = await Promise.allSettled([
        Promise.resolve(cameraStream),
        mediapipePromise,
      ]);

      // 相機是必須的
      if (cameraResult.status === 'rejected' || !cameraResult.value) {
        const err = cameraResult.status === 'rejected' ? cameraResult.reason as { name?: string; message?: string } : { name: 'NoStream' };
        console.error('[FaceRec] Camera unavailable:', err?.name);
        throw cameraResult.status === 'rejected' ? cameraResult.reason : new Error('No camera stream');
      }
      // MediaPipe 是必須的
      if (mediapipeResult.status === 'rejected') {
        throw mediapipeResult.reason;
      }

      // Anti-spoof 模型在背景載入（612KB，不阻塞相機啟動）
      if (!isCnnReady()) {
        initCnnModels().then(() => {
          setCnnReady(true);
          devLog('[FaceRec] Anti-spoof model ready (background)');
        }).catch((err) => {
          devWarn('[FaceRec] Anti-spoof model failed to load:', err);
        });
      } else {
        setCnnReady(true);
        devLog('[FaceRec] Anti-spoof model already cached');
      }

      const stream = cameraResult.value as MediaStream;
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        // DIAG: 印出實際拿到的 video 解析度 + track 設定
        const tracks = stream.getVideoTracks();
        const trackSettings = tracks[0] ? tracks[0].getSettings() : {};
        const trackCapabilities = tracks[0] ? tracks[0].getCapabilities() : {};
        console.error(`[DIAG:CAMERA] video=${videoRef.current.videoWidth}x${videoRef.current.videoHeight} | trackSettings=${JSON.stringify(trackSettings)} | caps.facing=${(trackCapabilities as { facingMode?: string[] }).facingMode?.join?.(',') || 'n/a'}`);

        // DIAG: 等 1 秒讓 video 真的有 frame，從 video 抓一張到 canvas 算統計
        // 確認鏡頭真的有送 pixel 進來、不是黑屏 / 全白 / 凍結
        setTimeout(() => {
          if (!videoRef.current) return;
          const v = videoRef.current;
          const c = document.createElement('canvas');
          c.width = 64; c.height = 64;
          const ctx = c.getContext('2d');
          if (!ctx) return;
          try {
            ctx.drawImage(v, 0, 0, 64, 64);
            const data = ctx.getImageData(0, 0, 64, 64).data;
            let r = 0, g = 0, b = 0, min = 255, max = 0, nonZero = 0;
            for (let i = 0; i < data.length; i += 4) {
              r += data[i]; g += data[i+1]; b += data[i+2];
              const lum = (data[i] + data[i+1] + data[i+2]) / 3;
              if (lum < min) min = lum;
              if (lum > max) max = lum;
              if (lum > 5) nonZero++;
            }
            const px = data.length / 4;
            console.error(`[DIAG:PIXELS] avg R=${(r/px).toFixed(0)} G=${(g/px).toFixed(0)} B=${(b/px).toFixed(0)} | luma min=${min} max=${max} | nonZero=${nonZero}/${px} (${(nonZero/px*100).toFixed(0)}%) | video=${v.videoWidth}x${v.videoHeight} videoTime=${v.currentTime.toFixed(2)}`);
          } catch (e) {
            console.error('[DIAG:PIXELS] drawImage threw:', (e as Error).message);
          }
        }, 1000);
      }

      // 初始化活體偵測器
      if (mode === 'register') {
        activeDetectorRef.current = new ActiveLivenessDetector();
        activeDetectorRef.current.setOcclusionGetter(getOcclusionResult);
        setCurrentChallenge(activeDetectorRef.current.getCurrentChallenge());
        setChallengeProgress(activeDetectorRef.current.getProgress());
      } else {
        passiveDetectorRef.current = new PassiveLivenessDetector();
      }

      setStatusAndRef('ready');
      isRunningRef.current = true;
      startDetectionLoop();

      devLog('[FaceRec] Camera started, mode:', mode);

      // v20.1: 自動校準 gate baseline — 但**必須先確認沒口罩**才能採樣
      // 否則 baseline 記成「戴口罩的你」→ gate 永遠抓不到口罩遮擋
      // isCleanFn 用 HSV+Blendshape 結果，最多等 30 秒讓用戶移除口罩
      // 提示：帽子/墨鏡 HSV 抓不到，UI 必須額外文字提醒「請保持臉部完全露出」
      if (!gateBaselineRef.current) {
        setTimeout(async () => {
          if (gateBaselineRef.current) return;
          if (!videoRef.current || !isRunningRef.current) return;
          devLog('[FaceRec/Gate] Auto-calibrating (等待 HSV 判定無口罩/墨鏡/帽子)...');
          const baseline = await gateCalibrateBaseline(
            videoRef.current,
            (v, ts) => {
              const r = detectFace(v, ts);
              return r ? { faceLandmarks: [r.landmarks] } : null;
            },
            2000,
            // v20.2 三區守門: HSV 沒抓到口罩/墨鏡/帽子才允許採樣
            () => {
              const occ = getOcclusionResult();
              return !occ.hasMask && !occ.hasSunglasses && !occ.hasHat;
            },
            30000,
          );
          if (baseline && !gateBaselineRef.current) {
            await gateSaveBaseline(baseline);
            gateBaselineRef.current = baseline;
            setGateBaselineReady(true);
            devLog('[FaceRec/Gate] Auto-calibrate ok, n=', baseline.n);
          } else {
            devWarn('[FaceRec/Gate] Auto-calibrate failed (HSV 一直判定有口罩 / 採樣不足)');
          }
        }, 1000);
      }
    } catch (err) {
      devWarn('[FaceRec] Camera/model init failed:', err);
      setStatusAndRef('error');
    }
  }, [mode]);

  const stopCamera = useCallback(() => {
    isRunningRef.current = false;

    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }
    // v20.14: cancel requestVideoFrameCallback
    if (rvfcHandleRef.current && videoRef.current && 'cancelVideoFrameCallback' in videoRef.current) {
      (videoRef.current as HTMLVideoElement & { cancelVideoFrameCallback: (h: number) => void })
        .cancelVideoFrameCallback(rvfcHandleRef.current);
      rvfcHandleRef.current = 0;
    }
    lastDetectVideoTimeRef.current = 0;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    devLog('[FaceRec] Camera stopped');
  }, []);

  // =========================================================================
  // Detection Loop
  // =========================================================================

  const startDetectionLoop = useCallback(() => {
    // v20.14: 排程下一幀 — 優先 requestVideoFrameCallback（逐 video frame 觸發，
    //   throttle 用 video time → fake camera deterministic），fallback requestAnimationFrame
    const scheduleNext = () => {
      const v = videoRef.current;
      if (v && 'requestVideoFrameCallback' in v) {
        rvfcHandleRef.current = (v as HTMLVideoElement & {
          requestVideoFrameCallback: (cb: (now: number, metadata: { mediaTime: number }) => void) => number;
        }).requestVideoFrameCallback((_now, metadata) => loop(metadata.mediaTime));
      } else {
        animFrameRef.current = requestAnimationFrame(() => loop(undefined));
      }
    };

    const loop = (mediaTime: number | undefined) => {
      if (!isRunningRef.current) return;

      const video = videoRef.current;
      if (!video || video.readyState < 2) {
        scheduleNext();
        return;
      }

      const now = performance.now();  // wall clock — 給 MediaPipe timestamp + spoof capture
      // v20.14: detection throttle 用 video time（deterministic on video content）
      const vTime = mediaTime ?? video.currentTime;
      if (lastDetectVideoTimeRef.current !== 0 &&
          vTime - lastDetectVideoTimeRef.current < DETECTION_INTERVAL_SEC) {
        scheduleNext();
        return;
      }
      lastDetectVideoTimeRef.current = vTime;

      // 偵測人臉（返回 landmarks + matrix + yaw）
      const detection = detectFace(video, now);

      // Diagnostic logging every 3 seconds
      if (now - lastDiagnosticLogRef.current >= DIAGNOSTIC_LOG_INTERVAL) {
        lastDiagnosticLogRef.current = now;
        console.error(`[FaceRec] Detection: noFace=${noFaceCountRef.current}, face=${faceDetectedCountRef.current}, frames=${capturedFramesRef.current.length}, antiSpoof=${isCnnReady()}`);
      }

      if (!detection) {
        noFaceCountRef.current++;
        // v20.11: debounce — 連續 8 幀無臉才切 'ready'（避免大角度轉頭瞬閃）
        // 30fps 下 8 幀 ≈ 270ms 容忍 → 大角度轉頭單幀 lost detection 不會跳 UI
        if (noFaceCountRef.current >= 8 &&
            statusRef.current !== 'ready' && statusRef.current !== 'loading') {
          setStatusAndRef('ready');
        }
        scheduleNext();
        return;
      }

      // 偵測到人臉 — reset no-face counter
      noFaceCountRef.current = 0;
      faceDetectedCountRef.current++;

      // Log first face detection
      if (!firstFaceLoggedRef.current) {
        firstFaceLoggedRef.current = true;
        devLog(`[FaceRec] First face detected (mode=${mode}, hasMatrix=${!!detection.matrix})`);
        // DIAG: dump raw landmark structure（看 MediaPipe 實際給什麼欄位）
        const lm = detection.landmarks;
        const lm0 = lm[0] as unknown as Record<string, unknown>;
        const lm1 = lm[1] as unknown as Record<string, unknown>;
        console.error(`[DIAG:RAW0] keys=${Object.keys(lm0).join(',')} | values=${JSON.stringify(lm0)} | values[1]=${JSON.stringify(lm1)} | total=${lm.length}`);
        const xs = lm.map(p => p.x);
        const ys = lm.map(p => p.y);
        const xRange = Math.max(...xs) - Math.min(...xs);
        const yRange = Math.max(...ys) - Math.min(...ys);
        const eyeTopY = lm[159].y, eyeBotY = lm[145].y;
        console.error(`[DIAG:LANDMARK] xRange=${xRange.toFixed(3)} yRange=${yRange.toFixed(3)} eyeTopY=${eyeTopY.toFixed(3)} eyeBotY=${eyeBotY.toFixed(3)} eyeDiff=${(eyeBotY - eyeTopY).toFixed(4)} | video=${video.videoWidth}x${video.videoHeight}`);
      }

      const geometry = extractFaceGeometry(detection.landmarks);

      // 記錄 landmarks + video + blendshapes 用於 anti-spoof + 遮擋偵測
      recordFrame(detection.landmarks, video, detection.blendshapes);

      if (mode === 'register') {
        handleRegisterFrame(video, detection, geometry, now);
      } else {
        handleVerifyFrame(video, detection, geometry, now);
      }

      scheduleNext();
    };

    scheduleNext();
  }, [mode, setStatusAndRef]);

  // =========================================================================
  // Anti-Spoof Capture
  // =========================================================================

  /**
   * 每 500ms 執行一次防偽推論
   * 在挑戰期間持續執行，收集防偽投票結果
   */
  const maybeSpoofCapture = useCallback(async (
    video: HTMLVideoElement,
    geometry: ReturnType<typeof extractFaceGeometry>,
    now: number,
  ): Promise<void> => {
    // Anti-spoof 未就緒 or 還在跑上一次 → 跳過
    if (!isCnnReady() || cnnRunningRef.current) return;

    // 500ms 間隔
    if (now - lastCnnTimestampRef.current < CNN_INTERVAL) return;
    lastCnnTimestampRef.current = now;

    cnnRunningRef.current = true;
    try {
      const faceBox = geometry.boundingBox;

      // 只跑防偽推論
      const spoofResult = await detectSpoof(video, faceBox);

      // 累積防偽結果
      spoofVotesRef.current.push(spoofResult);

      devLog(`[FaceRec/AntiSpoof] Vote #${spoofVotesRef.current.length}, confidence: ${spoofResult.confidence.toFixed(3)} (${spoofResult.isReal ? 'real' : 'spoof'})`);
    } catch (err) {
      devWarn('[FaceRec/AntiSpoof] Inference error:', err);
    } finally {
      cnnRunningRef.current = false;
    }
  }, []);

  /**
   * 從累積的防偽投票計算 AntiSpoofResult
   */
  const computeAntiSpoofResult = useCallback((): AntiSpoofResult => {
    const votes = spoofVotesRef.current;
    const realCount = votes.filter(v => v.isReal).length;
    const spoofCount = votes.length - realCount;
    const avgConfidence = votes.length > 0
      ? votes.reduce((s, v) => s + v.confidence, 0) / votes.length
      : 0;

    return {
      cnnScore: avgConfidence,
      cnnVotes: { real: realCount, spoof: spoofCount },
      embeddingConsistency: { blinkDelta: 0, turnEyeRatio: 0, overallVariance: 0 },
      score: avgConfidence,
      isSuspicious: avgConfidence < 0.4 || (votes.length >= 3 && spoofCount > realCount),
    };
  }, []);

  // =========================================================================
  // Register Mode: Active Liveness + 收集 CapturedFrame[]
  // =========================================================================

  const handleRegisterFrame = useCallback((
    video: HTMLVideoElement,
    detection: FaceDetectionResult,
    geometry: ReturnType<typeof extractFaceGeometry>,
    now: number
  ) => {
    const detector = activeDetectorRef.current;
    if (!detector) return;

    // v20.11: 守門前先 set status='face_detected' — 不然占擋幀 return 時 UI 動畫條件不符
    setStatusAndRef('face_detected');

    // === v20.12 註冊遮擋守門 — 全部 register frame 都跑（不限 blink 階段）===
    // 不依賴 baseline，純 HSV 絕對閾值
    //  - 帽子：永遠檢查（額頭可見 regardless of 頭部角度）
    //  - 口罩/墨鏡/半臉：只在 nose 中央時檢查（側臉時 landmarks 角度不對 HSV 誤判）
    if (!detection.landmarks || detection.landmarks.length < 468) {
      setGateOcclusion({ region: 'INCOMPLETE' });
      return;
    }
    const occ = getOcclusionResult();
    const noseX = Math.abs(geometry.noseOffsetX ?? 0);
    const isMostlyFrontal = noseX < 0.15;
    let occlusionRegion: string | null = null;
    // v20.14 fix: 所有遮擋判定（含 HAT）只在正面時做。
    //   原本 HAT「永遠檢查」→ 轉頭側臉時額頭角度變、HSV skin ratio 下降 → 誤判戴帽
    //   → gate 擋住 turn frame → 轉頭 challenge 收不到深側臉 → 卡住失敗（user 真機實測：
    //   「脫帽動畫甚至影響到後面的轉頭」）。側臉時 landmark/HSV 角度不可靠，不該判遮擋。
    //   blink 段為正面，戴帽仍會被擋；通過 blink 後已驗證無帽，turn 側臉不需重複判。
    if (isMostlyFrontal) {
      occlusionRegion =
        occ.hasHat ? 'TOP' :
        occ.hasMask ? 'BOTTOM' :
        occ.hasSunglasses ? 'CENTER' :
        occ.hasHalfFaceLeft ? 'LEFT' :
        occ.hasHalfFaceRight ? 'RIGHT' :
        null;
    }
    {
      if (occlusionRegion) {
        setGateOcclusion({ region: occlusionRegion });
        return;
      }
      // v20.14 fix: 無條件清除 — 原本 `if (gateOcclusion !== null)` guard 讀 useCallback
      //   closure 的 gateOcclusion，但 deps 沒包含它 → closure 永遠是初始 null →
      //   guard 永遠 false → 脫帽後 gate 卡在 {region:TOP} 不消失（user 真機實測 bug）。
      //   改無條件 setGateOcclusion(null)，React 對同值 null dedupe 不 re-render。
      setGateOcclusion(null);
    }

    // 邊挑戰邊擷取防偽推論（async，不阻塞偵測迴圈）
    maybeSpoofCapture(video, geometry, now);

    // v20.10: HSV 遮擋檢查（口罩/墨鏡）獨立於 Gate，但只在 blink 階段判定。
    //   為什麼不依賴 Gate baseline：HSV 用絕對閾值（嘴部該是膚色卻不是 → 口罩），
    //     v20.10: 上方守門已用 HSV 擋住遮擋幀（return 提早），這裡不再注入 challenge

    const challenge = detector.getCurrentChallenge();

    // v20.13b free-order turn 偵測：'turn_head' challenge 4 方向獨立追蹤，順序自由完成
    if (challenge === 'turn_head' || challenge === 'turn_left' || challenge === 'turn_right'
        || challenge === 'turn_up' || challenge === 'turn_down') {
      const yaw = detection.yaw ?? 0;
      const pitch = -(geometry.noseOffsetY ?? 0);  // pitch proxy: noseY<0 = 抬頭
      setCurrentYaw(yaw);

      // Capture throttle：用 video.currentTime（不是 wall clock）
      //   真實 camera：video.currentTime ≈ wall clock，行為不變
      //   fake camera：video time deterministic on video content → 同影片跨次跑收同 frame 集合
      // 單位：秒；120ms = 0.12s
      const videoTime = video.currentTime;
      const elapsedVideo = videoTime - lastCaptureVideoTimeRef.current;
      const intervalMet = elapsedVideo >= REGISTER_CAPTURE_INTERVAL_SEC || lastCaptureVideoTimeRef.current === 0;

      // 收 yaw zone（每幀）
      const zone = getYawZone(yaw);
      const zoneCount = zoneCountsRef.current[zone];
      const zoneTarget = YAW_ZONES[zone].target;
      if (zoneCount < zoneTarget && intervalMet) {
        capturedFramesRef.current.push({
          landmarks: detection.landmarks as unknown as Landmark3D[],
          matrix: detection.matrix ? { data: detection.matrix.data } : undefined,
          yaw,
        });
        zoneCountsRef.current[zone]++;
        lastCaptureVideoTimeRef.current = videoTime;
      }

      // 收 pitch zone（同幀也可同時更新 — 抬/低頭的 yaw 通常在 center 範圍）
      const pzone = getPitchZone(pitch);
      const pcount = pitchZoneCountsRef.current[pzone];
      const ptarget = PITCH_ZONES[pzone].target;
      const intervalMetAgain = (video.currentTime - lastCaptureVideoTimeRef.current) >= REGISTER_CAPTURE_INTERVAL_SEC || lastCaptureVideoTimeRef.current === 0;
      if (ptarget > 0 && pcount < ptarget && intervalMetAgain) {
        capturedFramesRef.current.push({
          landmarks: detection.landmarks as unknown as Landmark3D[],
          matrix: detection.matrix ? { data: detection.matrix.data } : undefined,
          yaw,
        });
        pitchZoneCountsRef.current[pzone]++;
        lastCaptureVideoTimeRef.current = video.currentTime;
      }

      // v20.14: zone-coverage done 判定（取代 v20.13b 的 threshold-only mark）
      //   設計：該方向（淺 + 深 zone）累積 ≥ TURN_DONE_FRAMES 就 mark done
      //   - 對應 v15「累積足夠 frames」設計，不分淺/深強求
      //   - 比 v20.13b 嚴（要 N frames 不是 1 frame），但比「far-* zone 滿」寬鬆（影片中 user
      //     抬頭/轉右可能不夠深，但累積夠多 sample 就足以提供 PnP 視角資料）
      const z = zoneCountsRef.current;
      const pz = pitchZoneCountsRef.current;
      const leftCount  = z[0] + z[1];     // yaw > 0.08（淺左 + 深左）
      const rightCount = z[3] + z[4];     // yaw < -0.08（淺右 + 深右）
      const upCount    = pz[0] + pz[1];   // pitch > 0.08（淺抬 + 深抬）
      const downCount  = pz[3] + pz[4];   // pitch < -0.08（淺低 + 深低）
      if (leftCount  >= TURN_DONE_FRAMES) detector.markTurnDirection('left');
      if (rightCount >= TURN_DONE_FRAMES) detector.markTurnDirection('right');
      if (upCount    >= TURN_DONE_FRAMES) detector.markTurnDirection('up');
      if (downCount  >= TURN_DONE_FRAMES) detector.markTurnDirection('down');

      // Debug zone 分布（AEGIS_EAR_DUMP 時印），每秒至多一次
      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem('AEGIS_EAR_DUMP') === 'true') {
          const nowMs = Date.now();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = window as any;
          if (!w.__lastZoneLog || nowMs - w.__lastZoneLog > 1000) {
            w.__lastZoneLog = nowMs;
            console.error(`[FaceRec] zone yaw=[fl:${z[0]}/${YAW_ZONES[0].target} l:${z[1]}/${YAW_ZONES[1].target} c:${z[2]}/${YAW_ZONES[2].target} r:${z[3]}/${YAW_ZONES[3].target} fr:${z[4]}/${YAW_ZONES[4].target}] pitch=[fu:${pz[0]}/${PITCH_ZONES[0].target} u:${pz[1]}/${PITCH_ZONES[1].target} d:${pz[3]}/${PITCH_ZONES[3].target} fd:${pz[4]}/${PITCH_ZONES[4].target}] yaw=${yaw.toFixed(2)} pitch=${pitch.toFixed(2)}`);
          }
        }
      } catch { /* */ }

      // UI zone 進度
      const merged = {
        left: z[0] + z[1],
        center: z[2],
        right: z[3] + z[4],
      };
      setScanZones({ ...merged });

      // UI 引導 phase：依下一個未完成方向決定 prompt
      const next = detector.getNextPendingTurnDirection();
      setNextTurnDirection(next);
      const phaseMap: Record<string, 'center' | 'right' | 'left' | 'complete'> = {
        left: 'left',
        right: 'right',
        up: 'center',     // 沒有 up phase；用 center 引導 user 抬/低頭時保持中心 yaw
        down: 'center',
      };
      setScanPhase(next ? phaseMap[next] ?? 'complete' : 'complete');
    }

    // v20.3: 把 +字 scanHits 同步到 state（給 PlusProgressBar 顯示）
    if (activeDetectorRef.current) {
      const hits = activeDetectorRef.current.getScanHits();
      setScanHits(hits);
    }

    if (!challenge) {
      // 所有挑戰完成 — 計算骨骼比率 structural ID
      // v20.14 fix: 立刻停 detection loop（isRunningRef=false）— 否則 computeStructuralId 是
      //   async，期間 detection loop（mock 影片 loop / 真實 camera 持續）會跑下一幀，
      //   handleRegisterFrame 開頭 setStatus('face_detected') 覆蓋 'capturing' → AuthScreen
      //   的 `status==='capturing'` 偵測不到 → 卡住沒進下一步。同時 guard 防重複 computeStructuralId。
      if (!isRunningRef.current) return; // 已在計算 → 不重複
      if (capturedFramesRef.current.length > 0) {
        isRunningRef.current = false; // 立刻停 loop，鎖定 status='capturing'
        setStatusAndRef('capturing');
        // 非同步計算 structural ID（SHA-256 需要 await）
        computeStructuralId(capturedFramesRef.current)
          .then((result) => {
            boneRatioResultRef.current = {
              frontalBins: Object.fromEntries(result.frontalBins),
              hash: result.hashes.hashCombined,
              hash2D: result.hashes.hash2D,
              hash3D: result.hashes.hash3D,
              hashCombined: result.hashes.hashCombined,
              lshHash: result.lshHash,
              frontalRaw: { ...result.frontalRaw },
            };

            const antiSpoof = computeAntiSpoofResult();
            const livenessRes = { ...detector.getResult(), antiSpoof };
            setLivenessResult(livenessRes);
            setAntiSpoofResult(antiSpoof);
            isRunningRef.current = false;

            // Hash 一致性診斷 — flag-gated（localStorage AEGIS_FACE_HASH_PROBE）
            // 平時 prod 不印；要驗「同影片同 PIN 同 hash」鐵律時開 flag dump 完整 bins/raw/fingerprint
            try {
              if (typeof localStorage !== 'undefined' && localStorage.getItem('AEGIS_FACE_HASH_PROBE') === 'true') {
                const bins2DArr: Array<[string, number]> = [];
                result.frontalBins.forEach((v, k) => bins2DArr.push([k, v]));
                bins2DArr.sort((a, b) => a[0].localeCompare(b[0]));
                const bins3DArr: Array<[string, number]> = [];
                result.bins3D.forEach((v, k) => bins3DArr.push([k, v]));
                bins3DArr.sort((a, b) => a[0].localeCompare(b[0]));
                const frames = capturedFramesRef.current;
                const r4 = (x: number) => Math.round(x * 10000) / 10000;
                const yawSorted = frames.map((f) => r4(f.yaw ?? 0)).sort((a, b) => a - b);
                const f0 = frames[0]?.landmarks;
                const f0Snap = f0 ? { n: [r4(f0[1].x), r4(f0[1].y), r4(f0[1].z || 0)], yaw: r4(frames[0].yaw ?? 0) } : null;
                console.error(
                  '[FaceRec][HashProbe] hashCombined=' + result.hashes.hashCombined +
                  ' hash2D=' + result.hashes.hash2D +
                  ' hash3D=' + result.hashes.hash3D +
                  ' stable2D=' + result.stableCount2D +
                  ' stable3D=' + result.stableCount3D +
                  ' frames=' + frames.length +
                  ' f0Snap=' + JSON.stringify(f0Snap) +
                  ' yawSorted=' + JSON.stringify(yawSorted) +
                  ' bins2D=' + JSON.stringify(bins2DArr) +
                  ' bins3D=' + JSON.stringify(bins3DArr),
                );
              }
            } catch { /* */ }
            devLog('[FaceRec] Register complete — 2D:', result.hashes.hash2D.slice(0, 12) + '... 3D:', result.hashes.hash3D.slice(0, 12) + '...');
            devLog('[FaceRec] Stable: 2D=' + result.stableCount2D + ' 3D=' + result.stableCount3D);
            devLog('[FaceRec] Frontal bins:', result.frontalBins.size);
            devLog('[FaceRec] Frames collected:', capturedFramesRef.current.length);
          })
          .catch((err) => {
            devWarn('[FaceRec] computeStructuralId failed:', err);
            setStatusAndRef('failed');
            setLivenessResult(detector.getResult());
            isRunningRef.current = false;
          });
        return;
      }

      devWarn('[FaceRec] No frames captured');
      setStatusAndRef('failed');
      setLivenessResult(detector.getResult());
      isRunningRef.current = false;
      return;
    }

    // 挑戰切換暫停中（顯示 ✓ 過渡動畫）→ 跳過 processFrame
    if (challengePausedRef.current) return;

    // Blink baseline 預收 + 每幀 openness 注入 — face 偵測到的同時就餵 openness sample，
    // 等 baseline ready 才把用戶切到 'challenge' 顯示「請眨眼」prompt。
    // 避免「user 第一次眨眼掉進 baseline window 被 break 丟掉」。
    //
    // v20.13 改 openness (pixel-based) 取代 EAR (landmark-based)：戴眼鏡時 MediaPipe
    // 把 eye landmark 卡在鏡框邊，EAR 不可靠；改用眼部 region pixel 級分析（虹膜深色/luminance variance）。
    {
      const pendingChallenge = detector.getCurrentChallenge();
      if (pendingChallenge === 'blink') {
        const openness = computeEyeOpenness(video, detection.landmarks);
        detector.setLatestOpenness(openness.avg);
        if (!detector.isOpennessBaselineReady()) {
          detector.collectOpennessBaselineSample(openness.avg);
          // 不切到 'challenge' — baseline ready 後下一幀才走正常流程
          return;
        }
      }
    }

    setStatusAndRef('challenge');
    const prevChallenge = detector.getCurrentChallenge();
    const completed = detector.processFrame(geometry);
    const nextChallenge = detector.getCurrentChallenge();

    // 偵測挑戰切換（例如 blink → turn_head）或全部完成
    if (prevChallenge && prevChallenge !== nextChallenge) {
      const isAllDone = !nextChallenge; // nextChallenge === null → 全部完成
      console.error(`[FaceRec] Challenge completed: ${prevChallenge}${isAllDone ? ' (ALL DONE)' : ` → next: ${nextChallenge}`}`);
      // 暫停偵測，顯示 ✓ 過渡動畫
      // 最後一步（全部完成）停留久一點，讓 VPS 查詢有時間跑
      const pauseMs = isAllDone ? 2500 : 1200;
      challengePausedRef.current = true;
      setCompletedChallenge(prevChallenge);
      // 震動回饋（iOS Safari 不支援，靜默失敗）
      try { navigator.vibrate?.(200); } catch {}
      setTimeout(() => {
        challengePausedRef.current = false;
        setCompletedChallenge(null);
        if (nextChallenge) {
          setCurrentChallenge(nextChallenge);
          setChallengeProgress(detector.getProgress());
        }
      }, pauseMs);
      // 全部完成時繼續讓下方 completed 邏輯處理
      if (!isAllDone) return;
    }

    setCurrentChallenge(nextChallenge);
    setChallengeProgress(detector.getProgress());

    if (completed) {
      devLog('[FaceRec] All challenges completed, frame count:', capturedFramesRef.current.length);
    }

    // 檢查超時
    const result = detector.getResult();
    const timedOut = result.challenges.some(c => c.status === 'timeout');
    if (timedOut) {
      setStatusAndRef('failed');
      setLivenessResult(result);
      isRunningRef.current = false;
    }
  }, [maybeSpoofCapture, computeAntiSpoofResult, setStatusAndRef]);

  // =========================================================================
  // Verify Mode: Passive Liveness + 收集正面 frames
  // =========================================================================

  const handleVerifyFrame = useCallback((
    video: HTMLVideoElement,
    detection: FaceDetectionResult,
    geometry: ReturnType<typeof extractFaceGeometry>,
    now: number
  ) => {
    const detector = passiveDetectorRef.current;
    if (!detector) return;

    setStatusAndRef('face_detected');

    // === v20.10 登入嚴格守門（每幀都檢查，不依賴 baseline） ===
    // 規則：必須有完整 468+ landmarks + 任何遮擋（mask/sunglasses/hat/halfFace）都拒幀
    // 為什麼每幀檢查：MediaPipe 對被遮 landmark 用 3DMM 幻覺座標 → LSH 仍 match
    // → 必須在 capture frame 前用 HSV 像素層擋住，不能讓幻覺 frame 進入 LSH 比對
    if (!detection.landmarks || detection.landmarks.length < 468) {
      setGateOcclusion({ region: 'INCOMPLETE' });
      return;
    }
    const occ = getOcclusionResult();
    const occlusionRegion =
      occ.hasMask ? 'BOTTOM' :
      occ.hasSunglasses ? 'CENTER' :
      occ.hasHat ? 'TOP' :
      occ.hasHalfFaceLeft ? 'LEFT' :
      occ.hasHalfFaceRight ? 'RIGHT' :
      null;
    if (occlusionRegion) {
      setGateOcclusion({ region: occlusionRegion });
      return;
    }
    setGateOcclusion(null);  // v20.14 fix: 同 register flow，無條件清除（避免 stale-closure guard）

    // 邊偵測邊擷取防偽推論
    maybeSpoofCapture(video, geometry, now);

    // 收集正面 frames（verify 只需要正面 landmarks）
    const frame: CapturedFrame = {
      landmarks: detection.landmarks as unknown as Landmark3D[],
      matrix: detection.matrix ? { data: detection.matrix.data } : undefined,
      yaw: detection.yaw,
    };
    capturedFramesRef.current.push(frame);

    // 檢查被動活體是否已通過
    const passed = livenessPassedRef.current || detector.processFrame(geometry);

    if (passed) {
      livenessPassedRef.current = true;

      if (capturedFramesRef.current.length >= MIN_VERIFY_FRAMES) {
        // Compute and set anti-spoof result
        const antiSpoof = computeAntiSpoofResult();
        setAntiSpoofResult(antiSpoof);

        setLivenessResult(detector.getResult());
        setStatusAndRef('capturing');
        devLog('[FaceRec] Passive liveness passed, frames:', capturedFramesRef.current.length, ', antiSpoof score:', antiSpoof.score.toFixed(3));
        return;
      }

      // 繼續收集 frames
      devLog('[FaceRec] Liveness passed, collecting more frames...', capturedFramesRef.current.length, '/', MIN_VERIFY_FRAMES);
      return;
    }

    // 檢查超時（被動活體未通過 + 超時）
    if (detector.isTimedOut()) {
      setLivenessResult(detector.getResult());
      devLog('[FaceRec] Passive liveness timeout — using', capturedFramesRef.current.length, 'frames');
    }
  }, [maybeSpoofCapture, computeAntiSpoofResult, setStatusAndRef]);

  // =========================================================================
  // Save / Verify — 骨骼比率系統
  // =========================================================================

  const registerFace = useCallback(async (encryptionKey: CryptoKey): Promise<boolean> => {
    const boneData = boneRatioResultRef.current;
    if (!boneData) {
      devWarn('[FaceRec] No bone ratio data captured');
      return false;
    }

    try {
      await saveBoneRatioData(boneData, encryptionKey);
      setStatusAndRef('verified');
      setIsVerified(true);
      devLog('[FaceRec] Face registered (bone ratio), hash:', boneData.hash.slice(0, 16) + '...', 'bins:', Object.keys(boneData.frontalBins).length);
      return true;
    } catch (err) {
      devWarn('[FaceRec] Failed to save bone ratio data:', err);
      setStatusAndRef('failed');
      return false;
    }
  }, []);

  const verifyFace = useCallback(async (encryptionKey: CryptoKey): Promise<VerifyFaceResult> => {
    const failResult: VerifyFaceResult = { matched: false, similarity: 0, autoLoginReady: false };

    const frames = capturedFramesRef.current;
    if (frames.length < 2) {
      devWarn('[FaceRec] Not enough frames for verification:', frames.length);
      return failResult;
    }

    try {
      const storedData = await getBoneRatioData(encryptionKey);
      if (!storedData) {
        devWarn('[FaceRec] No stored bone ratio data found');
        setStatusAndRef('failed');
        return failResult;
      }

      // 從 CapturedFrame[] 提取 landmarks 陣列
      const loginLandmarks = frames.map(f => f.landmarks);

      // v18: LSH 比對 — 取代 exact bin equality，擋「別人/半臉也能登」
      if (!storedData.lshHash) {
        devWarn('[FaceRec] Stored data missing lshHash — user must re-register');
        setStatusAndRef('failed');
        return failResult;
      }

      const lshResult = await matchLoginLSH(loginLandmarks, storedData.lshHash);

      // similarity 對外仍用 0~1（漢明 0=完全相同 → similarity 1）
      const similarity01 = lshResult.similarity;
      setSimilarity(similarity01);

      const isMatch = lshResult.passed;
      const autoLoginReady = similarity01 >= autoLoginThreshold;
      setStatusAndRef(isMatch ? 'verified' : 'failed');
      setIsVerified(isMatch);

      // Compute and set anti-spoof result for verify mode
      const antiSpoof = computeAntiSpoofResult();
      setAntiSpoofResult(antiSpoof);

      devLog(`[FaceRec] Verification (LSH): hamming=${lshResult.hammingDistance}/128, similarity=${similarity01.toFixed(3)}, pass=${isMatch}${lshResult.uncertain ? ' (uncertain)' : ''}, autoLogin=${autoLoginReady}, antiSpoof=${antiSpoof.score.toFixed(3)}`);
      return { matched: isMatch, similarity: similarity01, autoLoginReady };
    } catch (err) {
      devWarn('[FaceRec] Verification failed:', err);
      setStatusAndRef('failed');
      return failResult;
    }
  }, [matchThreshold, autoLoginThreshold, computeAntiSpoofResult]);

  // =========================================================================
  // Reset
  // =========================================================================

  const reset = useCallback(() => {
    stopCamera();
    setStatusAndRef('idle');
    setCurrentChallenge(null);
    setChallengeProgress({ current: 0, total: 2 });
    setLivenessResult(null);
    setSimilarity(null);
    setIsVerified(false);
    setAntiSpoofResult(null);
    capturedFramesRef.current = [];
    zoneCountsRef.current = [0, 0, 0, 0, 0];
    pitchZoneCountsRef.current = [0, 0, 0, 0, 0];
    lastCaptureVideoTimeRef.current = 0;
    lastCaptureMsRef.current = 0;
    boneRatioResultRef.current = null;
    activeDetectorRef.current = null;
    passiveDetectorRef.current = null;
    // Reset anti-spoof state
    spoofVotesRef.current = [];
    cnnRunningRef.current = false;
    livenessPassedRef.current = false;
    occlusionConfirmedRef.current = false;
    lastCnnTimestampRef.current = 0;
    // Reset diagnostic counters
    faceDetectedCountRef.current = 0;
    noFaceCountRef.current = 0;
    lastDiagnosticLogRef.current = 0;
    firstFaceLoggedRef.current = false;
  }, [stopCamera]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isRunningRef.current = false;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      closeCnnModels().catch(() => {});
    };
  }, []);

  // =========================================================================
  // v20 Occlusion Gate API
  // =========================================================================

  /**
   * 採 ~2 秒乾淨臉 → 建 baseline（每個 landmark 的 lap + RGB 平均）→ 存 localStorage
   * App 在第一次註冊前應呼叫此 API（鏡頭已經 Start 後）
   * 之後 register/verify 會自動讀 baseline 跑閘門
   */
  const calibrateGate = useCallback(async (durationMs = 2000): Promise<boolean> => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) {
      devWarn('[FaceRec/Gate] calibrateGate: camera not ready');
      return false;
    }
    const baseline = await gateCalibrateBaseline(
      video,
      (v, ts) => {
        const r = detectFace(v, ts);
        if (!r) return null;
        return { faceLandmarks: [r.landmarks] };
      },
      durationMs,
    );
    if (!baseline) {
      devWarn('[FaceRec/Gate] calibrateGate: not enough samples');
      return false;
    }
    await gateSaveBaseline(baseline);
    gateBaselineRef.current = baseline;
    setGateBaselineReady(true);
    devLog('[FaceRec/Gate] Calibrated, baseline n=', baseline.n);
    return true;
  }, []);

  return {
    status,
    currentChallenge,
    nextTurnDirection,
    challengeProgress,
    livenessResult,
    similarity,
    isVerified,
    cnnReady,
    antiSpoofResult,
    // v20.10: 直接回 HSV 結果（不再依賴 occlusionConfirmedRef，因為不再用 baseline gate）
    occlusion: getOcclusionResult(),
    scanZones,
    scanHits,
    scanZoneTargets,
    scanPhase,
    completedChallenge,
    currentYaw,
    videoRef,
    // v20 Gate
    gateBaselineReady,
    gateOcclusion,
    calibrateGate,
    startCamera,
    stopCamera,
    registerFace,
    verifyFace,
    reset,
  };
}
