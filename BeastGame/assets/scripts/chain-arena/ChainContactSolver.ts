import { Math2D, Point2D } from './Math2D';

export interface CircleBody {
  x: number;
  y: number;
  radius: number;
}

export interface PathIntersection {
  segmentIndex: number;
  entryT: number;
  exitT: number;
  entryAngle: number;
  exitAngle: number;
}

interface SegmentIntersection {
  entryT: number;
  exitT: number;
  entryAngle: number;
  exitAngle: number;
}

/**
 * A single continuous rope contact around a circular body.
 *
 * `sweep` is the actual signed arc drawn by the rope. It is deliberately not
 * normalized to [-PI, PI], so endpoint motion can grow it beyond one turn
 * without a topology jump.
 */
export interface ContinuousCircleContact {
  side: 1 | -1;
  sideLocked: boolean;
  entryAngle: number;
  exitAngle: number;
  initialArc: number;
  sweep: number;
}

interface SolvedContact {
  entryAngle: number;
  exitAngle: number;
  sweep: number;
}

/** Pure geometry/topology solver; it has no gameplay or Cocos dependencies. */
export class ChainContactSolver {
  private static readonly MOTION_EPSILON = 0.0005;
  private static readonly RELEASE_EPSILON = 0.002;

  static create(
    player: Point2D,
    anchor: Point2D,
    body: CircleBody,
    padding: number,
    playerMotion: Point2D | null,
  ): ContinuousCircleContact | null {
    const radius = body.radius + padding;
    if (Math.hypot(player.x - body.x, player.y - body.y) <= radius
      || Math.hypot(anchor.x - body.x, anchor.y - body.y) <= radius) return null;

    const motionDirection = this.playerAngularDirection(player, playerMotion, body);
    let side: 1 | -1;
    let sideLocked = motionDirection !== 0;
    if (sideLocked) {
      side = motionDirection > 0 ? -1 : 1;
    } else {
      const positive = this.solve(player, anchor, body, radius, 1);
      const negative = this.solve(player, anchor, body, radius, -1);
      side = Math.abs(positive.sweep) <= Math.abs(negative.sweep) ? 1 : -1;
    }
    const solved = this.solve(player, anchor, body, radius, side);
    return {
      side,
      sideLocked,
      entryAngle: solved.entryAngle,
      exitAngle: solved.exitAngle,
      initialArc: Math.abs(solved.sweep),
      sweep: solved.sweep,
    };
  }

  /**
   * Advances the continuous contact. Returns false only when the rope has
   * completely unwound and the free segment no longer intersects the body.
   */
  static update(
    contact: ContinuousCircleContact,
    player: Point2D,
    anchor: Point2D,
    body: CircleBody,
    padding: number,
    playerMotion: Point2D | null,
  ): boolean {
    const radius = body.radius + padding;
    if (!contact.sideLocked) {
      const motionDirection = this.playerAngularDirection(player, playerMotion, body);
      if (motionDirection !== 0) {
        const previousPlayer = playerMotion
          ? { x: player.x - playerMotion.x, y: player.y - playerMotion.y }
          : player;
        contact.side = motionDirection > 0 ? -1 : 1;
        contact.sideLocked = true;
        const previous = this.solve(previousPlayer, anchor, body, radius, contact.side);
        contact.entryAngle = previous.entryAngle;
        contact.exitAngle = previous.exitAngle;
        contact.sweep = previous.sweep;
        contact.initialArc = Math.abs(previous.sweep);
      }
    }

    this.refresh(contact, player, anchor, body, padding);
    const directlyTouching = this.segmentIntersectsCircle(player, anchor, body, radius);
    if (!contact.sideLocked) return directlyTouching;
    return this.windingArc(contact) > ChainContactSolver.RELEASE_EPSILON || directlyTouching;
  }

  /** Re-solves tangencies while preserving the currently selected topology. */
  static refresh(
    contact: ContinuousCircleContact,
    player: Point2D,
    anchor: Point2D,
    body: CircleBody,
    padding: number,
  ): void {
    const radius = body.radius + padding;
    const rawEntry = this.tangentAngle(player, body, radius, contact.side);
    const rawExit = this.tangentAngle(anchor, body, radius, contact.side === 1 ? -1 : 1);
    contact.entryAngle = this.unwrapNear(rawEntry, contact.entryAngle);
    contact.exitAngle = this.unwrapNear(rawExit, contact.exitAngle);
    contact.sweep = contact.exitAngle - contact.entryAngle;
    if (!contact.sideLocked) contact.initialArc = Math.abs(contact.sweep);
  }

