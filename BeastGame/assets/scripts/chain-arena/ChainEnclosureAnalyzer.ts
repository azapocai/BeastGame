import { ChainPerformanceBudget } from './ChainPerformanceBudget';
import { Point2D } from './Math2D';

export interface ChainEnclosureTarget extends Point2D {
  radius: number;
}

export interface ChainEnclosureRecord<T extends ChainEnclosureTarget> {
  target: T;
  stableSteps: number;
  enclosed: boolean;
  pathFraction: number;
}

/**
 * Classifies targets inside the simple boundary formed by the guide and its
 * endpoint closure. The closure exists only for classification.
 */
export class ChainEnclosureAnalyzer<T extends ChainEnclosureTarget> {
  private readonly records = new Map<T, ChainEnclosureRecord<T>>();
  private readonly published: ChainEnclosureRecord<T>[] = [];

  get enclosed(): readonly ChainEnclosureRecord<T>[] {
    return this.published;
  }

  reset(): void {
    this.records.clear();
    this.published.length = 0;
  }

  update(points: readonly Point2D[], targets: readonly T[]): readonly ChainEnclosureRecord<T>[] {
    this.published.length = 0;
    if (points.length < 3 || !this.isSimpleBoundary(points)) {
      for (const record of this.records.values()) {
        record.stableSteps = 0;
        record.enclosed = false;
      }
      return this.published;
    }

    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    let top = Number.NEGATIVE_INFINITY;
    for (const point of points) {
      left = Math.min(left, point.x);
      right = Math.max(right, point.x);
      bottom = Math.min(bottom, point.y);
      top = Math.max(top, point.y);
    }
    const seen = new Set<T>();
    const limit = Math.min(targets.length, ChainPerformanceBudget.maxExactCandidates);
    for (let index = 0; index < limit; index += 1) {
      const target = targets[index];
      seen.add(target);
      let record = this.records.get(target);
      if (!record) {
        record = { target, stableSteps: 0, enclosed: false, pathFraction: 0 };
        this.records.set(target, record);
      }
      const inBounds = target.x >= left && target.x <= right
        && target.y >= bottom && target.y <= top;
      const inside = inBounds && this.pointInside(points, target.x, target.y);
      record.stableSteps = inside ? record.stableSteps + 1 : 0;
      record.enclosed = record.stableSteps >= ChainPerformanceBudget.enclosureStableSteps;
      if (record.enclosed) {
        record.pathFraction = this.nearestPathFraction(points, target);
        this.insertByPathOrder(record);
      }
    }
    for (const [target, record] of this.records) {
      if (seen.has(target)) continue;
      record.stableSteps = 0;
      record.enclosed = false;
      this.records.delete(target);
    }
    if (this.published.length > ChainPerformanceBudget.maxContacts) {
      this.published.length = ChainPerformanceBudget.maxContacts;
    }
    return this.published;
  }

  private insertByPathOrder(record: ChainEnclosureRecord<T>): void {
    let index = 0;
    while (index < this.published.length
      && this.published[index].pathFraction <= record.pathFraction) index += 1;
    this.published.splice(index, 0, record);
  }

  private pointInside(points: readonly Point2D[], x: number, y: number): boolean {
    let inside = false;
    for (let current = 0, previous = points.length - 1; current < points.length; previous = current, current += 1) {
      const a = points[current];
      const b = points[previous];
      const crosses = (a.y > y) !== (b.y > y)
        && x < (b.x - a.x) * (y - a.y) / ((b.y - a.y) || 1e-8) + a.x;
      if (crosses) inside = !inside;
    }
    return inside;
  }

  private isSimpleBoundary(points: readonly Point2D[]): boolean {
    const segmentCount = points.length;
    for (let first = 0; first < segmentCount; first += 1) {
      const a0 = points[first];
      const a1 = points[(first + 1) % points.length];
      for (let second = first + 1; second < segmentCount; second += 1) {
        if (second === first || second === first + 1) continue;
        if (first === 0 && second === segmentCount - 1) continue;
        const b0 = points[second];
        const b1 = points[(second + 1) % points.length];
        if (this.properIntersection(a0, a1, b0, b1)) return false;
      }
    }
    return true;
  }

  private properIntersection(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
    const abC = this.cross(a, b, c);
    const abD = this.cross(a, b, d);
    const cdA = this.cross(c, d, a);
    const cdB = this.cross(c, d, b);
    return abC * abD < -1e-6 && cdA * cdB < -1e-6;
  }

  private cross(a: Point2D, b: Point2D, c: Point2D): number {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  private nearestPathFraction(points: readonly Point2D[], target: Point2D): number {
    let total = 0;
    const cumulative: number[] = [0];
    for (let index = 0; index < points.length - 1; index += 1) {
      total += Math.hypot(points[index + 1].x - points[index].x, points[index + 1].y - points[index].y);
      cumulative[index + 1] = total;
    }
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestLength = 0;
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared > 0
        ? Math.max(0, Math.min(1, ((target.x - start.x) * dx + (target.y - start.y) * dy) / lengthSquared))
        : 0;
      const offsetX = target.x - (start.x + dx * t);
      const offsetY = target.y - (start.y + dy * t);
      const distance = offsetX * offsetX + offsetY * offsetY;
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      bestLength = cumulative[index] + Math.sqrt(lengthSquared) * t;
    }
    return total > 0.001 ? bestLength / total : 0;
  }
}
