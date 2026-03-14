/**
 * Phase 26: Face Recognition Hook
 * Phase 26b: CNN 邊挑戰邊擷取 + 防偽
 *
 * 管理相機串流、臉部偵測迴圈、活體狀態機
 *
 * 兩種模式：
 * - register: 主動活體偵測（眨眼+轉頭），邊挑戰邊擷取 CNN embedding + 防偽
 * - verify: 被動活體偵測（自然眨眼+微動），邊偵測邊擷取 CNN embedding
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { devLog, devWarn } from '../utils/devLog';
import {
  initFaceLandmarker,
  detectFace,
  extractFaceGeometry,
} from '../services/faceRecognition/faceMesh';
import {
  ActiveLivenessDetector,
  PassiveLivenessDetector,
} from '../services/faceRecognition/liveness';
import {
  cosineSimilarity,
  computeStableEmbedding,
  computeStableCnnEmbedding,
  computeEmbeddingConsistency,
} from '../services/faceRecognition/embedding';
import {
  initCnnModels,
  isCnnReady,
  extractCnnEmbedding,
  detectSpoof,
  closeCnnModels,
} from '../services/faceRecognition/cnnInference';
import {
  saveFaceEmbedding,
  getFaceEmbedding,
} from '../services/faceRecognition/storage';
import type {
  FaceDetectionStatus,
  FaceEmbedding,
  FaceLandmark,
  LivenessChallenge,
  LivenessResult,
  AntiSpoofResult,
  SpoofDetectionResult,
} from '../services/faceRecognition/types';

// ============================================================================
// Constants
// ============================================================================

/** 比對閾值 */
const SIMILARITY_THRESHOLD = 0.6;

/** Landmark fallback 時的擷取幀數 */
const CAPTURE_FRAMES = 5;

/** 偵測迴圈間隔 (ms) */
const DETECTION_INTERVAL = 100;

/** CNN 推論間隔 (ms) — 每 500ms 跑一次 CNN */
const CNN_INTERVAL = 500;

// ============================================================================
// Hook
// ============================================================================

interface UseFaceRecognitionOptions {
  /** 註冊 or 驗證 */
  mode: 'register' | 'verify';
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
  verifyFace: (encryptionKey: CryptoKey) => Promise<boolean>;
  /** 重置狀態 */
  reset: () => void;
}