  static windingArc(contact: ContinuousCircleContact): number {
    return Math.max(0, Math.abs(contact.sweep) - contact.initialArc);
  }

  static findPathIntersection(
    points: Point2D[],
    body: CircleBody,
    padding: number,
  ): PathIntersection | null {
    const radius = body.radius + padding;
    for (let index = 0; index < points.length - 1; index += 1) {
      const intersection = this.segmentIntersection(points[index], points[index + 1], body, radius);
      if (intersection) return { ...intersection, segmentIndex: index };
    }
    return null;
  }

  private static playerAngularDirection(
    player: Point2D,
    motion: Point2D | null,
    body: CircleBody,
  ): 1 | -1 | 0 {
    if (!motion || Math.hypot(motion.x, motion.y) <= ChainContactSolver.MOTION_EPSILON) return 0;
    const previousX = player.x - motion.x - body.x;
    const previousY = player.y - motion.y - body.y;
    const currentX = player.x - body.x;
    const currentY = player.y - body.y;
    const previousAngle = Math.atan2(previousY, previousX);
    const currentAngle = Math.atan2(currentY, currentX);
    const delta = this.shortestAngle(previousAngle, currentAngle);
    if (Math.abs(delta) <= ChainContactSolver.MOTION_EPSILON) return 0;
    return delta > 0 ? 1 : -1;
  }

  private static solve(
    player: Point2D,
    anchor: Point2D,
    body: CircleBody,
    radius: number,
    side: 1 | -1,
  ): SolvedContact {
    const entryAngle = this.tangentAngle(player, body, radius, side);
    const rawExit = this.tangentAngle(anchor, body, radius, side === 1 ? -1 : 1);
    const sweep = this.directedSweep(entryAngle, rawExit, side);
    return { entryAngle, exitAngle: entryAngle + sweep, sweep };
  }

  private static tangentAngle(point: Point2D, body: CircleBody, radius: number, side: 1 | -1): number {
    const dx = point.x - body.x;
    const dy = point.y - body.y;
    const distance = Math.max(radius + 0.001, Math.hypot(dx, dy));
    return Math.atan2(dy, dx) + side * Math.acos(Math2D.clamp(radius / distance, -1, 1));
  }

  private static segmentIntersectsCircle(
    start: Point2D,
    end: Point2D,
    body: CircleBody,
    radius: number,
  ): boolean {
    return this.segmentIntersection(start, end, body, radius) !== null;
  }

  private static segmentIntersection(
    start: Point2D,
    end: Point2D,
    body: CircleBody,
    radius: number,
  ): SegmentIntersection | null {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const fx = start.x - body.x;
    const fy = start.y - body.y;
    const quadraticA = dx * dx + dy * dy;
    if (quadraticA <= 0.0001) return null;
    const quadraticB = 2 * (fx * dx + fy * dy);
    const quadraticC = fx * fx + fy * fy - radius * radius;
    const discriminant = quadraticB * quadraticB - 4 * quadraticA * quadraticC;
    if (discriminant < 0) return null;
    const root = Math.sqrt(discriminant);
    const t1 = (-quadraticB - root) / (2 * quadraticA);
    const t2 = (-quadraticB + root) / (2 * quadraticA);
    if (t2 < 0 || t1 > 1) return null;
    const entryT = Math2D.clamp(t1, 0, 1);
    const exitT = Math2D.clamp(t2, 0, 1);
    if (exitT - entryT < 0.0001) return null;
    return {
      entryT,
      exitT,
      entryAngle: Math.atan2(start.y + dy * entryT - body.y, start.x + dx * entryT - body.x),
      exitAngle: Math.atan2(start.y + dy * exitT - body.y, start.x + dx * exitT - body.x),
    };
  }

  private static unwrapNear(angle: number, reference: number): number {
    let result = angle;
    while (result - reference > Math.PI) result -= Math.PI * 2;
    while (result - reference < -Math.PI) result += Math.PI * 2;
    return result;
  }

  private static shortestAngle(from: number, to: number): number {
    return this.unwrapNear(to, from) - from;
  }

  private static directedSweep(start: number, end: number, direction: 1 | -1): number {
    let sweep = end - start;
    if (direction > 0) {
      while (sweep < 0) sweep += Math.PI * 2;
      while (sweep >= Math.PI * 2) sweep -= Math.PI * 2;
    } else {
      while (sweep > 0) sweep -= Math.PI * 2;
      while (sweep <= -Math.PI * 2) sweep += Math.PI * 2;
    }
    return sweep;
  }
}
