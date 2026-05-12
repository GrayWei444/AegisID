/**
 * AegisID v20 Occlusion Gate — 41 landmark × (Laplacian + RGB) × 區域投票
 *
 * 為什麼需要：
 *   MediaPipe FaceLandmarker 對被遮的 landmark 用 3DMM 推測產生幻覺座標
 *   （已確認的 GitHub bug，visibility/presence 永遠 0）。下游所有 hash/3D 計算
 *   都被污染。半臉、口罩、帽子、墨鏡攻擊都能通過。
 *
 * 解：
 *   在 MediaPipe 給座標之後、所有 landmark 數學之前，加一個閘門。用實際畫面像素
 *   確認每個關鍵 landmark 真的落在五官位置上。閘門不通過的幀，整幀丟掉。
 *
 * 演算法（v20，2026-05-10 實測驗證）：
 *   1. 在 41 個關鍵 landmark 位置採 11×11 像素 patch
 *   2. 算 Laplacian 邊緣強度（真五官有強邊緣，遮擋平滑）
 *   3. 算 RGB 平均（手/口罩/墨鏡的色彩跟臉皮膚不同）
 *   4. 跟個人化 baseline 比：lap drop > 50% 或 RGB ΔE > 0.18 → landmark 異常
 *   5. 5 個區域投票（TOP/LEFT/RIGHT/BOTTOM/CENTER），任一區 ≥50% 異常 → 該幀遮擋
 *
 * 實測（gate-log-1778417206067, v20）：
 *   - 乾淨臉：0/104 誤判（0% false positive）
 *   - 手遮左半：78/104 偵測（75%）
 *   - 手遮右半：102/102 偵測（100%）
 *
 * 註冊與登入共用同一閘門：
 *   - 註冊：進入 blink/turn_head 挑戰前 pre-flight + 每幀 filter
 *   - 登入：進入 verify 錄製前 pre-flight + 每幀 filter
 *
 * @see tools/face-id-test.html (測試頁完整實作 + Calibrate UI)
 */

import * as db from '../database';
import { devLog, devWarn } from '../utils/devLog';
import type { FaceLandmark } from './types';

// ============================================================================
// Constants — 41 landmarks × 5 regions
// ============================================================================

/** 41 個關鍵 MediaPipe landmark 索引（跨 5 個區域） */
export const GATE_LM: readonly number[] = [
  // [0..4] FOREHEAD
  10, 109, 338, 67, 297,
  // [5..7] L_BROW (用戶右眉，相機看是左)
  70, 105, 66,
  // [8..10] R_BROW
  300, 334, 296,
  // [11..14] L_EYE
  33, 133, 159, 145,
  // [15..18] R_EYE
  263, 362, 386, 374,
  // [19..21] L_CHEEK
  116, 117, 50,
  // [22..24] R_CHEEK
  345, 346, 280,
  // [25..28] NOSE
  6, 168, 1, 4,
  // [29..30] L_MOUTH
  61, 78,
  // [31..32] R_MOUTH
  291, 308,
  // [33..34] LIP
  13, 14,
  // [35..36] CHIN
  152, 175,
  // [37..38] L_JAW
  132, 172,
  // [39..40] R_JAW
  361, 397,
];

export const GATE_LM_NAMES: readonly string[] = [
  'F0','F1','F2','F3','F4',
  'LB0','LB1','LB2',
  'RB0','RB1','RB2',
  'LE0','LE1','LE2','LE3',
  'RE0','RE1','RE2','RE3',
  'LC0','LC1','LC2',
  'RC0','RC1','RC2',
  'N0','N1','N2','N3',
  'LM0','LM1',
  'RM0','RM1',
  'LP0','LP1',
  'CH0','CH1',
  'LJ0','LJ1',
  'RJ0','RJ1',
];

