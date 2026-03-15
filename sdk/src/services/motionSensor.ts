/**
 * Motion sensor data collector stub for AegisID SDK
 *
 * Collects accelerometer data during PIN input for behavior fingerprinting.
 * Uses the DeviceMotion API when available.
 */

interface MotionSummary {
  accelerometerMagnitude: number;
  sampleCount: number;
  hasData: boolean;
}

/**
 * Collects device motion sensor data during PIN input
 */
export class MotionCollector {
  private samples: number[] = [];
  private listener: ((e: DeviceMotionEvent) => void) | null = null;

  /**
   * Start collecting motion data
   */
  async start(): Promise<void> {
    this.samples = [];

    if (typeof DeviceMotionEvent === 'undefined') {
      return;
    }

    this.listener = (event: DeviceMotionEvent) => {
      const acc = event.accelerationIncludingGravity;
      if (acc && acc.x != null && acc.y != null && acc.z != null) {
        const magnitude = Math.sqrt(acc.x ** 2 + acc.y ** 2 + acc.z ** 2);
        this.samples.push(magnitude);
      }
    };

    window.addEventListener('devicemotion', this.listener);
  }

  /**
   * Stop collecting motion data
   */
  stop(): void {
    if (this.listener) {
      window.removeEventListener('devicemotion', this.listener);
      this.listener = null;
    }
  }

  /**
   * Get summary of collected motion data
   */
  getSummary(): MotionSummary {
    if (this.samples.length === 0) {
      return { accelerometerMagnitude: 0, sampleCount: 0, hasData: false };
    }

    const sum = this.samples.reduce((a, b) => a + b, 0);
    const avg = sum / this.samples.length;

    return {
      accelerometerMagnitude: avg,
      sampleCount: this.samples.length,
      hasData: true,
    };
  }

  /**
   * Reset all collected data
   */
  reset(): void {
    this.stop();
    this.samples = [];
  }
}
