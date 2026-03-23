/**
 * Phase 26: Face Embedding Encrypted Storage
 *
 * 加密儲存 face embedding 到 localStorage + SQLite（dual-write 模式）
 * 使用 AES-256-GCM 加密，金鑰來自 keyEncryption 模組
 *
 * 安全原則：
 * - face embedding 永不以明文儲存
 * - 永不上傳至雲端或 VPS
 * - 僅限 QR 面對面傳輸（Phase 27）
 */

import * as db from '../database';
import { devLog, devWarn } from '../utils/devLog';
import type { FaceEmbedding, StoredFaceEmbedding, StoredBoneRatioData, BoneRatioPlainData } from './types';

// ============================================================================
// Constants
// ============================================================================

const STORAGE_KEY = 'aegis_face_embedding';

// ============================================================================
// Helpers
// ============================================================================

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]));
  }
  return btoa(parts.join(''));
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ============================================================================
// Encryption (standalone AES-256-GCM, PIN-derived key from keyEncryption)
// ============================================================================

/**
 * 用 AES-256-GCM 加密 face embedding
 *
 * @param embedding 128 維 Float32Array
 * @param encryptionKey 來自 keyEncryption.deriveEncryptionKey() 的 CryptoKey
 */
async function encryptEmbedding(
  embedding: FaceEmbedding,
  encryptionKey: CryptoKey
): Promise<StoredFaceEmbedding> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);

  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    encryptionKey,
    plaintext.buffer as ArrayBuffer
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertextBuf)),
    iv: bytesToBase64(iv),
    timestamp: Date.now(),
  };
}

/**
 * 用 AES-256-GCM 解密 face embedding
 */
async function decryptEmbedding(
  stored: StoredFaceEmbedding,
  encryptionKey: CryptoKey
): Promise<FaceEmbedding> {
  const iv = base64ToBytes(stored.iv);
  const ciphertext = base64ToBytes(stored.ciphertext);

  const plaintextBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    encryptionKey,
    ciphertext.buffer as ArrayBuffer
  );

  return new Float32Array(plaintextBuf);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * 儲存加密的 face embedding（dual-write: localStorage + SQLite）
 */
export async function saveFaceEmbedding(
  embedding: FaceEmbedding,
  encryptionKey: CryptoKey
): Promise<void> {
  const stored = await encryptEmbedding(embedding, encryptionKey);
  const json = JSON.stringify(stored);

  // Dual-write
  localStorage.setItem(STORAGE_KEY, json);
  db.setSetting(STORAGE_KEY, json).catch((e) => {
    devWarn('[FaceStorage] SQLite write failed:', e);
  });

  devLog('[FaceStorage] Saved encrypted face embedding');
}

/**
 * 讀取並解密 face embedding
 *
 * @returns FaceEmbedding (Float32Array) 或 null（未註冊）
 */
export async function getFaceEmbedding(
  encryptionKey: CryptoKey
): Promise<FaceEmbedding | null> {
  // Try localStorage first (fast), fallback to SQLite
  let json = localStorage.getItem(STORAGE_KEY);
  if (!json) {
    try {
      json = await db.getSetting(STORAGE_KEY) ?? null;
    } catch (e) {
      devWarn('[FaceStorage] SQLite read failed:', e);
    }
  }

  if (!json) return null;

  try {
    const stored: StoredFaceEmbedding = JSON.parse(json);
    const embedding = await decryptEmbedding(stored, encryptionKey);

    // Ensure dual-write consistency
    if (!localStorage.getItem(STORAGE_KEY)) {
      localStorage.setItem(STORAGE_KEY, json);
    }
    db.setSetting(STORAGE_KEY, json).catch(() => {});

    devLog('[FaceStorage] Loaded face embedding, dim:', embedding.length);
    return embedding;
  } catch (e) {
    devWarn('[FaceStorage] Decryption failed:', e);
    return null;
  }
}

/**
 * 檢查是否已註冊臉部
 */
