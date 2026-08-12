import { ChainContactSolver, CircleBody, ContinuousCircleContact } from './ChainContactSolver';
import { ChainPerformanceBudget } from './ChainPerformanceBudget';
import { ChainRouteSolver } from './ChainRouteSolver';
import { Point2D } from './Math2D';

export interface ChainGuideContact<T extends CircleBody> {
  id: number;
  target: T;
  geometry: ContinuousCircleContact;
  pathFraction: number;
}

export interface ChainRefinedContactRange<T extends CircleBody> {
  id: number;
  target: T;
  pointStart: number;
  pointEnd: number;
  endLength: number;
}

export interface ChainRefinedRoute<T extends CircleBody> {
  points: Point2D[];
  ranges: ChainRefinedContactRange<T>[];
  totalLength: number;
}

interface ContactSpan<T extends CircleBody> {
  contact: ChainGuideContact<T>;
  startSegment: number;
  endSegment: number;
  pathFraction: number;
  distanceSquared: number;
}

/** Replaces only body-local guide spans with continuous analytic circle arcs. */
export class ChainAnalyticContactRefiner {
  static refine<T extends CircleBody>(
    guide: readonly Point2D[],
    contacts: readonly ChainGuideContact<T>[],
    padding: number,
  ): ChainRefinedRoute<T> {
    if (guide.length < 2 || contacts.length === 0) {
      const points = guide.map((point) => ({ x: point.x, y: point.y }));
      return { points, ranges: [], totalLength: ChainRouteSolver.pathLength(points) };
    }
    const spans: ContactSpan<T>[] = [];
    for (const contact of contacts) {
      const span = this.findContactSpan(guide, contact, padding);
      if (span) spans.push(span);
    }
    spans.sort((a, b) => a.startSegment - b.startSegment || a.pathFraction - b.pathFraction);
    const accepted: ContactSpan<T>[] = [];
    let previousEnd = -1;
    for (const span of spans) {
      if (span.startSegment <= previousEnd) continue;
      accepted.push(span);
      previousEnd = span.endSegment;
    }
    const result: Point2D[] = [];
    const ranges: ChainRefinedContactRange<T>[] = [];
    let guideIndex = 0;
    const sparePoints = Math.max(0, ChainPerformanceBudget.maxRoutePoints - guide.length);
    const arcBudget = accepted.length > 0 ? Math.max(3, Math.floor(sparePoints / accepted.length) + 2) : 3;
    for (const span of accepted) {
      while (guideIndex <= span.startSegment) {
        this.pushPoint(result, guide[guideIndex]);
        guideIndex += 1;
      }
      const body = span.contact.target;
      const radius = body.radius + padding;
      const upstream = guide[span.startSegment];
      const downstream = guide[span.endSegment + 1];
      const geometry = span.contact.geometry;
      const side = this.resolveSide(guide, span, body, geometry.side);
      geometry.side = side;
      const entryAngle = ChainContactSolver.tangentAngleForSide(upstream, body, radius, side);
      const exitAngle = ChainContactSolver.tangentAngleForSide(downstream, body, radius, side === 1 ? -1 : 1);
      ChainContactSolver.rebindRouteTangents(geometry, entryAngle, exitAngle);
      const guideSweep = this.guideSweep(guide, span, body, geometry.sweep);
      if (Math.abs(guideSweep) > Math.abs(geometry.sweep)
        && !geometry.sideLocked
        && ChainContactSolver.playerOrbitArc(geometry) > 0.001) {
        geometry.sweep = guideSweep;
        geometry.exitAngle = geometry.entryAngle + guideSweep;
      }
      const pointStart = result.length;
      const segments = Math.max(2, Math.min(
        arcBudget - 1,
        Math.ceil(Math.abs(geometry.sweep) / (Math.PI / 12)),
      ));
      for (let index = 0; index <= segments; index += 1) {
        const angle = geometry.entryAngle + geometry.sweep * index / segments;
        this.pushPoint(result, {
          x: body.x + Math.cos(angle) * radius,
          y: body.y + Math.sin(angle) * radius,
        });
      }
      const pointEnd = result.length - 1;
      ranges.push({
        id: span.contact.id,
        target: body,
        pointStart,
        pointEnd,
        endLength: 0,
      });
      span.contact.pathFraction = span.pathFraction;
      guideIndex = span.endSegment + 1;
    }
    while (guideIndex < guide.length) {
      this.pushPoint(result, guide[guideIndex]);
      guideIndex += 1;
    }
    if (result.length > ChainPerformanceBudget.maxRoutePoints) {
      this.downsample(result, ChainPerformanceBudget.maxRoutePoints);
      ranges.length = 0;
    }
    let totalLength = 0;
    let rangeIndex = 0;
    for (let index = 1; index < result.length; index += 1) {
      totalLength += Math.hypot(
        result[index].x - result[index - 1].x,
        result[index].y - result[index - 1].y,
      );
      while (rangeIndex < ranges.length && index >= ranges[rangeIndex].pointEnd) {
        ranges[rangeIndex].endLength = totalLength;
        rangeIndex += 1;
      }
    }
    return { points: result, ranges, totalLength };
  }