/** 5 個區域 → GATE_LM 中的 index 列表 */
export const GATE_REGIONS: Readonly<Record<string, readonly number[]>> = {
  TOP:    [0,1,2,3,4, 5,6,7, 8,9,10],
  LEFT:   [5,6,7, 11,12,13,14, 19,20,21, 29,30, 37,38],
  RIGHT:  [8,9,10, 15,16,17,18, 22,23,24, 31,32, 39,40],
  BOTTOM: [29,30, 31,32, 33,34, 35,36],
  CENTER: [25,26,27,28],
};

// ============================================================================
// Config & Types
// ============================================================================

export interface GateConfig {
  /** Patch 大小（11×11 像素） */
  readonly patch: number;
  /** Laplacian 下降閾值（current/baseline，>0.5 視為異常） */
  readonly lapDropRatio: number;
  /** RGB 歐式距離閾值（/442 後 >0.18 視為異常） */
  readonly rgbDeltaMax: number;
  /** 區域內 ≥X% landmark 異常 → 區域遮擋 */
  readonly lmFailThreshold: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  patch: 11,
  lapDropRatio: 0.5,
  rgbDeltaMax: 0.18,
  lmFailThreshold: 0.5,
};

export interface GateBaseline {
  readonly lap: ReadonlyArray<number | null>;
  readonly r: ReadonlyArray<number | null>;
  readonly g: ReadonlyArray<number | null>;
  readonly b: ReadonlyArray<number | null>;
  readonly n: number;
  readonly ts: number;
}

export interface GateSample {
  readonly lap: ReadonlyArray<number | null>;
  readonly r: ReadonlyArray<number | null>;
  readonly g: ReadonlyArray<number | null>;
  readonly b: ReadonlyArray<number | null>;
}

export interface GateRegionStatus {
  readonly flagCount: number;
  readonly total: number;
  readonly ratio: number;
}

export interface GateScore {
  readonly occluded: boolean;
  readonly occludedRegion: string | null;
  readonly regions: Readonly<Record<string, GateRegionStatus>>;
  readonly perLm: ReadonlyArray<{
    name: string;
    lap_drop: number | null;
    rgb_delta: number | null;
    flagged: boolean;
  }>;
}

export interface GateFramePassResult {
  readonly pass: boolean;
  readonly reason: 'no_baseline' | 'sample_fail' | 'occluded' | 'ok';
  readonly occludedRegion?: string | null;
  readonly regions?: Readonly<Record<string, GateRegionStatus>>;
  readonly sample?: GateSample;
}

export interface GatePreflightResult {
  readonly pass: boolean;
  readonly reason: string;
  readonly passRate: number;
  readonly sampleCount: number;
  readonly regionCounts?: Record<string, { occluded: number; total: number }>;
}

// ============================================================================
// Pixel sampling (Laplacian + RGB)
// ============================================================================

let _sampleCanvas: HTMLCanvasElement | null = null;
function _getSampleCanvas(): HTMLCanvasElement {
  if (!_sampleCanvas) {
    _sampleCanvas = document.createElement('canvas');
  }
  return _sampleCanvas;
}

/**
 * 對單幀 video 採樣 41 個 landmark 的 Laplacian + RGB
 */
