/**
 * Anchor Module
 *
 * Identity anchor registration and cross-device recovery
 * via Face LSH + PIN behavior LSH matching on VPS.
 */

export type {
  IdentityBlob,
  RegisterResult,
  LookupResult,
} from './identityAnchor';

export {
  registerIdentityAnchor,
  lookupIdentityAnchor,
  decryptAnchorBlob,
  setAnchorApiUrl,
} from './identityAnchor';
