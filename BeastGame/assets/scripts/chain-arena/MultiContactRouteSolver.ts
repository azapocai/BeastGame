import { CircleBody, ChainContactSolver, ContinuousCircleContact } from './ChainContactSolver';
import { Point2D } from './Math2D';
import { ChainPerformanceBudget } from './ChainPerformanceBudget';

export interface MultiRouteContact {
  topologyId: number;
  enemy: CircleBody;
  geometry: ContinuousCircleContact;
  outgoingTangentSign?: 1 | -1;
  outgoingNeighborId?: number;
}

export interface MultiRouteRange {
  topologyId: number;
  pointStart: number;
  pointEnd: number;
}

export interface MultiRouteResult {
  valid: boolean;
  points: Point2D[];
  ranges: MultiRouteRange[];
  bindings: MultiRouteBinding[];
}

export interface MultiRouteBinding {
  topologyId: number;
  geometry: ContinuousCircleContact;
  outgoingTangentSign?: 1 | -1;
  outgoingNeighborId?: number;
}

/**
 * Builds a bounded path through ordered circular contacts. Consecutive bodies
 * are joined by external common tangents; each stored contact keeps its own
 * continuous extra winding rather than being recomputed from array order.
 */
export class MultiContactRouteSolver {
  static readonly MAX_POINTS = ChainPerformanceBudget.maxRoutePoints;
  static readonly MAX_CONTACTS = ChainPerformanceBudget.maxContacts;
  private static readonly MAX_ARC_SEGMENTS = 20;
  private static readonly CLEARANCE_EPSILON = 0.55;

  static build(
    start: Point2D,
    end: Point2D,
    contacts: readonly MultiRouteContact[],
    padding: number,
  ): MultiRouteResult {
    if (contacts.length === 0) {
      return {
        valid: true,
        points: [{ x: start.x, y: start.y }, { x: end.x, y: end.y }],
        ranges: [],
        bindings: [],
      };
    }
    if (contacts.length > this.MAX_CONTACTS) return this.invalid();
    const edgeOptions: Array<Array<1 | -1>> = [];
    for (let index = 0; index < contacts.length - 1; index += 1) {
      const left = contacts[index];
      const right = contacts[index + 1];
      const locked = left.outgoingNeighborId === right.topologyId
        ? left.outgoingTangentSign
        : undefined;
      edgeOptions.push(locked ? [locked] : [-1, 1]);
    }
    let best: MultiRouteResult | null = null;
    const signs: Array<1 | -1> = [];
    const visit = (edge: number): void => {
      if (edge >= edgeOptions.length) {
        const candidate = this.buildForSigns(start, end, contacts, padding, signs);
        if (!candidate.valid) return;
        if (!best || this.pathLength(candidate.points) < this.pathLength(best.points) - 0.001) {
          best = candidate;
        }
        return;
      }
      for (const sign of edgeOptions[edge]) {
        signs[edge] = sign;
        visit(edge + 1);
      }
    };
    visit(0);
    return best || this.invalid();
  }

  private static buildForSigns(
    start: Point2D,
    end: Point2D,
    contacts: readonly MultiRouteContact[],
    padding: number,
    signs: readonly (1 | -1)[],
  ): MultiRouteResult {
    const entries: number[] = new Array(contacts.length);
    const exits: number[] = new Array(contacts.length);
    const first = contacts[0];
    const last = contacts[contacts.length - 1];
    entries[0] = ChainContactSolver.tangentAngleForSide(
      start,
      first.enemy,
      first.enemy.radius + padding,
      first.geometry.side,
    );
    exits[contacts.length - 1] = ChainContactSolver.tangentAngleForSide(
      end,
      last.enemy,
      last.enemy.radius + padding,
      last.geometry.side === 1 ? -1 : 1,
    );

    for (let index = 0; index < contacts.length - 1; index += 1) {
      const left = contacts[index];
      const right = contacts[index + 1];
      const tangent = this.commonTangent(left, right, padding, signs[index]);
      if (!tangent) return this.invalid();
      exits[index] = tangent.leftAngle;
      entries[index + 1] = tangent.rightAngle;
    }

    const solvedGeometries = contacts.map((contact) => this.cloneGeometry(contact.geometry));
    for (let index = 0; index < contacts.length; index += 1) {
      ChainContactSolver.rebindRouteTangents(solvedGeometries[index], entries[index], exits[index]);
    }

    const solvedContacts = contacts.map((contact, index) => ({
      ...contact,
      geometry: solvedGeometries[index],
    }));
    const segments = this.allocateArcSegments(solvedContacts);
    const points: Point2D[] = [{ x: start.x, y: start.y }];
    const ranges: MultiRouteRange[] = [];
    const segmentOwners: number[] = [];
    for (let index = 0; index < contacts.length; index += 1) {
      const contact = solvedContacts[index];
      const radius = contact.enemy.radius + padding;
      const pointStart = points.length;
      for (let step = 0; step <= segments[index]; step += 1) {
        const angle = contact.geometry.entryAngle + contact.geometry.sweep * step / segments[index];
        points.push({
          x: contact.enemy.x + Math.cos(angle) * radius,
          y: contact.enemy.y + Math.sin(angle) * radius,
        });
        segmentOwners.push(step === 0 ? -1 : index);
      }
      ranges.push({ topologyId: contact.topologyId, pointStart, pointEnd: points.length - 1 });
    }
    points.push({ x: end.x, y: end.y });
    segmentOwners.push(-1);
    return this.isFinite(points)
      && points.length <= this.MAX_POINTS
      && this.routeClearsContacts(points, segmentOwners, contacts, padding)
      ? {
        valid: true,
        points,
        ranges,
        bindings: contacts.map((contact, index) => ({
          topologyId: contact.topologyId,
          geometry: solvedGeometries[index],
          outgoingTangentSign: index < contacts.length - 1 ? signs[index] : undefined,
          outgoingNeighborId: index < contacts.length - 1
            ? contacts[index + 1].topologyId
            : undefined,
        })),
      }
      : this.invalid();
  }