export function sampleLandmarks(
  video: HTMLVideoElement,
  landmarks: ReadonlyArray<FaceLandmark>,
  config: GateConfig = DEFAULT_GATE_CONFIG,
): GateSample | null {
  if (!video || video.readyState < 2) return null;
  const W = video.videoWidth;
  const H = video.videoHeight;
  if (!W || !H) return null;
  if (!landmarks || landmarks.length < 468) return null;

  const canvas = _getSampleCanvas();
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try { ctx.drawImage(video, 0, 0, W, H); } catch { return null; }

  const P = config.patch;
  const half = Math.floor(P / 2);
  const N = GATE_LM.length;
  const lap: (number | null)[] = new Array(N);
  const r: (number | null)[] = new Array(N);
  const g: (number | null)[] = new Array(N);
  const b: (number | null)[] = new Array(N);

  for (let i = 0; i < N; i++) {
    const idx = GATE_LM[i];
    const lm = landmarks[idx];
    if (!lm) { lap[i] = null; r[i] = null; g[i] = null; b[i] = null; continue; }
    const x = Math.floor(lm.x * W);
    const y = Math.floor(lm.y * H);
    if (x < half + 1 || x > W - half - 2 || y < half + 1 || y > H - half - 2) {
      lap[i] = null; r[i] = null; g[i] = null; b[i] = null; continue;
    }
    let px: Uint8ClampedArray;
    try { px = ctx.getImageData(x - half, y - half, P, P).data; }
    catch { lap[i] = null; r[i] = null; g[i] = null; b[i] = null; continue; }

    // 灰階 + RGB 平均
    const gray = new Float32Array(P * P);
    let sumR = 0, sumG = 0, sumB = 0;
    const total = P * P;
    for (let p = 0; p < total; p++) {
      const R = px[p * 4];
      const G = px[p * 4 + 1];
      const B = px[p * 4 + 2];
      gray[p] = 0.299 * R + 0.587 * G + 0.114 * B;
      sumR += R; sumG += G; sumB += B;
    }
    r[i] = sumR / total;
    g[i] = sumG / total;
    b[i] = sumB / total;

    // Laplacian (4-neighbour)
    let sumAbs = 0, count = 0;
    for (let py = 1; py < P - 1; py++) {
      for (let px2 = 1; px2 < P - 1; px2++) {
        const c = gray[py * P + px2];
        const lapV = 4 * c - gray[(py - 1) * P + px2] - gray[(py + 1) * P + px2]
                       - gray[py * P + px2 - 1] - gray[py * P + px2 + 1];
        sumAbs += Math.abs(lapV);
        count++;
      }
    }
    lap[i] = count > 0 ? sumAbs / count : 0;
  }

  return { lap, r, g, b };
}

// ============================================================================
// Scoring
// ============================================================================

export function scoreFrame(
  sample: GateSample,
  baseline: GateBaseline,
  config: GateConfig = DEFAULT_GATE_CONFIG,
): GateScore {
  const N = GATE_LM.length;
  const perLm: GateScore['perLm'][number][] = [];

  for (let i = 0; i < N; i++) {
    if (sample.lap[i] == null || baseline.lap[i] == null) {
      perLm.push({ name: GATE_LM_NAMES[i], lap_drop: null, rgb_delta: null, flagged: false });
      continue;
    }
    const blLap = baseline.lap[i] as number;
    const curLap = sample.lap[i] as number;
    const lapDrop = blLap > 0 ? Math.max(0, 1 - curLap / blLap) : 0;
    const dr = (sample.r[i] as number) - (baseline.r[i] as number);
    const dg = (sample.g[i] as number) - (baseline.g[i] as number);
    const dbl = (sample.b[i] as number) - (baseline.b[i] as number);
    const rgbDelta = Math.sqrt(dr * dr + dg * dg + dbl * dbl) / 442;
    const flagged = lapDrop > config.lapDropRatio || rgbDelta > config.rgbDeltaMax;
    perLm.push({ name: GATE_LM_NAMES[i], lap_drop: lapDrop, rgb_delta: rgbDelta, flagged });
  }

  const regions: Record<string, GateRegionStatus> = {};
  let occludedRegion: string | null = null;
  for (const rname of Object.keys(GATE_REGIONS)) {
    const indices = GATE_REGIONS[rname];
    let flag = 0, valid = 0;
    for (const k of indices) {
      const lm = perLm[k];
      if (lm.lap_drop == null) continue;
      valid++;
      if (lm.flagged) flag++;
    }
    const ratio = valid > 0 ? flag / valid : 0;
    regions[rname] = { flagCount: flag, total: valid, ratio };
    if (ratio >= config.lmFailThreshold && valid >= 3 && !occludedRegion) {
      occludedRegion = rname;
    }
  }

  return { occluded: occludedRegion !== null, occludedRegion, regions, perLm };
}

/**
 * 對單幀直接判斷：是否該保留進下游 landmark 數學
 */