export function hasFaceEnrolled(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

/**
 * iOS Safari PWA 會在記憶體壓力或 7 天未用時清除 localStorage。
 * 此函數從 SQLite 恢復 face embedding 到 localStorage，
 * 確保 hasFaceEnrolled() 同步檢查仍然有效。
 *
 * 應在 App 啟動時（database ready 後）呼叫。
 */
export async function ensureFaceStorageSync(): Promise<void> {
  // localStorage 已有 → 不需要同步
  if (localStorage.getItem(STORAGE_KEY)) return;

  try {
    const json = await db.getSetting(STORAGE_KEY);
    if (json && json.length > 2) {
      // 驗證 JSON 格式正確
      JSON.parse(json);
      localStorage.setItem(STORAGE_KEY, json);
      console.error('[FaceStorage] Restored face embedding from SQLite → localStorage (iOS recovery)');
    }
  } catch (e) {
    // 靜默失敗 — 不影響 App 啟動
    devWarn('[FaceStorage] SQLite → localStorage sync failed:', e);
  }
}

/**
 * 清除臉部資料
 */
export async function clearFaceData(): Promise<void> {
  localStorage.removeItem(STORAGE_KEY);
  try {
    await db.setSetting(STORAGE_KEY, '');
  } catch (e) {
    devWarn('[FaceStorage] SQLite clear failed:', e);
  }
  devLog('[FaceStorage] Cleared face data');
}

/**
 * 取得加密的 embedding 原始資料（用於 QR 傳輸，Phase 27）
 * 改為 async 以支援 SQLite fallback（iOS localStorage 被清除時）
 */
export async function getStoredFaceEmbeddingRaw(): Promise<StoredFaceEmbedding | null> {
  let json = localStorage.getItem(STORAGE_KEY);
  if (!json) {
    try {
      json = await db.getSetting(STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }
  if (!json) return null;
  try {
    return JSON.parse(json) as StoredFaceEmbedding;
  } catch {
    return null;
  }
}

/**
 * 直接儲存已加密的 embedding（從 QR 傳輸接收，Phase 27）
 */
export async function restoreFaceEmbedding(
  stored: StoredFaceEmbedding
): Promise<void> {
  const json = JSON.stringify(stored);
  localStorage.setItem(STORAGE_KEY, json);
  db.setSetting(STORAGE_KEY, json).catch((e) => {
    devWarn('[FaceStorage] SQLite restore failed:', e);
  });
  devLog('[FaceStorage] Restored face embedding from transfer');
}

// ============================================================================
// Bone Ratio Storage (structuralId 骨骼比率系統)
// ============================================================================

const BONE_RATIO_KEY = 'aegis_face_bone_ratio';

/**
 * 儲存加密的骨骼比率資料（dual-write: localStorage + SQLite）
 *
 * @param data 骨骼比率明文資料（frontalBins + hash）
 * @param encryptionKey 來自 keyEncryption.deriveEncryptionKey() 的 CryptoKey
 */
export async function saveBoneRatioData(
  data: BoneRatioPlainData,
  encryptionKey: CryptoKey
): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));

  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    encryptionKey,
    plaintext.buffer as ArrayBuffer
  );

  const stored: StoredBoneRatioData = {
    ciphertext: bytesToBase64(new Uint8Array(ciphertextBuf)),
    iv: bytesToBase64(iv),
    timestamp: Date.now(),
    source: 'bone-ratio',
  };

  const json = JSON.stringify(stored);

  // Dual-write
  localStorage.setItem(BONE_RATIO_KEY, json);
  db.setSetting(BONE_RATIO_KEY, json).catch((e) => {
    devWarn('[FaceStorage] SQLite bone ratio write failed:', e);
  });

  // 同步更新 hasFaceEnrolled 的 key
  localStorage.setItem(STORAGE_KEY, json);
  db.setSetting(STORAGE_KEY, json).catch(() => {});

  devLog('[FaceStorage] Saved encrypted bone ratio data, bins:', Object.keys(data.frontalBins).length);
}

/**
 * 讀取並解密骨骼比率資料
 *
 * @returns BoneRatioPlainData 或 null（未註冊）
 */
export async function getBoneRatioData(
  encryptionKey: CryptoKey
): Promise<BoneRatioPlainData | null> {
  // Try localStorage first (fast), fallback to SQLite
  let json = localStorage.getItem(BONE_RATIO_KEY);
  if (!json) {
    try {
      json = await db.getSetting(BONE_RATIO_KEY) ?? null;
    } catch (e) {
      devWarn('[FaceStorage] SQLite bone ratio read failed:', e);
    }
  }

  if (!json) return null;

  try {
    const stored: StoredBoneRatioData = JSON.parse(json);
    const iv = base64ToBytes(stored.iv);
    const ciphertext = base64ToBytes(stored.ciphertext);

    const plaintextBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
      encryptionKey,
      ciphertext.buffer as ArrayBuffer
    );

    const data: BoneRatioPlainData = JSON.parse(new TextDecoder().decode(plaintextBuf));

    // Ensure dual-write consistency
    if (!localStorage.getItem(BONE_RATIO_KEY)) {
      localStorage.setItem(BONE_RATIO_KEY, json);
    }
    db.setSetting(BONE_RATIO_KEY, json).catch(() => {});

    devLog('[FaceStorage] Loaded bone ratio data, bins:', Object.keys(data.frontalBins).length);
    return data;
  } catch (e) {
    devWarn('[FaceStorage] Bone ratio decryption failed:', e);
    return null;
  }
}
