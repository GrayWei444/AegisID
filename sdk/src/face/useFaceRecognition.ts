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
  matchLoginBins,
} from './structuralId';
import type { CapturedFrame, Landmark3D } from './structuralId';
import {
  initCnnModels,
  isCnnReady,
  detectSpoof,
  closeCnnModels,
  resetBboxSmoothing,
} from './cnnInference';
import {
  saveBoneRatioData,
  getBoneRatioData,
} from './storage';
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
const DETECTION_INTERVAL = 100;

/**
 * v17 Yaw zone 定義 — 5 區各有最低幀數要求
 * 高幀率擷取（不限間隔），每幀都存
 */
const YAW_ZONES = [
  { min: 0.20, max: 0.50, target: 8 },   // far-left
  { min: 0.08, max: 0.20, target: 8 },   // left
  { min: -0.08, max: 0.08, target: 15 }, // center
  { min: -0.20, max: -0.08, target: 8 }, // right
  { min: -0.50, max: -0.20, target: 8 }, // far-right
] as const;

function getYawZone(yaw: number): number {
  for (let i = 0; i < YAW_ZONES.length; i++) {
    if (yaw >= YAW_ZONES[i].min && yaw < YAW_ZONES[i].max) return i;
  }
  if (yaw >= 0.50) return 0;
  if (yaw < -0.50) return 4;
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
  /**
   * 影片測試模式：提供 mp4 URL 時，用影片檔代替攝影機。
   * Anti-spoof 自動跳過（螢幕回放會誤判）。
   */
  videoUrl?: string;
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
  /** video element ref */
  videoRef: React.RefObject<HTMLVideoElement | null>;
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
  videoUrl,
}: UseFaceRecognitionOptions): UseFaceRecognitionReturn {
  const [status, setStatus] = useState<FaceDetectionStatus>('idle');
  const [currentChallenge, setCurrentChallenge] = useState<LivenessChallenge | null>(null);
  const [challengeProgress, setChallengeProgress] = useState({ current: 0, total: 2 });
  const [livenessResult, setLivenessResult] = useState<LivenessResult | null>(null);
  const [similarity, setSimilarity] = useState<number | null>(null);
  const [isVerified, setIsVerified] = useState(false);
  const [cnnReady, setCnnReady] = useState(false);
  const [antiSpoofResult, setAntiSpoofResult] = useState<AntiSpoofResult | null>(null);

  // Keep statusRef in sync with state
  const setStatusAndRef = useCallback((s: FaceDetectionStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  const activeDetectorRef = useRef<ActiveLivenessDetector | null>(null);
  const passiveDetectorRef = useRef<PassiveLivenessDetector | null>(null);
  const isRunningRef = useRef(false);
  const isVideoModeRef = useRef(!!videoUrl);
  const lastTimestampRef = useRef(0);
  const statusRef = useRef<FaceDetectionStatus>('idle');

  // 骨骼比率系統：收集 CapturedFrame[]
  const capturedFramesRef = useRef<CapturedFrame[]>([]);
  // 註冊完成後暫存的骨骼比率結果
  const boneRatioResultRef = useRef<BoneRatioPlainData | null>(null);
  // Yaw zone 計數（註冊模式，確保左/中/右均勻分佈）
  const zoneCountsRef = useRef<number[]>([0, 0, 0, 0, 0]);

  // Anti-spoof 相關 refs
  const lastCnnTimestampRef = useRef(0);
  const spoofVotesRef = useRef<SpoofDetectionResult[]>([]);
  const cnnRunningRef = useRef(false);

  // Verify mode: 被動活體已通過但尚未完成
  const livenessPassedRef = useRef(false);

  // Diagnostic counters
  const faceDetectedCountRef = useRef(0);
  const noFaceCountRef = useRef(0);
  const lastDiagnosticLogRef = useRef(0);
  const firstFaceLoggedRef = useRef(false);

  // =========================================================================
  // Camera Management
  // =========================================================================

  const startCamera = useCallback(async () => {
    try {
      setStatusAndRef('loading');

      // Reset bbox smoothing for new session
      resetBboxSmoothing();
      isVideoModeRef.current = !!videoUrl;

      if (videoUrl) {
        // === 影片測試模式 ===
        devLog('[FaceRec] VIDEO TEST MODE — loading:', videoUrl);

        // MediaPipe 仍然必須
        await initFaceLandmarker();

        if (videoRef.current) {
          videoRef.current.srcObject = null;
          videoRef.current.src = videoUrl;
          videoRef.current.muted = true;
          videoRef.current.playsInline = true;
          videoRef.current.loop = false;
          await videoRef.current.play();
          devLog('[FaceRec] Video playing, duration:', videoRef.current.duration?.toFixed(1) + 's');
        }

        // 影片模式跳過 anti-spoof（螢幕回放會誤判）
        setCnnReady(true);
        devLog('[FaceRec] Anti-spoof SKIPPED in video test mode');

      } else {
        // === 正常相機模式 ===
        const [cameraResult, mediapipeResult] = await Promise.allSettled([
          navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
          }),
          initFaceLandmarker(),
        ]);

        if (cameraResult.status === 'rejected') {
          const err = cameraResult.reason as { name?: string; message?: string } | undefined;
          console.error('[FaceRec] Camera getUserMedia REJECTED:', err?.name, err?.message);
          throw cameraResult.reason;
        }
        if (mediapipeResult.status === 'rejected') {
          throw mediapipeResult.reason;
        }

        // Anti-spoof 模型在背景載入
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
        }
      }

      // 初始化活體偵測器
      if (mode === 'register') {
        activeDetectorRef.current = new ActiveLivenessDetector();
        setCurrentChallenge(activeDetectorRef.current.getCurrentChallenge());
        setChallengeProgress(activeDetectorRef.current.getProgress());
      } else {
        passiveDetectorRef.current = new PassiveLivenessDetector();
      }

      setStatusAndRef('ready');
      isRunningRef.current = true;
      startDetectionLoop();

      devLog('[FaceRec] Camera started, mode:', mode);
    } catch (err) {
      devWarn('[FaceRec] Camera/model init failed:', err);
      setStatusAndRef('error');
    }
  }, [mode, videoUrl]);

  const stopCamera = useCallback(() => {
    isRunningRef.current = false;

    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
      if (isVideoModeRef.current) {
        videoRef.current.src = '';
        videoRef.current.load();
      }
    }

    devLog('[FaceRec] Camera stopped');
  }, []);

  // =========================================================================
  // Detection Loop
  // =========================================================================

  const startDetectionLoop = useCallback(() => {
    const loop = () => {
      if (!isRunningRef.current) return;

      const video = videoRef.current;
      if (!video || video.readyState < 2) {
        animFrameRef.current = requestAnimationFrame(loop);
        return;
      }

      const now = performance.now();
      if (now - lastTimestampRef.current < DETECTION_INTERVAL) {
        animFrameRef.current = requestAnimationFrame(loop);
        return;
      }
      lastTimestampRef.current = now;

      // 偵測人臉（返回 landmarks + matrix + yaw）
      const detection = detectFace(video, now);

      // Diagnostic logging every 3 seconds
      if (now - lastDiagnosticLogRef.current >= DIAGNOSTIC_LOG_INTERVAL) {
        lastDiagnosticLogRef.current = now;
        console.error(`[FaceRec] Detection: noFace=${noFaceCountRef.current}, face=${faceDetectedCountRef.current}, frames=${capturedFramesRef.current.length}, antiSpoof=${isCnnReady()}`);
      }

      if (!detection) {
        noFaceCountRef.current++;
        if (statusRef.current !== 'ready' && statusRef.current !== 'loading') {
          setStatusAndRef('ready');
        }
        animFrameRef.current = requestAnimationFrame(loop);
        return;
      }

      // 偵測到人臉
      faceDetectedCountRef.current++;

      // Log first face detection
      if (!firstFaceLoggedRef.current) {
        firstFaceLoggedRef.current = true;
        devLog(`[FaceRec] First face detected (mode=${mode}, hasMatrix=${!!detection.matrix})`);
      }

      const geometry = extractFaceGeometry(detection.landmarks);

      if (mode === 'register') {
        handleRegisterFrame(video, detection, geometry, now);
      } else {
        handleVerifyFrame(video, detection, geometry, now);
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);
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
    // 影片測試模式跳過 anti-spoof
    if (isVideoModeRef.current) return;

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

    // 邊挑戰邊擷取防偽推論（async，不阻塞偵測迴圈）
    maybeSpoofCapture(video, geometry, now);

    const challenge = detector.getCurrentChallenge();

    // 只在轉頭掃描階段收集 3D 幀（眨眼不收集，挑戰完成後也不再收集）
    if (challenge === 'turn_head' || challenge === 'turn_right' || challenge === 'turn_left') {
      const yaw = detection.yaw ?? 0;
      const zone = getYawZone(yaw);

      // v17: 高幀率擷取 — 每幀都存，不限間隔
      const frame: CapturedFrame = {
        landmarks: detection.landmarks as unknown as Landmark3D[],
        matrix: detection.matrix ? { data: detection.matrix.data } : undefined,
        yaw,
      };
      capturedFramesRef.current.push(frame);
      zoneCountsRef.current[zone]++;
    }

    if (!challenge) {
      // 所有挑戰完成 — 計算骨骼比率 structural ID
      if (statusRef.current !== 'capturing') {
        setStatusAndRef('capturing');
      }

      if (capturedFramesRef.current.length > 0) {
        // 非同步計算 structural ID（SHA-256 需要 await）
        computeStructuralId(capturedFramesRef.current)
          .then((result) => {
            boneRatioResultRef.current = {
              frontalBins: Object.fromEntries(result.frontalBins),
              hash: result.hashes.hashCombined,
              hash2D: result.hashes.hash2D,
              hash3D: result.hashes.hash3D,
              hashCombined: result.hashes.hashCombined,
            };

            const antiSpoof = computeAntiSpoofResult();
            const livenessRes = { ...detector.getResult(), antiSpoof };
            setLivenessResult(livenessRes);
            setAntiSpoofResult(antiSpoof);
            isRunningRef.current = false;

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

    setStatusAndRef('challenge');
    const completed = detector.processFrame(geometry);

    setCurrentChallenge(detector.getCurrentChallenge());
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
      devLog('[FaceRec] Face registered — 2D:', (boneData.hash2D ?? '').slice(0, 12) + '... 3D:', (boneData.hash3D ?? '').slice(0, 12) + '... bins:', Object.keys(boneData.frontalBins).length);
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

      // 用 matchLoginBins 比對
      const storedBins = new Map(Object.entries(storedData.frontalBins).map(
        ([k, v]) => [k, v as number]
      ));
      const matchResult = matchLoginBins(loginLandmarks, storedBins);

      const matchRate = matchResult.matchRate;
      setSimilarity(matchRate);

      const isMatch = matchResult.passed;
      const autoLoginReady = matchRate >= autoLoginThreshold;
      setStatusAndRef(isMatch ? 'verified' : 'failed');
      setIsVerified(isMatch);

      // Compute and set anti-spoof result for verify mode
      const antiSpoof = computeAntiSpoofResult();
      setAntiSpoofResult(antiSpoof);

      devLog(`[FaceRec] Verification (bone ratio): matchRate=${matchRate.toFixed(3)} (${matchResult.matchCount}/${matchResult.totalCompared}), pass=${isMatch}, autoLogin=${autoLoginReady}, antiSpoof=${antiSpoof.score.toFixed(3)}`);
      return { matched: isMatch, similarity: matchRate, autoLoginReady };
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
    boneRatioResultRef.current = null;
    activeDetectorRef.current = null;
    passiveDetectorRef.current = null;
    // Reset anti-spoof state
    spoofVotesRef.current = [];
    cnnRunningRef.current = false;
    livenessPassedRef.current = false;
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

  return {
    status,
    currentChallenge,
    challengeProgress,
    livenessResult,
    similarity,
    isVerified,
    cnnReady,
    antiSpoofResult,
    videoRef,
    startCamera,
    stopCamera,
    registerFace,
    verifyFace,
    reset,
  };
}
