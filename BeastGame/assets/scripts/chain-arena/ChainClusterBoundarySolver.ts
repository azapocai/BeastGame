import { CircleBody } from './ChainContactSolver';
import { Point2D } from './Math2D';

export interface ClusterBoundaryMember {
  topologyId: number;
  enemy: CircleBody;
}

export interface ClusterBoundaryRange {
  topologyId: number;
  pointStart: number;
  pointEnd: number;
}

export interface ClusterBoundaryResult {
  valid: boolean;
  points: Point2D[];
  ranges: ClusterBoundaryRange[];
  direction: 1 | -1;
  contactLength: number;
  perimeter: number;
  equivalentContactAngle: number;
}

interface RouteCandidate {
  points: Point2D[];
  direction: 1 | -1;
  contactLength: number;
  totalLength: number;
}

/**
 * Builds a rope path on the convex outer boundary of up to three padded
 * circles. Unlike a single enclosing circle, exposed body arcs and tangent-like
 * hull edges remain close to the bodies and endpoints may safely sit inside
 * the hull as long as they are not inside a physical contact circle.
 */
export class ChainClusterBoundarySolver {
  static readonly MAX_POINTS = 64;
  private static readonly SAMPLES_PER_BODY = 16;
  private static readonly SAMPLE_CLEARANCE = 1.0;
  private static readonly COLLISION_EPSILON = 0.45;

  static build(
    start: Point2D,
    end: Point2D,
    members: readonly ClusterBoundaryMember[],
    padding: number,
    preferredDirection: 1 | -1 | null = null,
  ): ClusterBoundaryResult {
    if (members.length < 2 || members.length > 3) return this.invalid();
    if (this.pointInsideAnyBody(start, members, padding)
      || this.pointInsideAnyBody(end, members, padding)) return this.invalid();

    const hull = this.buildHull(members, padding);
    if (hull.length < 3 || hull.length + 2 > this.MAX_POINTS) return this.invalid();
    const perimeter = this.closedLength(hull);
    let best = this.findBestRoute(start, end, hull, members, padding, preferredDirection);
    // A locked branch may become impossible after a real topology change. Only
    // then may the solver select the other boundary direction.
    if (!best && preferredDirection) {
      best = this.findBestRoute(start, end, hull, members, padding, null);
    }
    if (!best) return this.invalid();

    const meanRadius = members.reduce(
      (sum, member) => sum + member.enemy.radius + padding,
      0,
    ) / members.length;
    return {
      valid: true,
      points: best.points,
      ranges: members.map((member) => ({
        topologyId: member.topologyId,
        pointStart: 1,
        pointEnd: best!.points.length - 2,
      })),
      direction: best.direction,
      contactLength: best.contactLength,
      perimeter,
      // Capture baseline is intentionally capped at a half-turn. Extra wrap is
      // gameplay state accumulated only from player motion after capture.
      equivalentContactAngle: Math.min(Math.PI, best.contactLength / Math.max(8, meanRadius)),
    };
  }

  static centerOf(members: readonly ClusterBoundaryMember[]): Point2D {
    let x = 0;
    let y = 0;
    for (const member of members) {
      x += member.enemy.x;
      y += member.enemy.y;
    }
    const count = Math.max(1, members.length);
    return { x: x / count, y: y / count };
  }

  private static findBestRoute(
    start: Point2D,
    end: Point2D,
    hull: readonly Point2D[],
    members: readonly ClusterBoundaryMember[],
    padding: number,
    preferredDirection: 1 | -1 | null,
  ): RouteCandidate | null {
    const startVertices = this.visibleVertices(start, hull, members, padding);
    const endVertices = this.visibleVertices(end, hull, members, padding);
    if (startVertices.length === 0 || endVertices.length === 0) return null;
    let best: RouteCandidate | null = null;
    const directions: Array<1 | -1> = preferredDirection ? [preferredDirection] : [1, -1];
    for (const entry of startVertices) {
      for (const exit of endVertices) {
        for (const direction of directions) {
          const candidate = this.buildCandidate(start, end, hull, entry, exit, direction);
          if (!this.routeClearsBodies(candidate.points, members, padding)) continue;
          if (!best || candidate.totalLength < best.totalLength - 0.001
            || (Math.abs(candidate.totalLength - best.totalLength) <= 0.001
              && candidate.direction > best.direction)) {
            best = candidate;
          }
        }
      }
    }
    return best;
  }