export function useFaceRecognition({ mode }: UseFaceRecognitionOptions): UseFaceRecognitionReturn {
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

  // Phase 26b: CNN 相關 refs
  const lastCnnTimestampRef = useRef(0);
  const cnnEmbeddingsRef = useRef<Float32Array[]>([]);
  const spoofVotesRef = useRef<SpoofDetectionResult[]>([]);
  const cnnRunningRef = useRef(false); // 防止同時跑兩次 CNN

  // =========================================================================
  // Camera Management
  // =========================================================================

  const startCamera = useCallback(async () => {
    try {
      setStatusAndRef('loading');

      // 並行初始化：相機 + MediaPipe + CNN 模型
      const initResults = await Promise.allSettled([
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
        }),
        initFaceLandmarker(),
        initCnnModels(),
      ]);

      // 相機是必須的
      if (initResults[0].status === 'rejected') {
        throw initResults[0].reason;
      }
      // MediaPipe 是必須的
      if (initResults[1].status === 'rejected') {
        throw initResults[1].reason;
      }
      // CNN 是可選的（fallback 到 landmark embedding）
      if (initResults[2].status === 'fulfilled') {
        setCnnReady(true);
        devLog('[FaceRec] CNN models ready');
      } else {
        devWarn('[FaceRec] CNN models failed to load, using landmark fallback:', initResults[2].reason);
      }

      const stream = initResults[0].value as MediaStream;
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

      if (!landmarks) {
        if (statusRef.current !== 'ready' && statusRef.current !== 'loading') {
          setStatusAndRef('ready');
        }
        animFrameRef.current = requestAnimationFrame(loop);
        return;
      }

      // 偵測到人臉
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
   * 每 500ms 擷取一次 CNN embedding + 防偽推論
   * 在挑戰期間持續執行，挑戰完成時 embedding 已收集完畢
   */
  const maybeCnnCapture = useCallback(async (
    video: HTMLVideoElement,
    geometry: ReturnType<typeof extractFaceGeometry>,
    now: number,
    detector: ActiveLivenessDetector | null
  ): Promise<void> => {
    // CNN 未就緒 or 還在跑上一次 → 跳過
    if (!isCnnReady() || cnnRunningRef.current) return;

    // 500ms 間隔
    if (now - lastCnnTimestampRef.current < CNN_INTERVAL) return;
    lastCnnTimestampRef.current = now;

    cnnRunningRef.current = true;
    try {
      const faceBox = geometry.boundingBox;

      // 並行跑 embedding + 防偽
      const [cnnEmb, spoofResult] = await Promise.all([
        extractCnnEmbedding(video, faceBox),
        detectSpoof(video, faceBox),
      ]);

      // 累積結果
      cnnEmbeddingsRef.current.push(cnnEmb);
      spoofVotesRef.current.push(spoofResult);

      // 如果有 ActiveLivenessDetector，記錄快照
      if (detector) {
        const challenge = detector.getCurrentChallenge();
        if (challenge) {
          detector.addSnapshot({
            challenge,
            phase: detector.getCurrentPhase(),
            embedding: cnnEmb,
            geometry,
            timestamp: now,
          });
        }
      }

      devLog(`[FaceRec/CNN] Embedding #${cnnEmbeddingsRef.current.length}, spoof: ${spoofResult.confidence.toFixed(3)} (${spoofResult.isReal ? 'real' : 'spoof'})`);
    } catch (err) {
      devWarn('[FaceRec/CNN] Inference error:', err);
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

    // Phase 26b: 邊挑戰邊擷取 CNN embedding + 防偽（async，不阻塞偵測迴圈）
    maybeCnnCapture(video, geometry, now, detector);

    const challenge = detector.getCurrentChallenge();

    if (!challenge) {
      // 所有挑戰完成 — 計算最終 embedding
      if (statusRef.current !== 'capturing') {
        setStatusAndRef('capturing');
      }

      // 使用 CNN embedding（已在挑戰期間收集）
      if (cnnEmbeddingsRef.current.length > 0) {
        capturedEmbeddingRef.current = computeStableCnnEmbedding(cnnEmbeddingsRef.current);
        const antiSpoof = computeAntiSpoofResult(detector);
        const result = { ...detector.getResult(), antiSpoof };
        setLivenessResult(result);
        setAntiSpoofResult(antiSpoof);
        isRunningRef.current = false;
        devLog('[FaceRec] CNN embedding captured from', cnnEmbeddingsRef.current.length, 'frames');
        return;
      }

      // Fallback: landmark embedding（CNN 不可用）
      capturedFramesRef.current.push(landmarks);
      if (capturedFramesRef.current.length >= CAPTURE_FRAMES) {
        capturedEmbeddingRef.current = computeStableEmbedding(capturedFramesRef.current);
        setLivenessResult(detector.getResult());
        isRunningRef.current = false;
        devLog('[FaceRec] Landmark fallback embedding captured');
      }
      return;
    }

    setStatusAndRef('challenge');
    const completed = detector.processFrame(geometry);

    setCurrentChallenge(detector.getCurrentChallenge());
    setChallengeProgress(detector.getProgress());

    if (completed) {
      devLog('[FaceRec] All challenges completed');
    }

    // 檢查超時
    const result = detector.getResult();
    const timedOut = result.challenges.some(c => c.status === 'timeout');
    if (timedOut) {
      setStatusAndRef('failed');
      setLivenessResult(result);
      isRunningRef.current = false;
    }
  }, [maybeCnnCapture, computeAntiSpoofResult, setStatusAndRef]);

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

    // Phase 26b: 邊偵測邊擷取 CNN embedding
    maybeCnnCapture(video, geometry, now, null);

    const passed = detector.processFrame(geometry);

    if (passed) {
      // 使用 CNN embedding（已在被動偵測期間收集）
      if (cnnEmbeddingsRef.current.length > 0) {
        capturedEmbeddingRef.current = computeStableCnnEmbedding(cnnEmbeddingsRef.current);
        setLivenessResult(detector.getResult());
        setStatusAndRef('capturing');
        devLog('[FaceRec] Passive liveness passed, CNN embedding captured');
        return;
      }

      // Fallback: landmark embedding
      if (capturedFramesRef.current.length < CAPTURE_FRAMES) {
        capturedFramesRef.current.push(landmarks);
        setStatusAndRef('capturing');
      }

      if (capturedFramesRef.current.length >= CAPTURE_FRAMES) {
        capturedEmbeddingRef.current = computeStableEmbedding(capturedFramesRef.current);
        setLivenessResult(detector.getResult());
        devLog('[FaceRec] Passive liveness passed, landmark fallback embedding captured');
      }
      return;
    }

    // 檢查超時
    if (detector.isTimedOut()) {
      setLivenessResult(detector.getResult());
      devLog('[FaceRec] Passive liveness timeout — degrading to PIN-only');
    }
  }, [maybeCnnCapture]);

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

  const verifyFace = useCallback(async (encryptionKey: CryptoKey): Promise<boolean> => {
    const capturedEmb = capturedEmbeddingRef.current;
    if (!capturedEmb) {
      devWarn('[FaceRec] No embedding captured for verification');
      return false;
    }

    try {
      const storedEmb = await getFaceEmbedding(encryptionKey);
      if (!storedEmb) {
        devWarn('[FaceRec] No stored embedding found');
        setStatusAndRef('failed');
        return false;
      }

      // 維度不同 = 不同來源（CNN vs landmark），無法比對
      if (capturedEmb.length !== storedEmb.length) {
        devWarn('[FaceRec] Embedding dimension mismatch:', capturedEmb.length, 'vs', storedEmb.length);
        setStatusAndRef('failed');
        return false;
      }

      const sim = cosineSimilarity(capturedEmb, storedEmb);
      setSimilarity(sim);

      const isMatch = sim >= SIMILARITY_THRESHOLD;
      setStatusAndRef(isMatch ? 'verified' : 'failed');
      setIsVerified(isMatch);

      devLog(`[FaceRec] Verification: similarity=${sim.toFixed(3)}, match=${isMatch}, dim=${capturedEmb.length}`);
      return isMatch;
    } catch (err) {
      devWarn('[FaceRec] Verification failed:', err);
      setStatusAndRef('failed');
      return false;
    }
  }, []);

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
    // Phase 26b: reset CNN state
    cnnEmbeddingsRef.current = [];
    spoofVotesRef.current = [];
    cnnRunningRef.current = false;
    lastCnnTimestampRef.current = 0;
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
