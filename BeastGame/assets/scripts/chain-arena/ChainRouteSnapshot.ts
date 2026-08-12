import { EnemyState } from './ArenaModel';
import { Point2D } from './Math2D';

/** The point range occupied by one body contact in an authoritative route. */
export interface RouteContactRange {
  id: number;
  enemy: EnemyState;
  order: number;
  pointStart: number;
  pointEnd: number;
  startLength: number;
  endLength: number;
}

/**
 * Reusable, frame-local route published by ChainSnareSystem.
 *
 * Consumers must treat this object as read-only. Its backing arrays are reused
 * on the next logic frame so the hot path does not allocate route objects.
 */
export class ChainRouteSnapshot {
  readonly points: Point2D[] = [];
  readonly cumulativeLengths: number[] = [];
  readonly contacts: RouteContactRange[] = [];
  revision = 0;
  totalLength = 0;
  tension = 0;

  clear(tension = 0): void {
    this.points.length = 0;
    this.cumulativeLengths.length = 0;
    this.contacts.length = 0;
    this.totalLength = 0;
    this.tension = tension;
    this.revision += 1;
  }

  publish(
    points: readonly Point2D[],
    contactRanges: readonly RouteContactRange[],
    tension: number,
  ): void {
    this.points.length = points.length;
    this.cumulativeLengths.length = points.length;
    this.contacts.length = contactRanges.length;
    let length = 0;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const target = this.points[index] || { x: 0, y: 0 };
      target.x = point.x;
      target.y = point.y;
      this.points[index] = target;
      if (index > 0) {
        const previous = this.points[index - 1];
        length += Math.hypot(target.x - previous.x, target.y - previous.y);
      }
      this.cumulativeLengths[index] = length;
    }
    for (let index = 0; index < contactRanges.length; index += 1) {
      const range = contactRanges[index];
      const target = this.contacts[index] || { ...range };
      target.id = range.id;
      target.enemy = range.enemy;
      target.order = range.order;
      target.pointStart = range.pointStart;
      target.pointEnd = range.pointEnd;
      target.startLength = range.startLength;
      target.endLength = range.endLength;
      this.contacts[index] = target;
    }
    this.totalLength = length;
    this.tension = tension;
    this.revision += 1;
  }
}
