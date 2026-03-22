/**
 * Face Recognition Hook
 *
 * 管理相機串流、臉部偵測迴圈、活體狀態機
 *
 * 兩種模式：
 * - register: 主動活體偵測（眨眼+轉頭），收集 landmark embedding + anti-spoof
 * - verify: 被動活體偵測（自然眨眼+微動），收集 landmark embedding
 *
 * 注意：MobileFaceNet CNN embedding 已移除，臉部辨識改用骨骼比率系統（structuralId.ts）。
 * 此 hook 使用 landmark embedding 作為 fallback，anti-spoof 仍使用 MiniFASNet。
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
  cosineSimilarity,
  computeStableEmbedding,
  computeEmbeddingConsistency,
} from './embedding';
import {
  initCnnModels,
  isCnnReady,
  detectSpoof,
  closeCnnModels,
  resetBboxSmoothing,
} from './cnnInference';
import {
  saveFaceEmbedding,
  getFaceEmbedding,
} from './storage';
import type {
  FaceDetectionStatus,
  FaceEmbedding,
  FaceLandmark,
  LivenessChallenge,
  LivenessResult,
  AntiSpoofResult,
  SpoofDetectionResult,
} from './types';

// ============================================================================
// Constants
// ============================================================================

/** 預設比對閾值 */
const DEFAULT_MATCH_THRESHOLD = 0.6;

/** 預設自動登入閾值 */
const DEFAULT_AUTO_LOGIN_THRESHOLD = 0.75;

/** Landmark fallback 時的擷取幀數 */
const CAPTURE_FRAMES = 5;

