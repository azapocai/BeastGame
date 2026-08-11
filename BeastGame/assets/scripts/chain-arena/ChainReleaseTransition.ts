import { Math2D, Point2D } from './Math2D';

type ActiveRouteMode = 'idle' | 'release' | 'contact-handoff';

/**
 * Owns the temporary, gameplay-visible rope route between stable contact
 * states. During release it is the authoritative collision path. When that
 * path catches a new body, contact-handoff preserves the hit-frame polyline
 * while continuously converging on the new circle-contact route.
 */
export class ChainReleaseTransition {
  private static readonly RELEASE_DURATION = 0.24;
  private static readonly HANDOFF_DURATION = 0.12;
  private static readonly SAMPLE_COUNT = 26;

  private source: Point2D[] = [];
  private elapsed = 0;
  private mode: ActiveRouteMode = 'idle';
  private contactFraction = 0.5;

  get active(): boolean {
    return this.mode !== 'idle' && this.source.length >= 2 && this.elapsed < this.duration;
  }

  get collisionActive(): boolean {
    return this.active && this.mode === 'release';
  }

  get handoffActive(): boolean {
    return this.active && this.mode === 'contact-handoff';
  }

  get progress(): number {
    return this.active
      ? Math2D.clamp(this.elapsed / this.duration, 0, 1)
      : 1;
  }

  private get duration(): number {
    return this.mode === 'contact-handoff'
      ? ChainReleaseTransition.HANDOFF_DURATION
      : ChainReleaseTransition.RELEASE_DURATION;
  }

  reset(): void {
    this.source = [];
    this.elapsed = 0;
    this.mode = 'idle';
    this.contactFraction = 0.5;
  }

  /** Backward-compatible release entry point used by the snare facade/tests. */
  begin(route: Point2D[]): void {
    this.beginRelease(route);
  }

  beginRelease(route: Point2D[]): void {
    if (route.length < 3) {
      this.reset();
      return;
    }
    this.source = this.resample(route, ChainReleaseTransition.SAMPLE_COUNT);
    this.elapsed = 0;
    this.mode = 'release';
  }

  beginContactHandoff(route: Point2D[], contactFraction: number): void {
    if (route.length < 2) {
      this.reset();
      return;
    }
    this.source = this.resample(route, ChainReleaseTransition.SAMPLE_COUNT);
    this.elapsed = 0;
    this.mode = 'contact-handoff';
    this.contactFraction = Math2D.clamp(contactFraction, 0, 1);
  }

  update(dt: number): void {
    if (!this.active) return;
    this.elapsed += dt;
    if (this.elapsed >= this.duration) this.reset();
  }

  build(livePoints: Point2D[], targetPoints: Point2D[] = livePoints): Point2D[] {
    if (!this.active || livePoints.length < 2) {
      return targetPoints.map((point) => ({ x: point.x, y: point.y }));
    }
    const liveStart = livePoints[0];
    const liveEnd = livePoints[livePoints.length - 1];
    const capturedStart = this.source[0];
    const capturedEnd = this.source[this.source.length - 1];
    const startDelta = { x: liveStart.x - capturedStart.x, y: liveStart.y - capturedStart.y };
    const endDelta = { x: liveEnd.x - capturedEnd.x, y: liveEnd.y - capturedEnd.y };
    const globalProgress = Math2D.clamp(this.elapsed / this.duration, 0, 1);
    const target = this.resample(targetPoints, this.source.length);

    const result = this.source.map((point, index) => {
      const fraction = index / (this.source.length - 1);
      const localProgress = this.mode === 'release'
        // The anchor side starts straightening first, so release travels
        // through the old body contact and finishes at the player side.
        ? Math2D.clamp(globalProgress * 1.25 - (1 - fraction) * 0.25, 0, 1)
        // A new contact takes ownership at the actual hit region, then the
        // topology correction spreads toward both tether endpoints.
        : Math2D.clamp(globalProgress * 1.2 - Math.abs(fraction - this.contactFraction) * 0.2, 0, 1);
      const eased = 1 - Math.pow(1 - localProgress, 3);
      const movingSource = {
        x: point.x + startDelta.x * (1 - fraction) + endDelta.x * fraction,
        y: point.y + startDelta.y * (1 - fraction) + endDelta.y * fraction,
      };
      return {
        x: movingSource.x + (target[index].x - movingSource.x) * eased,
        y: movingSource.y + (target[index].y - movingSource.y) * eased,
      };
    });
    result[0] = { x: liveStart.x, y: liveStart.y };
    result[result.length - 1] = { x: liveEnd.x, y: liveEnd.y };
    return result;
  }

  private resample(points: Point2D[], count: number): Point2D[] {
    const cumulative: number[] = [0];
    for (let index = 1; index < points.length; index += 1) {
      cumulative.push(cumulative[index - 1] + Math.hypot(
        points[index].x - points[index - 1].x,
        points[index].y - points[index - 1].y,
      ));
    }
    const totalLength = cumulative[cumulative.length - 1];
    if (totalLength <= 0.001) return points.map((point) => ({ x: point.x, y: point.y }));

    const result: Point2D[] = [];
    let segment = 0;
    for (let index = 0; index < count; index += 1) {
      const targetLength = totalLength * index / (count - 1);
      while (segment < points.length - 2 && cumulative[segment + 1] < targetLength) segment += 1;
      const segmentLength = Math.max(0.0001, cumulative[segment + 1] - cumulative[segment]);
      const t = Math2D.clamp((targetLength - cumulative[segment]) / segmentLength, 0, 1);
      result.push({
        x: points[segment].x + (points[segment + 1].x - points[segment].x) * t,
        y: points[segment].y + (points[segment + 1].y - points[segment].y) * t,
      });
    }
    return result;
  }
}
