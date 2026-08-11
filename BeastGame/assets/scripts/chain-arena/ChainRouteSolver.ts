import { Math2D, Point2D } from './Math2D';
import { CircleBody, ContinuousCircleContact } from './ChainContactSolver';

/** Builds and measures the exact route used by rendering and constraints. */
export class ChainRouteSolver {
  static build(
    sourcePoints: Point2D[],
    contact: ContinuousCircleContact | null,
    body: CircleBody | null,
    padding: number,
  ): Point2D[] {
    if (sourcePoints.length < 2 || !contact || !body) {
      return sourcePoints.map((point) => ({ x: point.x, y: point.y }));
    }
    const start = sourcePoints[0];
    const end = sourcePoints[sourcePoints.length - 1];
    const radius = body.radius + padding;
    const points: Point2D[] = [{ x: start.x, y: start.y }];
    const segments = Math.max(3, Math.ceil(Math.abs(contact.sweep) / (Math.PI / 16)));
    for (let index = 0; index <= segments; index += 1) {
      const angle = contact.entryAngle + contact.sweep * index / segments;
      points.push({
        x: body.x + Math.cos(angle) * radius,
        y: body.y + Math.sin(angle) * radius,
      });
    }
    points.push({ x: end.x, y: end.y });
    return points;
  }

  static pathLength(points: Point2D[]): number {
    let length = 0;
    for (let index = 0; index < points.length - 1; index += 1) {
      length += Math.hypot(points[index + 1].x - points[index].x, points[index + 1].y - points[index].y);
    }
    return length;
  }

  static pathFractionAt(points: Point2D[], segmentIndex: number, segmentT: number): number {
    const total = this.pathLength(points);
    if (total <= 0.001) return 0.5;
    let before = 0;
    for (let index = 0; index < segmentIndex; index += 1) {
      before += Math.hypot(
        points[index + 1].x - points[index].x,
        points[index + 1].y - points[index].y,
      );
    }
    const start = points[segmentIndex];
    const end = points[segmentIndex + 1];
    const segmentLength = Math.hypot(end.x - start.x, end.y - start.y);
    return Math2D.clamp((before + segmentLength * segmentT) / total, 0, 1);
  }
}