/** 偵測迴圈間隔 (ms) */
const DETECTION_INTERVAL = 100;

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
  /** 比對閾值（verify 模式），default 0.6 */
  matchThreshold?: number;
  /** 自動登入閾值（verify 模式），default 0.75 */
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
  /** 活體挑戰進度 */
  challengeProgress: { current: number; total: number };
  /** 活體偵測結果 */
  livenessResult: LivenessResult | null;
  /** cosine similarity（verify 模式） */
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
  matchThreshold = DEFAULT_MATCH_THRESHOLD,
  autoLoginThreshold = DEFAULT_AUTO_LOGIN_THRESHOLD,
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
  const capturedFramesRef = useRef<FaceLandmark[][]>([]);
  const capturedEmbeddingRef = useRef<FaceEmbedding | null>(null);
  const isRunningRef = useRef(false);
  const lastTimestampRef = useRef(0);
  const statusRef = useRef<FaceDetectionStatus>('idle');

  // Anti-spoof 相關 refs
  const lastCnnTimestampRef = useRef(0);
  const spoofVotesRef = useRef<SpoofDetectionResult[]>([]);
  const cnnRunningRef = useRef(false); // 防止同時跑兩次推論

  // Verify mode: 被動活體已通過但 CNN 尚未就緒，持續等待
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

      // 先啟動相機 + MediaPipe（必須），CNN 在背景載入（不阻塞相機啟動）
      const [cameraResult, mediapipeResult] = await Promise.allSettled([
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
        }),
        initFaceLandmarker(),
      ]);

      // 相機是必須的
      if (cameraResult.status === 'rejected') {
        const err = cameraResult.reason as { name?: string; message?: string } | undefined;
        console.error('[FaceRec] Camera getUserMedia REJECTED:', err?.name, err?.message);
        throw cameraResult.reason;
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
  }, [mode]);

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

      // 偵測人臉
      const landmarks = detectFace(video, now);

      // Diagnostic logging every 3 seconds
      if (now - lastDiagnosticLogRef.current >= DIAGNOSTIC_LOG_INTERVAL) {
        lastDiagnosticLogRef.current = now;
        console.error(`[FaceRec] Detection: noFace=${noFaceCountRef.current}, face=${faceDetectedCountRef.current}, antiSpoof=${isCnnReady()}`);
      }

      if (!landmarks) {
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
        devLog(`[FaceRec] First face detected (mode=${mode})`);
      }

      const geometry = extractFaceGeometry(landmarks);

      if (mode === 'register') {
        handleRegisterFrame(video, landmarks, geometry, now);
      } else {
        handleVerifyFrame(video, landmarks, geometry, now);
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);
  }, [mode, setStatusAndRef]);

  // =========================================================================
  // CNN Capture (Phase 26b) — 邊挑戰邊擷取
  // =========================================================================

  /**
   * 每 500ms 執行一次防偽推論
   * 在挑戰期間持續執行，收集防偽投票結果
   *
   * 注意：MobileFaceNet CNN embedding 已移除，臉部辨識改用骨骼比率系統。
   * 此函式現在只負責 anti-spoof 偵測。
   */
  const maybeSpoofCapture = useCallback(async (
    video: HTMLVideoElement,
    geometry: ReturnType<typeof extractFaceGeometry>,
    now: number,
    _detector: ActiveLivenessDetector | null
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
  const computeAntiSpoofResult = useCallback((
    detector: ActiveLivenessDetector | null
  ): AntiSpoofResult => {
    const votes = spoofVotesRef.current;
    const realCount = votes.filter(v => v.isReal).length;
    const spoofCount = votes.length - realCount;
    const avgConfidence = votes.length > 0
      ? votes.reduce((s, v) => s + v.confidence, 0) / votes.length
      : 0;

    // Embedding 一致性分析
    const snapshots = detector?.getSnapshots() ?? [];
    const embeddingConsistency = computeEmbeddingConsistency(snapshots);

    // 綜合防偽分數
    const cnnWeight = 0.7;
    const consistencyWeight = 0.3;
    const consistencyScore = Math.min(
      embeddingConsistency.blinkDelta * 10 +
      embeddingConsistency.turnEyeRatio * 5 +
      embeddingConsistency.overallVariance * 10,
      1
    );
    const score = avgConfidence * cnnWeight + consistencyScore * consistencyWeight;

    return {
      cnnScore: avgConfidence,
      cnnVotes: { real: realCount, spoof: spoofCount },
      embeddingConsistency,
      score,
      isSuspicious: score < 0.4 || (votes.length >= 3 && spoofCount > realCount),
    };
  }, []);

  // =========================================================================
  // Register Mode: Active Liveness + 邊挑戰邊擷取
  // =========================================================================

  const handleRegisterFrame = useCallback((
    video: HTMLVideoElement,
    landmarks: FaceLandmark[],
    geometry: ReturnType<typeof extractFaceGeometry>,
    now: number
  ) => {
    const detector = activeDetectorRef.current;
    if (!detector) return;

    // 邊挑戰邊擷取防偽推論（async，不阻塞偵測迴圈）
    maybeSpoofCapture(video, geometry, now, detector);

    // 收集 landmark frames 用於 embedding
    capturedFramesRef.current.push(landmarks);

    const challenge = detector.getCurrentChallenge();

    if (!challenge) {
      // 所有挑戰完成 — 計算最終 landmark embedding
      if (statusRef.current !== 'capturing') {
        setStatusAndRef('capturing');
      }

      if (capturedFramesRef.current.length > 0) {
        capturedEmbeddingRef.current = computeStableEmbedding(capturedFramesRef.current);
        const antiSpoof = computeAntiSpoofResult(detector);
        const result = { ...detector.getResult(), antiSpoof };
        setLivenessResult(result);
        setAntiSpoofResult(antiSpoof);
        isRunningRef.current = false;
        devLog('[FaceRec] Register challenges complete, frames:', capturedFramesRef.current.length);
        devLog('[FaceRec] Anti-spoof result computed, score:', antiSpoof.score.toFixed(3));
        return;
      }

      devWarn('[FaceRec] No landmark frames captured');
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
  // Verify Mode: Passive Liveness + 邊偵測邊擷取
  // =========================================================================

  const handleVerifyFrame = useCallback((
    video: HTMLVideoElement,
    landmarks: FaceLandmark[],
    geometry: ReturnType<typeof extractFaceGeometry>,
    now: number
  ) => {
    const detector = passiveDetectorRef.current;
    if (!detector) return;

    setStatusAndRef('face_detected');

    // 邊偵測邊擷取防偽推論
    maybeSpoofCapture(video, geometry, now, null);

    // 收集 landmark frames 用於 embedding
    capturedFramesRef.current.push(landmarks);

    // 檢查被動活體是否已通過
    const passed = livenessPassedRef.current || detector.processFrame(geometry);

    if (passed) {
      livenessPassedRef.current = true;

      // 使用 landmark embedding
      if (capturedFramesRef.current.length >= CAPTURE_FRAMES) {
        capturedEmbeddingRef.current = computeStableEmbedding(capturedFramesRef.current);

        // Compute and set anti-spoof result
        const antiSpoof = computeAntiSpoofResult(null);
        setAntiSpoofResult(antiSpoof);

        setLivenessResult(detector.getResult());
        setStatusAndRef('capturing');
        devLog('[FaceRec] Passive liveness passed, frames:', capturedFramesRef.current.length, ', antiSpoof score:', antiSpoof.score.toFixed(3));
        return;
      }

      // 繼續收集 frames
      devLog('[FaceRec] Liveness passed, collecting more frames...', capturedFramesRef.current.length, '/', CAPTURE_FRAMES);
      return;
    }

    // 檢查超時（被動活體未通過 + 超時）
    if (detector.isTimedOut()) {
      if (capturedFramesRef.current.length > 0) {
        capturedEmbeddingRef.current = computeStableEmbedding(capturedFramesRef.current);
      }
      setLivenessResult(detector.getResult());
      devLog('[FaceRec] Passive liveness timeout — using', capturedFramesRef.current.length, 'frames');
    }
  }, [maybeSpoofCapture, computeAntiSpoofResult, setStatusAndRef]);

  // =========================================================================
  // Save / Verify Embedding
  // =========================================================================

  const registerFace = useCallback(async (encryptionKey: CryptoKey): Promise<boolean> => {
    const embedding = capturedEmbeddingRef.current;
    if (!embedding) {
      devWarn('[FaceRec] No embedding captured');
      return false;
    }

    try {
      await saveFaceEmbedding(embedding, encryptionKey);
      setStatusAndRef('verified');
      setIsVerified(true);
      devLog('[FaceRec] Face registered successfully, dim:', embedding.length);
      return true;
    } catch (err) {
      devWarn('[FaceRec] Failed to save face embedding:', err);
      setStatusAndRef('failed');
      return false;
    }
  }, []);

  const verifyFace = useCallback(async (encryptionKey: CryptoKey): Promise<VerifyFaceResult> => {
    const failResult: VerifyFaceResult = { matched: false, similarity: 0, autoLoginReady: false };

    const capturedEmb = capturedEmbeddingRef.current;
    if (!capturedEmb) {
      devWarn('[FaceRec] No embedding captured for verification');
      return failResult;
    }

    try {
      const storedEmb = await getFaceEmbedding(encryptionKey);
      if (!storedEmb) {
        devWarn('[FaceRec] No stored embedding found');
        setStatusAndRef('failed');
        return failResult;
      }

      // 維度不同 = 不同來源（CNN vs landmark），無法比對
      if (capturedEmb.length !== storedEmb.length) {
        devWarn('[FaceRec] Embedding dimension mismatch:', capturedEmb.length, 'vs', storedEmb.length);
        setStatusAndRef('failed');
        return failResult;
      }

      const sim = cosineSimilarity(capturedEmb, storedEmb);
      setSimilarity(sim);

      const isMatch = sim >= matchThreshold;
      const autoLoginReady = sim >= autoLoginThreshold;
      setStatusAndRef(isMatch ? 'verified' : 'failed');
      setIsVerified(isMatch);

      // Compute and set anti-spoof result for verify mode
      const antiSpoof = computeAntiSpoofResult(null);
      setAntiSpoofResult(antiSpoof);

      devLog(`[FaceRec] Verification: similarity=${sim.toFixed(3)}, match=${isMatch}, autoLoginReady=${autoLoginReady}, dim=${capturedEmb.length}, antiSpoof=${antiSpoof.score.toFixed(3)}`);
      return { matched: isMatch, similarity: sim, autoLoginReady };
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
    capturedEmbeddingRef.current = null;
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
