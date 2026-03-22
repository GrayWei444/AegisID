/**
 * Anti-Abuse Module
 *
 * Same-source detection (IP-based bulk registration prevention)
 * and device fingerprint risk assessment.
 */

export type {
  SameSourceCheckResult,
  SameSourceStats,
} from './sameSourceCheck';

export {
  checkSameSource,
  getSameSourceStats,
  setSameSourceApiUrl,
  setSameSourceSkipCheck,
} from './sameSourceCheck';
