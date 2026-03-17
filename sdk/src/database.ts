/**
 * Database Adapter for AegisID SDK
 *
 * Provides persistent key-value storage for SDK modules (e.g., face/storage.ts).
 * Default: localStorage fallback.
 * Host apps (AegisTalk) inject their real database via setDatabaseAdapter().
 */

// ============================================================================
// Adapter Interface
// ============================================================================

export interface DatabaseAdapter {
  getSetting(key: string): Promise<string | null | undefined>;
  setSetting(key: string, value: string): Promise<void>;
}

// ============================================================================
// Singleton
// ============================================================================

let adapter: DatabaseAdapter | null = null;

/**
 * Inject a database adapter (call once at app startup).
 * When injected, all SDK storage operations use the provided adapter
 * instead of the localStorage fallback.
 */
export function setDatabaseAdapter(newAdapter: DatabaseAdapter): void {
  adapter = newAdapter;
}

// ============================================================================
// Public API (used by face/storage.ts)
// ============================================================================

export async function getSetting(key: string): Promise<string | undefined> {
  try {
    if (adapter) {
      const value = await adapter.getSetting(key);
      return value ?? undefined;
    }
    const value = localStorage.getItem(`aegisid_db_${key}`);
    return value ?? undefined;
  } catch {
    return undefined;
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  try {
    if (adapter) {
      await adapter.setSetting(key, value);
      return;
    }
    localStorage.setItem(`aegisid_db_${key}`, value);
  } catch {
    // Storage full or unavailable — silently ignore
  }
}