  static nearestPathFraction(points: readonly Point2D[], body: CircleBody): number {
    let total = 0;
    const lengths: number[] = [0];
    for (let index = 0; index < points.length - 1; index += 1) {
      total += Math.hypot(points[index + 1].x - points[index].x, points[index + 1].y - points[index].y);
      lengths[index + 1] = total;
    }
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestLength = 0;
    for (let index = 0; index < points.length - 1; index += 1) {
      const projection = this.segmentProjection(points[index], points[index + 1], body);
      if (projection.distanceSquared >= bestDistance) continue;
      bestDistance = projection.distanceSquared;
      bestLength = lengths[index] + (lengths[index + 1] - lengths[index]) * projection.t;
    }
    return total > 0.001 ? bestLength / total : 0;
  }

  static touchesBody(points: readonly Point2D[], body: CircleBody, padding: number, tolerance = 1): boolean {
    const threshold = body.radius + padding + tolerance;
    const thresholdSquared = threshold * threshold;
    for (let index = 0; index < points.length - 1; index += 1) {
      if (this.segmentProjection(points[index], points[index + 1], body).distanceSquared <= thresholdSquared) return true;
    }
    return false;
  }

  private static findContactSpan<T extends CircleBody>(
    guide: readonly Point2D[],
    contact: ChainGuideContact<T>,
    padding: number,
  ): ContactSpan<T> | null {
    const threshold = contact.target.radius + padding + 1.5;
    const thresholdSquared = threshold * threshold;
    const candidates: Array<{ index: number; distanceSquared: number; fraction: number }> = [];
    for (let index = 0; index < guide.length - 1; index += 1) {
      const projection = this.segmentProjection(guide[index], guide[index + 1], contact.target);
      if (projection.distanceSquared > thresholdSquared) continue;
      candidates.push({
        index,
        distanceSquared: projection.distanceSquared,
        fraction: (index + projection.t) / (guide.length - 1),
      });
    }
    if (candidates.length === 0) return null;
    let selected = candidates[0];
    let bestScore = Math.abs(selected.fraction - contact.pathFraction);
    for (let index = 1; index < candidates.length; index += 1) {
      const score = Math.abs(candidates[index].fraction - contact.pathFraction);
      if (score < bestScore) {
        selected = candidates[index];
        bestScore = score;
      }
    }
    let startSegment = selected.index;
    let endSegment = selected.index;
    while (candidates.some((candidate) => candidate.index === startSegment - 1)) startSegment -= 1;
    while (candidates.some((candidate) => candidate.index === endSegment + 1)) endSegment += 1;
    return {
      contact,
      startSegment,
      endSegment,
      pathFraction: selected.fraction,
      distanceSquared: selected.distanceSquared,
    };
  }

  private static resolveSide<T extends CircleBody>(
    guide: readonly Point2D[],
    span: ContactSpan<T>,
    body: CircleBody,
    fallback: 1 | -1,
  ): 1 | -1 {
    if (span.contact.geometry.sideLocked) return fallback;
    const start = guide[span.startSegment];
    const end = guide[span.endSegment + 1];
    const cross = (start.x - body.x) * (end.y - body.y)
      - (start.y - body.y) * (end.x - body.x);
    if (Math.abs(cross) <= 0.001) return fallback;
    return cross > 0 ? 1 : -1;
  }

  private static guideSweep<T extends CircleBody>(
    guide: readonly Point2D[],
    span: ContactSpan<T>,
    body: CircleBody,
    fallbackSweep: number,
  ): number {
    let previous = Math.atan2(
      guide[span.startSegment].y - body.y,
      guide[span.startSegment].x - body.x,
    );
    let sweep = 0;
    for (let index = span.startSegment + 1; index <= span.endSegment + 1; index += 1) {
      let angle = Math.atan2(guide[index].y - body.y, guide[index].x - body.x);
      while (angle - previous > Math.PI) angle -= Math.PI * 2;
      while (angle - previous < -Math.PI) angle += Math.PI * 2;
      sweep += angle - previous;
      previous = angle;
    }
    if (Math.abs(sweep) < 0.01 || Math.sign(sweep) !== Math.sign(fallbackSweep)) return fallbackSweep;
    return sweep;
  }

  private static segmentProjection(start: Point2D, end: Point2D, point: Point2D): { t: number; distanceSquared: number } {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0
      ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
      : 0;
    const offsetX = point.x - (start.x + dx * t);
    const offsetY = point.y - (start.y + dy * t);
    return { t, distanceSquared: offsetX * offsetX + offsetY * offsetY };
  }

  private static pushPoint(target: Point2D[], source: Point2D): void {
    const previous = target[target.length - 1];
    if (previous && Math.hypot(previous.x - source.x, previous.y - source.y) <= 0.01) return;
    target.push({ x: source.x, y: source.y });
  }

  private static downsample(points: Point2D[], maximum: number): void {
    const source = points.slice();
    points.length = maximum;
    for (let index = 0; index < maximum; index += 1) {
      const sourceIndex = Math.round(index * (source.length - 1) / (maximum - 1));
      points[index] = source[sourceIndex];
    }
  }
}
