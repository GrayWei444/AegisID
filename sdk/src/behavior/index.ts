/**
 * Behavior Fingerprint Module
 *
 * PIN input behavior analysis for emulator/bot detection
 * and same-person verification.
 */

export type {
  PinTouchData,
  PinKeypress,
  PinInputRawData,
  PinBehaviorFingerprint,
  MotionSensorData,
  EmulatorDetectionResult,
} from './behaviorFingerprint';

export {
  calculateFingerprint,
  detectEmulatorOrBot,
  formatFingerprintForDisplay,
  formatDetectionResultForDisplay,
} from './behaviorFingerprint';

export { usePinBehavior } from './usePinBehavior';