export function framePass(
  video: HTMLVideoElement,
  landmarks: ReadonlyArray<FaceLandmark>,
  baseline: GateBaseline | null,
  config: GateConfig = DEFAULT_GATE_CONFIG,
): GateFramePassResult {
  const sample = sampleLandmarks(video, landmarks, config);
  if (!sample) return { pass: true, reason: 'sample_fail' };
  if (!baseline) return { pass: true, reason: 'no_baseline', sample };
  const score = scoreFrame(sample, baseline, config);
  return {
    pass: !score.occluded,
    reason: score.occluded ? 'occluded' : 'ok',
    occludedRegion: score.occludedRegion,
    regions: score.regions,
    sample,
  };
}

// ============================================================================
// Calibration & pre-flight
// ============================================================================

type DetectFn = (video: HTMLVideoElement, ts: number) => {
  faceLandmarks?: FaceLandmark[][];
} | null;

/**
 * 採 ~2 秒乾淨臉 → 建 baseline（per-LM lap + RGB 平均）
 *
 * v20.1: 加 isCleanFn 守門 — 只有當外部判定「臉部目前無遮擋」時才採樣
 *        例如 HSV+Blendshape 口罩偵測，傳 () => !getOcclusionResult().hasMask
 *        若 isCleanFn 持續回 false → 沒有 sample 累積 → 此函式回 null（baseline 不存）
 *        防止用戶一開始就戴口罩 → baseline 記成戴口罩 → gate 永遠失效
 *
 * @param waitMs 最多等多久等到第一個 clean frame（預設 30 秒）；超時回 null
 */
export async function calibrateBaseline(
  video: HTMLVideoElement,
  detect: DetectFn,
  durationMs = 2000,
  isCleanFn?: () => boolean,
  waitMs = 30000,
): Promise<GateBaseline | null> {
  if (!video || video.readyState < 2) return null;
  const samples: GateSample[] = [];

  // Step 1: 等到 isCleanFn 持續 1 秒回 true（避免單幀 flicker）
  if (isCleanFn) {
    const waitStart = performance.now();
    let cleanSince: number | null = null;
    while (performance.now() - waitStart < waitMs) {
      const isClean = isCleanFn();
      if (isClean) {
        if (cleanSince === null) cleanSince = performance.now();
        else if (performance.now() - cleanSince >= 1000) break;  // 1 秒乾淨 → 開始採樣
      } else {
        cleanSince = null;
      }
      await new Promise<void>((rs) => requestAnimationFrame(() => rs()));
    }
    if (cleanSince === null || performance.now() - cleanSince < 1000) {
      // 一直沒有乾淨 → 放棄
      return null;
    }
  }

  // Step 2: 採樣 durationMs，期間若 isCleanFn 變 false 就丟棄該幀
  const start = performance.now();
  while (performance.now() - start < durationMs) {
    try {
      if (isCleanFn && !isCleanFn()) {
        await new Promise<void>((rs) => requestAnimationFrame(() => rs()));
        continue;
      }
      const t = performance.now();
      const r = detect(video, t);
      if (r?.faceLandmarks?.length) {
        const lm = r.faceLandmarks[0];
        const s = sampleLandmarks(video, lm);
        if (s) samples.push(s);
      }
    } catch { /* ignore */ }
    await new Promise<void>((rs) => requestAnimationFrame(() => rs()));
  }
  if (samples.length < 5) return null;

  const N = GATE_LM.length;
  const lap: (number | null)[] = new Array(N);
  const rArr: (number | null)[] = new Array(N);
  const gArr: (number | null)[] = new Array(N);
  const bArr: (number | null)[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const lapVals: number[] = [];
    const rVals: number[] = [];
    const gVals: number[] = [];
    const bVals: number[] = [];
    for (const s of samples) {
      if (s.lap[i] != null) {
        lapVals.push(s.lap[i] as number);
        rVals.push(s.r[i] as number);
        gVals.push(s.g[i] as number);
        bVals.push(s.b[i] as number);
      }
    }
    const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    lap[i] = lapVals.length >= 3 ? mean(lapVals) : null;
    rArr[i] = rVals.length >= 3 ? mean(rVals) : null;
    gArr[i] = gVals.length >= 3 ? mean(gVals) : null;
    bArr[i] = bVals.length >= 3 ? mean(bVals) : null;
  }
  return { lap, r: rArr, g: gArr, b: bArr, n: samples.length, ts: Date.now() };
}

