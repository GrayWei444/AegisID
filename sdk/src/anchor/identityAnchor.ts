/**
 * Identity Anchor Service
 *
 * Upload Face LSH + PIN behavior LSH to VPS as identity anchor.
 * VPS only stores LSH hashes (irreversible) for cross-device identity verification.
 *
 * Core principle: know it's the same person, but not who they are.
 */

import { computeFaceLSHHash, computePinLSHHash } from '../lsh';
import type { PinBehaviorFingerprint } from '../behavior';
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
 * Called after registration (PIN + Face enrolled).
 * Non-blocking, fails silently.
 */
export async function registerIdentityAnchor(params: {
  faceEmbedding: Float32Array;
  pinFingerprint: PinBehaviorFingerprint;
  publicKey: string;
  displayName: string;
  pin: string;
}): Promise<RegisterResult> {
  try {
    // 1. Compute LSH hashes
    const faceLSH = computeFaceLSHHash(params.faceEmbedding);
    const pinLSH = computePinLSHHash(params.pinFingerprint);

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
        face_lsh_hash: faceLSH.hexHash,
        behavior_lsh_hash: pinLSH.hexHash,
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
 * New device: face scan + PIN → query VPS for matching identity anchor.
 * Returns encrypted blob if confidence ≥ 0.80.
 */
export async function lookupIdentityAnchor(params: {
  faceEmbedding: Float32Array;
  pinFingerprint?: PinBehaviorFingerprint;
}): Promise<LookupResult> {
  try {
    const faceLSH = computeFaceLSHHash(params.faceEmbedding);
    const pinLSH = params.pinFingerprint
      ? computePinLSHHash(params.pinFingerprint)
      : null;

    const response = await fetch(`${_apiBaseUrl}/aegisid/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        face_lsh_hash: faceLSH.hexHash,
        behavior_lsh_hash: pinLSH?.hexHash ?? '',
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