  private static buildCandidate(
    start: Point2D,
    end: Point2D,
    hull: readonly Point2D[],
    entry: number,
    exit: number,
    direction: 1 | -1,
  ): RouteCandidate {
    const points: Point2D[] = [{ x: start.x, y: start.y }];
    let contactLength = 0;
    let index = entry;
    points.push({ x: hull[index].x, y: hull[index].y });
    let guard = 0;
    while (index !== exit && guard < hull.length) {
      const next = (index + direction + hull.length) % hull.length;
      contactLength += Math.hypot(hull[next].x - hull[index].x, hull[next].y - hull[index].y);
      index = next;
      points.push({ x: hull[index].x, y: hull[index].y });
      guard += 1;
    }
    points.push({ x: end.x, y: end.y });
    let totalLength = 0;
    for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
      totalLength += Math.hypot(
        points[pointIndex].x - points[pointIndex - 1].x,
        points[pointIndex].y - points[pointIndex - 1].y,
      );
    }
    return { points, direction, contactLength, totalLength };
  }

  private static visibleVertices(
    endpoint: Point2D,
    hull: readonly Point2D[],
    members: readonly ClusterBoundaryMember[],
    padding: number,
  ): number[] {
    const visible: boolean[] = new Array(hull.length).fill(false);
    let closest = -1;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < hull.length; index += 1) {
      if (!this.segmentClearsBodies(endpoint, hull[index], members, padding)) continue;
      visible[index] = true;
      const distance = Math.hypot(hull[index].x - endpoint.x, hull[index].y - endpoint.y);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = index;
      }
    }
    const result: number[] = [];
    for (let index = 0; index < hull.length; index += 1) {
      if (!visible[index]) continue;
      const previous = visible[(index - 1 + hull.length) % hull.length];
      const next = visible[(index + 1) % hull.length];
      if (!previous || !next) result.push(index);
    }
    if (closest >= 0 && result.indexOf(closest) < 0) result.push(closest);
    // Numerical gaps can produce several visibility islands for an endpoint
    // inside the hull. Keep a strict bound on candidate combinations.
    if (result.length > 6) {
      result.sort((a, b) => Math.hypot(
        hull[a].x - endpoint.x,
        hull[a].y - endpoint.y,
      ) - Math.hypot(
        hull[b].x - endpoint.x,
        hull[b].y - endpoint.y,
      ));
      result.length = 6;
    }
    return result;
  }

  private static routeClearsBodies(
    points: readonly Point2D[],
    members: readonly ClusterBoundaryMember[],
    padding: number,
  ): boolean {
    if (points.length < 3 || points.length > this.MAX_POINTS) return false;
    for (let index = 0; index < points.length - 1; index += 1) {
      if (!this.segmentClearsBodies(points[index], points[index + 1], members, padding)) return false;
    }
    return points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  }

  private static segmentClearsBodies(
    start: Point2D,
    end: Point2D,
    members: readonly ClusterBoundaryMember[],
    padding: number,
  ): boolean {
    for (const member of members) {
      const minimum = member.enemy.radius + padding - this.COLLISION_EPSILON;
      if (this.distanceToSegment(member.enemy, start, end) < minimum) return false;
    }
    return true;
  }

  private static pointInsideAnyBody(
    point: Point2D,
    members: readonly ClusterBoundaryMember[],
    padding: number,
  ): boolean {
    return members.some((member) => Math.hypot(
      point.x - member.enemy.x,
      point.y - member.enemy.y,
    ) < member.enemy.radius + padding - this.COLLISION_EPSILON);
  }

  private static buildHull(
    members: readonly ClusterBoundaryMember[],
    padding: number,
  ): Point2D[] {
    const samples: Point2D[] = [];
    for (const member of members) {
      const radius = member.enemy.radius + padding + this.SAMPLE_CLEARANCE;
      for (let step = 0; step < this.SAMPLES_PER_BODY; step += 1) {
        const angle = step / this.SAMPLES_PER_BODY * Math.PI * 2;
        samples.push({
          x: member.enemy.x + Math.cos(angle) * radius,
          y: member.enemy.y + Math.sin(angle) * radius,
        });
      }
    }
    samples.sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);
    const lower: Point2D[] = [];
    for (const point of samples) {
      while (lower.length >= 2 && this.cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
        lower.pop();
      }
      lower.push(point);
    }
    const upper: Point2D[] = [];
    for (let index = samples.length - 1; index >= 0; index -= 1) {
      const point = samples[index];
      while (upper.length >= 2 && this.cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
        upper.pop();
      }
      upper.push(point);
    }
    lower.pop();
    upper.pop();
    const hull = lower.concat(upper);
    if (hull.length * 2 + 2 > this.MAX_POINTS) return hull;
    const withEdgeMidpoints: Point2D[] = [];
    for (let index = 0; index < hull.length; index += 1) {
      const point = hull[index];
      const next = hull[(index + 1) % hull.length];
      withEdgeMidpoints.push(point, {
        x: (point.x + next.x) * 0.5,
        y: (point.y + next.y) * 0.5,
      });
    }
    return withEdgeMidpoints;
  }

  private static distanceToSegment(point: Point2D, start: Point2D, end: Point2D): number {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0
      ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
      : 0;
    return Math.hypot(
      point.x - (start.x + dx * t),
      point.y - (start.y + dy * t),
    );
  }

  private static closedLength(points: readonly Point2D[]): number {
    let length = 0;
    for (let index = 0; index < points.length; index += 1) {
      const next = points[(index + 1) % points.length];
      length += Math.hypot(next.x - points[index].x, next.y - points[index].y);
    }
    return length;
  }

  private static cross(origin: Point2D, a: Point2D, b: Point2D): number {
    return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  }

  private static invalid(): ClusterBoundaryResult {
    return {
      valid: false,
      points: [],
      ranges: [],
      direction: 1,
      contactLength: 0,
      perimeter: 0,
      equivalentContactAngle: 0,
    };
  }
}
