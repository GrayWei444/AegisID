/**
 * Development logging utilities
 *
 * Thin wrapper around console for SDK debugging.
 * In production builds, these are typically stripped by tree-shaking
 * or replaced with a proper logging framework.
 */

/**
 * Detect dev mode via Vite's import.meta.env or default to true.
 * Using a function avoids issues with import.meta not being defined
 * in non-Vite environments.
 */
function detectDevMode(): boolean {
  try {
    return !import.meta.env.PROD;
  } catch {
    return true;
  }
}

const IS_DEV = detectDevMode();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogArgs = unknown[];

/**
 * Development-only log (stripped in production builds)
 */
export function devLog(...args: LogArgs): void {
  if (IS_DEV) {
    console.log('[AegisID]', ...args);
  }
}

/**
 * Development-only warning (stripped in production builds)
 */
export function devWarn(...args: LogArgs): void {
  if (IS_DEV) {
    console.warn('[AegisID]', ...args);
  }
}