/**
 * Pre-flight：在進入挑戰/錄製前，採 ~1 秒驗證 ≥60% 幀通過閘門
 */
export async function preflightCheck(
  video: HTMLVideoElement,
  detect: DetectFn,
  baseline: GateBaseline,
  durationMs = 1000,
  config: GateConfig = DEFAULT_GATE_CONFIG,
): Promise<GatePreflightResult> {
  let passCount = 0;
  let sampleCount = 0;
  const regionCounts: Record<string, { occluded: number; total: number }> = {};
  for (const r of Object.keys(GATE_REGIONS)) regionCounts[r] = { occluded: 0, total: 0 };

  const start = performance.now();
  while (performance.now() - start < durationMs) {
    try {
      const t = performance.now();
      const r = detect(video, t);
      if (r?.faceLandmarks?.length) {
        const lm = r.faceLandmarks[0];
        const s = sampleLandmarks(video, lm, config);
        if (s) {
          sampleCount++;
          const score = scoreFrame(s, baseline, config);
          if (!score.occluded) passCount++;
          for (const rname of Object.keys(score.regions)) {
            const rs = score.regions[rname];
            regionCounts[rname].total++;
            if (rs.ratio >= config.lmFailThreshold && rs.total >= 3) {
              regionCounts[rname].occluded++;
            }
          }
        }
      }
    } catch { /* ignore */ }
    await new Promise<void>((rs) => requestAnimationFrame(() => rs()));
  }

  if (sampleCount === 0) {
    return { pass: false, reason: '偵測不到臉', passRate: 0, sampleCount: 0, regionCounts };
  }
  const passRate = passCount / sampleCount;
  const pass = passRate >= 0.6;
  let reason = 'OK';
  if (!pass) {
    const occRegions = Object.keys(regionCounts).filter(
      (r) => regionCounts[r].occluded > regionCounts[r].total * 0.5,
    );
    reason = `遮擋偵測 — 區域: ${occRegions.join(',') || '不確定'}`;
  }
  return { pass, reason, passRate, sampleCount, regionCounts };
}

// ============================================================================
// Storage
// ============================================================================

const BASELINE_KEY = 'aegis_gate_baseline';

export async function saveBaseline(baseline: GateBaseline): Promise<void> {
  const json = JSON.stringify(baseline);
  try { localStorage.setItem(BASELINE_KEY, json); } catch { /* ignore */ }
  db.setSetting(BASELINE_KEY, json).catch((e) => devWarn('[Gate] SQLite save failed:', e));
  devLog('[Gate] Baseline saved (n=', baseline.n, ')');
}

export async function loadBaseline(): Promise<GateBaseline | null> {
  let json: string | null = null;
  try { json = localStorage.getItem(BASELINE_KEY); } catch { /* ignore */ }
  if (!json) {
    try { json = (await db.getSetting(BASELINE_KEY)) ?? null; }
    catch (e) { devWarn('[Gate] SQLite load failed:', e); }
  }
  if (!json) return null;
  try { return JSON.parse(json) as GateBaseline; }
  catch { return null; }
}

export async function clearBaseline(): Promise<void> {
  try { localStorage.removeItem(BASELINE_KEY); } catch { /* ignore */ }
  await db.setSetting(BASELINE_KEY, '').catch(() => {});
  devLog('[Gate] Baseline cleared');
}

export function hasBaselineCached(): boolean {
  try { return localStorage.getItem(BASELINE_KEY) !== null; }
  catch { return false; }
}
