import { Point2D } from './Math2D';
import { ChainPerformanceBudget } from './ChainPerformanceBudget';

export interface ChainGuideNode extends Point2D {
  previousX: number;
  previousY: number;
}

/** Fixed-capacity, persistent rule-level chain state. */
export class ChainGuideState {
  readonly nodes: ChainGuideNode[] = [];
  readonly touchedBodies: Array<{ x: number; y: number; radius: number }> = [];
  revision = 0;
  initialized = false;
  sleeping = false;
  restLength = 0;
  nodeCount = 0;
  accumulator = 0;

  initialize(points: readonly Point2D[], maxLength: number, requestedNodes: number = ChainPerformanceBudget.targetGuideNodes): void {
    const count = Math.max(2, Math.min(
      ChainPerformanceBudget.maxGuideNodes,
      Math.floor(requestedNodes),
    ));
    const safeLength = Math.max(0.001, maxLength);
    let sourceLength = 0;
    for (let index = 0; index < points.length - 1; index += 1) {
      sourceLength += Math.hypot(
        points[index + 1].x - points[index].x,
        points[index + 1].y - points[index].y,
      );
    }
    this.restLength = safeLength;
    this.nodeCount = count;
    this.accumulator = 0;
    this.touchedBodies.length = 0;
    for (let index = 0; index < count; index += 1) {
      const distance = sourceLength * index / (count - 1);
      const point = this.samplePolyline(points, distance);
      const node = this.nodes[index] || {
        x: 0,
        y: 0,
        previousX: 0,
        previousY: 0,
      };
      node.x = point.x;
      node.y = point.y;
      node.previousX = point.x;
      node.previousY = point.y;
      this.nodes[index] = node;
    }
    this.nodes.length = count;
    this.initialized = true;
    this.sleeping = false;
    this.revision += 1;
  }

  reset(): void {
    this.nodes.length = 0;
    this.revision = 0;
    this.initialized = false;
    this.sleeping = false;
    this.restLength = 0;
    this.nodeCount = 0;
    this.accumulator = 0;
    this.touchedBodies.length = 0;
  }

  private samplePolyline(points: readonly Point2D[], targetDistance: number): Point2D {
    if (points.length === 0) return { x: 0, y: 0 };
    if (points.length === 1) return { x: points[0].x, y: points[0].y };
    let remaining = targetDistance;
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      if (remaining <= length || index === points.length - 2) {
        const t = length > 0.0001 ? Math.max(0, Math.min(1, remaining / length)) : 0;
        return {
          x: start.x + (end.x - start.x) * t,
          y: start.y + (end.y - start.y) * t,
        };
      }
      remaining -= length;
    }
    const last = points[points.length - 1];
    return { x: last.x, y: last.y };
  }
}
