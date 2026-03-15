/**
 * Database abstraction stub for AegisID SDK
 *
 * When consumed by AegisTalk, the host app injects the real database service.
 * This stub provides the minimal interface needed by face/storage.ts
 * using localStorage as a fallback.
 */

/**
 * Get a setting value from persistent storage
 */
export async function getSetting(key: string): Promise<string | undefined> {
  try {
    const value = localStorage.getItem(`aegisid_db_${key}`);
    return value ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Set a setting value in persistent storage
 */
export async function setSetting(key: string, value: string): Promise<void> {
  try {
    localStorage.setItem(`aegisid_db_${key}`, value);
  } catch {
    // Storage full or unavailable — silently ignore
  }
}
