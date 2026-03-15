/**
 * Ambient type declarations for Vite/bundler environment variables
 *
 * These are provided by Vite at build time. When used outside Vite,
 * the bundler or host app is responsible for providing these values.
 */

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly VITE_API_URL?: string;
  readonly VITE_SKIP_DEVICE_CHECK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
