import { devLog } from '../utils/devLog';

/**
 * Phase 11: 設備指紋服務
 *
 * 專注於設備指紋的收集和本地儲存
 * 用於識別同一設備（清資料重註冊、多帳號偵測）
 *
 * 與同源偵測 (sameSourceCheck.ts) 分開處理
 */

// ============================================
// 類型定義
// ============================================

export interface DeviceFingerprint {
  canvasHash: string;
  webglHash: string;
  audioHash: string;
  timestamp: number;
}

export interface StoredDeviceFingerprint extends DeviceFingerprint {
  userPubkey: string;
  createdAt: number;
}

// ============================================
// Hash 工具函數
// ============================================

/**
 * 使用 SHA-256 計算字串的 hash
 */
async function sha256(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================
// Canvas 指紋
// ============================================

/**
 * 收集 Canvas 指紋
 *
 * Canvas 指紋基於瀏覽器渲染引擎的細微差異
 * 同一設備的不同瀏覽器可能產生不同結果
 */
async function getCanvasFingerprint(): Promise<string> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 50;
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      return 'canvas-not-supported';
    }

    // 繪製文字（使用多種字體和樣式）
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);

    ctx.fillStyle = '#069';
    ctx.fillText('AegisTalk FP', 2, 15);

    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.font = '18px Times New Roman';
    ctx.fillText('防詐守護', 4, 30);

    // 繪製幾何圖形
    ctx.beginPath();
    ctx.arc(50, 30, 10, 0, Math.PI * 2);
    ctx.strokeStyle = '#333';
    ctx.stroke();

    // 取得圖像數據並 hash
    const dataUrl = canvas.toDataURL();
    return await sha256(dataUrl);
  } catch (err) {
    console.error('[DeviceFingerprint] Canvas fingerprint error:', err);
    return 'canvas-error';
  }
}

// ============================================
// WebGL 指紋
// ============================================

/**
 * 收集 WebGL 指紋
 *
 * 基於 GPU 渲染器和供應商資訊
 */
async function getWebGLFingerprint(): Promise<string> {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');

    if (!gl || !(gl instanceof WebGLRenderingContext)) {
      return 'webgl-not-supported';
    }

    // 取得渲染器資訊
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    let renderer = 'unknown';
    let vendor = 'unknown';

    if (debugInfo) {
      renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || 'unknown';
      vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || 'unknown';
    }

    // 取得支援的擴展
    const extensions = gl.getSupportedExtensions()?.join(',') || '';

    // 取得其他參數
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const maxViewportDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);

    const fingerprintData = [
      renderer,
      vendor,
      maxTextureSize,
      maxViewportDims ? maxViewportDims.toString() : '',
      extensions.slice(0, 500), // 限制長度
    ].join('|');

    return await sha256(fingerprintData);
  } catch (err) {
    console.error('[DeviceFingerprint] WebGL fingerprint error:', err);
    return 'webgl-error';
  }
}

// ============================================
// AudioContext 指紋
// ============================================

/**
 * 收集 AudioContext 指紋
 *
 * 基於音訊處理的細微差異
 */
async function getAudioFingerprint(): Promise<string> {
  try {
    const AudioContext = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof window.AudioContext }).webkitAudioContext;
    if (!AudioContext) {
      return 'audio-not-supported';
    }

    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const analyser = context.createAnalyser();
    const gainNode = context.createGain();
    const scriptProcessor = context.createScriptProcessor(4096, 1, 1);

    // 設定音訊參數
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(10000, context.currentTime);
    gainNode.gain.setValueAtTime(0, context.currentTime);

    // 連接節點
    oscillator.connect(analyser);
    analyser.connect(scriptProcessor);
    scriptProcessor.connect(gainNode);
    gainNode.connect(context.destination);

    // 取得頻率數據
    const frequencyData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(frequencyData);

    // 取得特徵值
    const fingerprint = [
      context.sampleRate,
      analyser.frequencyBinCount,
      frequencyData.slice(0, 30).join(','),
    ].join('|');

    // 清理
    oscillator.disconnect();
    analyser.disconnect();
    scriptProcessor.disconnect();
    gainNode.disconnect();
    await context.close();

    return await sha256(fingerprint);
  } catch (err) {
    console.error('[DeviceFingerprint] Audio fingerprint error:', err);
    return 'audio-error';
  }
}

// ============================================
// 本地儲存
// ============================================

const STORAGE_KEY = 'aegis_device_fingerprint';

/**
 * 儲存設備指紋到本地
 */
export function saveDeviceFingerprint(fingerprint: DeviceFingerprint, userPubkey: string): void {
  const stored: StoredDeviceFingerprint = {
    ...fingerprint,
    userPubkey,
    createdAt: Date.now(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  devLog('[DeviceFingerprint] Saved to localStorage');
}

/**
 * 從本地讀取設備指紋
 */
export function loadDeviceFingerprint(): StoredDeviceFingerprint | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    return JSON.parse(stored) as StoredDeviceFingerprint;
  } catch {
    return null;
  }
}

/**
 * 比對當前設備指紋與儲存的指紋
 * 用於偵測「同設備多帳號」
 */
