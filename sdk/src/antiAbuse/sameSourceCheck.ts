/**
 * Same-Source Check — IP-based bulk registration detection
 *
 * Detects batch account creation from same IP /24 network segment.
 * Calls VPS API which tracks IP hash + IPv6 device hash.
 *
 * Safe-first: defaults to deny if API is unreachable.
 */

// ============================================================================
// Config
// ============================================================================

let _apiBaseUrl = 'https://api.aegisrd.com';
let _skipCheck = false;

/** Configure the API base URL */
export function setSameSourceApiUrl(url: string): void {
  _apiBaseUrl = url;
}

/** Enable/disable dev-mode skip */
export function setSameSourceSkipCheck(skip: boolean): void {
  _skipCheck = skip;
}

// ============================================================================
// Types
// ============================================================================

export interface SameSourceCheckResult {
  riskLevel: 'low' | 'medium' | 'high' | 'blocked';
  riskScore: number;
  reasons: string[];
  allowed: boolean;
  recentRegistrations: number;
}

export interface SameSourceStats {
  total_registrations: number;
  last_24h_registrations: number;
  blocked_24h: number;
  top_ip_segments: Array<{ ip_hash: string; count: number }>;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Check same-source (bulk IP registration)
 *
 * @param userPubkey - User's public key (for record keeping)
 * @returns Risk assessment result
 */
export async function checkSameSource(userPubkey: string): Promise<SameSourceCheckResult> {
  if (_skipCheck) {
    return {
      riskLevel: 'low',
      riskScore: 0,
      reasons: ['開發模式，跳過檢查'],
      allowed: true,
      recentRegistrations: 0,
    };
  }

  try {
    const response = await fetch(`${_apiBaseUrl}/api/same-source/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_pubkey: userPubkey }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();

    return {
      riskLevel: data.risk_level,
      riskScore: data.risk_score,
      reasons: data.reasons || [],
      allowed: data.allowed,
      recentRegistrations: data.recent_registrations || 0,
    };
  } catch {
    // API failure → deny (safe-first)
    return {
      riskLevel: 'high',
      riskScore: 50,
      reasons: ['API 連線失敗，請稍後再試'],
      allowed: false,
      recentRegistrations: 0,
    };
  }
}

/**
 * Get same-source detection statistics (admin)
 */
export async function getSameSourceStats(): Promise<SameSourceStats | null> {
  try {
    const response = await fetch(`${_apiBaseUrl}/api/same-source/stats`);
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    return await response.json();
  } catch {
    return null;
  }
}
