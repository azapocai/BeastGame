import { Point2D } from './Math2D';

export interface SweepCircle extends Point2D {
  radius: number;
}

export interface ChainSweepBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  moving: boolean;
}

/** Pure continuous collision query for a polyline moving between two poses. */
export class ChainSweepHitDetector {
  private static readonly MOTION_EPSILON_SQUARED = 0.04;

  static prepareSweep(
    previous: readonly Point2D[],
    current: readonly Point2D[],
    segmentBounds: ChainSweepBounds[],
    overallBounds: ChainSweepBounds,
  ): number {
    const segmentCount = Math.max(0, Math.min(previous.length, current.length) - 1);
    overallBounds.minX = Number.POSITIVE_INFINITY;
    overallBounds.minY = Number.POSITIVE_INFINITY;
    overallBounds.maxX = Number.NEGATIVE_INFINITY;
    overallBounds.maxY = Number.NEGATIVE_INFINITY;
    overallBounds.moving = false;
    segmentBounds.length = segmentCount;
    for (let index = 0; index < segmentCount; index += 1) {
      const oldStart = previous[index];
      const oldEnd = previous[index + 1];
      const newStart = current[index];
      const newEnd = current[index + 1];
      const bounds = segmentBounds[index] || {
        minX: 0, minY: 0, maxX: 0, maxY: 0, moving: false,
      };
      bounds.minX = Math.min(oldStart.x, oldEnd.x, newStart.x, newEnd.x);
      bounds.minY = Math.min(oldStart.y, oldEnd.y, newStart.y, newEnd.y);
      bounds.maxX = Math.max(oldStart.x, oldEnd.x, newStart.x, newEnd.x);
      bounds.maxY = Math.max(oldStart.y, oldEnd.y, newStart.y, newEnd.y);
      const startMotionX = newStart.x - oldStart.x;
      const startMotionY = newStart.y - oldStart.y;
      const endMotionX = newEnd.x - oldEnd.x;
      const endMotionY = newEnd.y - oldEnd.y;
      bounds.moving = startMotionX * startMotionX + startMotionY * startMotionY
        + endMotionX * endMotionX + endMotionY * endMotionY
        > this.MOTION_EPSILON_SQUARED;
      segmentBounds[index] = bounds;
      overallBounds.minX = Math.min(overallBounds.minX, bounds.minX);
      overallBounds.minY = Math.min(overallBounds.minY, bounds.minY);
      overallBounds.maxX = Math.max(overallBounds.maxX, bounds.maxX);
      overallBounds.maxY = Math.max(overallBounds.maxY, bounds.maxY);
      overallBounds.moving = overallBounds.moving || bounds.moving;
    }
    if (segmentCount === 0) {
      overallBounds.minX = 0;
      overallBounds.minY = 0;
      overallBounds.maxX = 0;
      overallBounds.maxY = 0;
    }
    return segmentCount;
  }

  static circleOverlapsBounds(circle: SweepCircle, bounds: ChainSweepBounds, padding = 0): boolean {
    const radius = Math.max(0, circle.radius + padding);
    return circle.x + radius >= bounds.minX
      && circle.x - radius <= bounds.maxX
      && circle.y + radius >= bounds.minY
      && circle.y - radius <= bounds.maxY;
  }

  static hitsMovingPolyline(
    previous: readonly Point2D[],
    current: readonly Point2D[],
    circle: SweepCircle,
    padding = 0,
  ): boolean {
    const segmentBounds: ChainSweepBounds[] = [];
    const overallBounds: ChainSweepBounds = {
      minX: 0, minY: 0, maxX: 0, maxY: 0, moving: false,
    };
    const segmentCount = this.prepareSweep(previous, current, segmentBounds, overallBounds);
    if (!this.circleOverlapsBounds(circle, overallBounds, padding)) return false;
    return this.hitsPreparedSweep(previous, current, segmentBounds, segmentCount, circle, padding);
  }

  static hitsPreparedSweep(
    previous: readonly Point2D[],
    current: readonly Point2D[],
    segmentBounds: readonly ChainSweepBounds[],
    segmentCount: number,
    circle: SweepCircle,
    padding = 0,
  ): boolean {
    const radius = Math.max(0, circle.radius + padding);
    const radiusSquared = radius * radius;
    for (let index = 0; index < segmentCount; index += 1) {
      const bounds = segmentBounds[index];
      if (!this.circleOverlapsBounds(circle, bounds, padding)) continue;
      const oldStart = previous[index];
      const oldEnd = previous[index + 1];
      const newStart = current[index];
      const newEnd = current[index + 1];
      if (!bounds.moving) {
        if (this.distanceSquaredToSegment(circle, newStart, newEnd) <= radiusSquared) return true;
        continue;
      }
      if (this.pointInTriangle(circle, oldStart, oldEnd, newEnd)
        || this.pointInTriangle(circle, oldStart, newEnd, newStart)
        || this.distanceSquaredToSegment(circle, oldStart, oldEnd) <= radiusSquared
        || this.distanceSquaredToSegment(circle, oldEnd, newEnd) <= radiusSquared
        || this.distanceSquaredToSegment(circle, newEnd, newStart) <= radiusSquared
        || this.distanceSquaredToSegment(circle, newStart, oldStart) <= radiusSquared) return true;
    }
    return false;
  }

  private static pointInTriangle(point: Point2D, a: Point2D, b: Point2D, c: Point2D): boolean {
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(area) <= 0.0001) return false;
    const first = this.cross(point, a, b);
    const second = this.cross(point, b, c);
    const third = this.cross(point, c, a);
    const hasNegative = first < -0.0001 || second < -0.0001 || third < -0.0001;
    const hasPositive = first > 0.0001 || second > 0.0001 || third > 0.0001;
    return !(hasNegative && hasPositive);
  }

  private static cross(point: Point2D, start: Point2D, end: Point2D): number {
    return (point.x - end.x) * (start.y - end.y) - (start.x - end.x) * (point.y - end.y);
  }

  private static distanceSquaredToSegment(point: Point2D, start: Point2D, end: Point2D): number {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0.0001
      ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
      : 0;
    const offsetX = point.x - (start.x + dx * t);
    const offsetY = point.y - (start.y + dy * t);
    return offsetX * offsetX + offsetY * offsetY;
  }
}
