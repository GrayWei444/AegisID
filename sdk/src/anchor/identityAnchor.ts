/**
 * Identity Anchor Service
 *
 * AegisID SDK 內部完整處理身份錨點註冊：
 *   face_hash = SHA-256(25 bone bins)        → VPS 限速（同臉限 ~2 帳號）
 *   account_key = SHA-256(face_hash + PIN)   → VPS 帳號唯一 key（O(1) 查表）
 *   encrypted_blob = AES-256-GCM(identity, PIN) → VPS 存儲加密身份包
 *
 * AegisTalk 只需呼叫 registerIdentityAnchor({ faceHash, pin, publicKey, displayName })
 *
 * Core principle: know it's the same person, but not who they are.
 */

import { computeAccountKey } from '../face/structuralId';
import { encryptWithPin, decryptWithPin } from '../auth/pinHash';

// ============================================================================
// Config
// ============================================================================

let _apiBaseUrl = 'https://api.aegisrd.com';

/** Configure the API base URL (call once at app startup) */
export function setAnchorApiUrl(url: string): void {
  _apiBaseUrl = url;
}

// ============================================================================
// Types
// ============================================================================

export interface IdentityBlob {
  publicKey: string;
  displayName: string;
}

export interface RegisterResult {
  success: boolean;
  anchorId?: string;
  error?: string;
}

export interface LookupResult {
  found: boolean;
  confidence: number;
  encryptedBlob?: string;
  blobSalt?: string;
  blobIv?: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Register identity anchor
 *
 * SDK 內部完成所有計算：
 *   1. account_key = SHA-256(face_hash + PIN)
 *   2. 加密身份包 (AES-256-GCM + Argon2id)
 *   3. 上傳 VPS: face_hash (限速) + account_key (查表) + encrypted_blob
 *
 * @param faceHash SHA-256 from computeStructuralId() — 骨骼比率唯一 ID
 * @param pin 使用者的 PIN 碼（純數字）
 * @param publicKey 通訊用公鑰
 * @param displayName 顯示名稱
 */
export async function registerIdentityAnchor(params: {
  faceHash: string;
  pin: string;
  publicKey: string;
  displayName: string;
}): Promise<RegisterResult> {
  try {
    // 1. Compute account_key = SHA-256(face_hash + PIN)
    const accountKey = await computeAccountKey(params.faceHash, params.pin);

    // 2. Encrypt identity blob with PIN (AES-256-GCM + Argon2id)
    const blob: IdentityBlob = {
      publicKey: params.publicKey,
      displayName: params.displayName,
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(blob));
    const { encrypted, salt, iv } = await encryptWithPin(plaintext, params.pin);

    // 3. Upload to VPS
    const response = await fetch(`${_apiBaseUrl}/aegisid/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        face_hash: params.faceHash,
        account_key: accountKey,
        encrypted_blob: encrypted,
        blob_salt: salt,
        blob_iv: iv,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: errText };
    }

    const result = await response.json();
    return { success: true, anchorId: result.anchor_id };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Lookup identity anchor (cross-device recovery)
 *
 * 新裝置：3D 掃臉 + PIN → account_key → VPS O(1) 查表
 *
 * @param faceHash SHA-256 from computeStructuralId()
 * @param pin 使用者輸入的 PIN
 */
export async function lookupIdentityAnchor(params: {
  faceHash: string;
  pin: string;
}): Promise<LookupResult> {
  try {
    const accountKey = await computeAccountKey(params.faceHash, params.pin);

    const response = await fetch(`${_apiBaseUrl}/aegisid/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_key: accountKey,
      }),
    });

    if (!response.ok) {
      return { found: false, confidence: 0 };
    }

    const result = await response.json();
    return {
      found: result.found,
      confidence: result.confidence,
      encryptedBlob: result.encrypted_blob,
      blobSalt: result.blob_salt,
      blobIv: result.blob_iv,
    };
  } catch {
    return { found: false, confidence: 0 };
  }
}

/**
 * Decrypt identity anchor blob
 *
 * @returns IdentityBlob (publicKey + displayName) or null on failure
 */
export async function decryptAnchorBlob(params: {
  encryptedBlob: string;
  blobSalt: string;
  blobIv: string;
  pin: string;
}): Promise<IdentityBlob | null> {
  try {
    const plaintext = await decryptWithPin(
      params.encryptedBlob,
      params.blobSalt,
      params.blobIv,
      params.pin,
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}