export async function checkSameDevice(): Promise<{
  isSameDevice: boolean;
  storedPubkey: string | null;
  similarity: number;
}> {
  const stored = loadDeviceFingerprint();
  if (!stored) {
    return { isSameDevice: false, storedPubkey: null, similarity: 0 };
  }

  const current = await collectDeviceFingerprint();

  // 比對各維度
  let matchCount = 0;
  if (current.canvasHash === stored.canvasHash) matchCount++;
  if (current.webglHash === stored.webglHash) matchCount++;
  if (current.audioHash === stored.audioHash) matchCount++;

  const similarity = matchCount / 3;
  const isSameDevice = similarity >= 0.66; // 至少 2/3 相符

  return {
    isSameDevice,
    storedPubkey: stored.userPubkey,
    similarity,
  };
}

// ============================================
// 主要 API
// ============================================

/**
 * 收集所有設備指紋
 */
export async function collectDeviceFingerprint(): Promise<DeviceFingerprint> {
  devLog('[DeviceFingerprint] Collecting fingerprints...');

  const [canvasHash, webglHash, audioHash] = await Promise.all([
    getCanvasFingerprint(),
    getWebGLFingerprint(),
    getAudioFingerprint(),
  ]);

  const fingerprint: DeviceFingerprint = {
    canvasHash,
    webglHash,
    audioHash,
    timestamp: Date.now(),
  };

  devLog('[DeviceFingerprint] Collected:', {
    canvasHash: canvasHash.slice(0, 16) + '...',
    webglHash: webglHash.slice(0, 16) + '...',
    audioHash: audioHash.slice(0, 16) + '...',
  });

  return fingerprint;
}

/**
 * 計算設備指紋的複合 Hash
 * 用於後端儲存和比對
 */
export async function computeDeviceHash(fingerprint: DeviceFingerprint): Promise<string> {
  const combined = [
    fingerprint.canvasHash,
    fingerprint.webglHash,
    fingerprint.audioHash,
  ].join('|');
  return await sha256(combined);
}

// ============================================
// 後端 API 呼叫
// ============================================

const API_URL = import.meta.env.VITE_API_URL || 'https://api.aegisrd.com';

export interface DeviceFingerprintCheckResult {
  riskLevel: 'low' | 'medium' | 'high' | 'blocked';
  riskScore: number;
  reasons: string[];
  allowed: boolean;
}

/**
 * 將設備指紋送到後端檢查
 *
 * 後端會檢查：
 * 1. 同 Canvas Hash 24hr 內出現幾次
 * 2. 同 WebGL Hash 24hr 內出現幾次
 * 3. 同 IP 網段 24hr 內出現幾次
 *
 * @param userPubkey - 使用者公鑰
 * @param fingerprint - 設備指紋
 * @returns 風險評估結果
 */
export async function checkDeviceFingerprintWithBackend(
  userPubkey: string,
  fingerprint: DeviceFingerprint
): Promise<DeviceFingerprintCheckResult> {
  // 開發模式：跳過檢查
  const skipCheck = import.meta.env.VITE_SKIP_DEVICE_CHECK === 'true';
  if (skipCheck) {
    devLog('[DeviceFingerprint] Skipping backend check (dev mode)');
    return {
      riskLevel: 'low',
      riskScore: 0,
      reasons: ['開發模式，跳過檢查'],
      allowed: true,
    };
  }

  try {
    devLog('[DeviceFingerprint] Checking with backend...');

    // E2E 測試模式：加入特殊 header 跳過註冊限制（僅限開發環境）
    const isE2ETest = import.meta.env.DEV && typeof window !== 'undefined' && localStorage.getItem('AEGIS_E2E_TEST') === 'true';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (isE2ETest) {
      headers['X-E2E-Test'] = 'true';
      devLog('[DeviceFingerprint] E2E test mode - adding bypass header');
    }

    const response = await fetch(`${API_URL}/api/fingerprint/check`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user_pubkey: userPubkey,
        canvas_hash: fingerprint.canvasHash,
        webgl_hash: fingerprint.webglHash,
        // audio_hash 沒有在後端使用，這裡暫時不送
        network_hash: null,
        pin_behavior_hash: null,
      }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();

    devLog('[DeviceFingerprint] Backend check result:', {
      riskLevel: data.risk_level,
      riskScore: data.risk_score,
      allowed: data.allowed,
    });

    return {
      riskLevel: data.risk_level,
      riskScore: data.risk_score,
      reasons: data.reasons || [],
      allowed: data.allowed,
    };
  } catch (err) {
    console.error('[DeviceFingerprint] Backend check failed:', err);

    // API 失敗時預設拒絕（安全優先）
    return {
      riskLevel: 'high',
      riskScore: 50,
      reasons: ['API 連線失敗，請稍後再試'],
      allowed: false,
    };
  }
}

export default {
  collectDeviceFingerprint,
  computeDeviceHash,
  saveDeviceFingerprint,
  loadDeviceFingerprint,
  checkSameDevice,
  checkDeviceFingerprintWithBackend,
};