  private static commonTangent(
    left: MultiRouteContact,
    right: MultiRouteContact,
    padding: number,
    sign: 1 | -1,
  ): { leftAngle: number; rightAngle: number; sign: 1 | -1 } | null {
    const leftRadius = left.enemy.radius + padding;
    const rightRadius = right.enemy.radius + padding;
    const dx = right.enemy.x - left.enemy.x;
    const dy = right.enemy.y - left.enemy.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= Math.abs(leftRadius - rightRadius) + 0.001) return null;
    const base = Math.atan2(dy, dx);
    const delta = Math.acos(Math.max(-1, Math.min(1, (leftRadius - rightRadius) / distance)));
    const angle = base + delta * sign;
    return { leftAngle: angle, rightAngle: angle, sign };
  }

  private static cloneGeometry(source: ContinuousCircleContact): ContinuousCircleContact {
    return {
      side: source.side,
      sideLocked: source.sideLocked,
      entryAngle: source.entryAngle,
      exitAngle: source.exitAngle,
      initialArc: source.initialArc,
      sweep: source.sweep,
      playerOrbitSweep: source.playerOrbitSweep,
    };
  }

  private static invalid(): MultiRouteResult {
    return {
      valid: false,
      points: [],
      ranges: [],
      bindings: [],
    };
  }

  private static allocateArcSegments(contacts: readonly MultiRouteContact[]): number[] {
    const segments = contacts.map((contact) => Math.max(
      3,
      Math.min(this.MAX_ARC_SEGMENTS, Math.ceil(Math.abs(contact.geometry.sweep) / (Math.PI / 16))),
    ));
    const limit = this.MAX_POINTS - contacts.length - 2;
    let total = segments.reduce((sum, count) => sum + count, 0);
    while (total > limit) {
      let largest = -1;
      for (let index = 0; index < segments.length; index += 1) {
        if (segments[index] > 3 && (largest < 0 || segments[index] > segments[largest])) largest = index;
      }
      if (largest < 0) break;
      segments[largest] -= 1;
      total -= 1;
    }
    return segments;
  }

  private static isFinite(points: readonly Point2D[]): boolean {
    return points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  }

  private static routeClearsContacts(
    points: readonly Point2D[],
    segmentOwners: readonly number[],
    contacts: readonly MultiRouteContact[],
    padding: number,
  ): boolean {
    for (let segment = 0; segment < points.length - 1; segment += 1) {
      const owner = segmentOwners[segment];
      for (let contactIndex = 0; contactIndex < contacts.length; contactIndex += 1) {
        if (contactIndex === owner) continue;
        const contact = contacts[contactIndex];
        const minimum = contact.enemy.radius + padding - this.CLEARANCE_EPSILON;
        if (this.distanceToSegment(contact.enemy, points[segment], points[segment + 1]) < minimum) {
          return false;
        }
      }
    }
    return true;
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

  private static pathLength(points: readonly Point2D[]): number {
    let length = 0;
    for (let index = 1; index < points.length; index += 1) {
      length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
    }
    return length;
  }
}
