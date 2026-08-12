import { ChainPerformanceBudget } from './ChainPerformanceBudget';
import { ChainGuideState } from './ChainGuideState';
import { Point2D } from './Math2D';
import { ChainGuideCircle, ChainGuideCollision } from './ChainGuideCollision';

export interface ChainGuideUpdateResult {
  substeps: number;
  changed: boolean;
}

/** Bounded position solver for the rule-level guide chain. */
export class ChainGuideSolver {
  private static readonly DAMPING_PER_SECOND = 0.16;
  private static readonly SLEEP_DISTANCE = 0.015;
  private static readonly WAKE_DISTANCE = 0.05;

  static update(
    state: ChainGuideState,
    dt: number,
    start: Point2D,
    end: Point2D,
    maxLength: number,
    collisionBodies: readonly ChainGuideCircle[] = [],
    collisionPadding = 0,
  ): ChainGuideUpdateResult {
    if (!state.initialized || state.nodeCount < 2 || Math.abs(state.restLength - maxLength) > 0.01) {
      state.initialize([start, end], maxLength);
    }
    state.touchedBodies.length = 0;
    const nodes = state.nodes;
    const lastIndex = state.nodeCount - 1;
    const endpointMoved = Math.hypot(nodes[0].x - start.x, nodes[0].y - start.y)
      + Math.hypot(nodes[lastIndex].x - end.x, nodes[lastIndex].y - end.y);
    if (endpointMoved > ChainGuideSolver.WAKE_DISTANCE) state.sleeping = false;
    state.accumulator = Math.min(
      state.accumulator + Math.max(0, dt),
      ChainPerformanceBudget.guideFixedStep * ChainPerformanceBudget.maxGuideSubsteps,
    );
    let substeps = 0;
    let changed = endpointMoved > ChainGuideSolver.SLEEP_DISTANCE;
    while (state.accumulator + 1e-8 >= ChainPerformanceBudget.guideFixedStep
      && substeps < ChainPerformanceBudget.maxGuideSubsteps) {
      const moved = this.step(
        state,
        start,
        end,
        ChainPerformanceBudget.guideFixedStep,
        collisionBodies,
        collisionPadding,
      );
      changed = changed || moved;
      state.accumulator -= ChainPerformanceBudget.guideFixedStep;
      substeps += 1;
    }
    if (substeps === 0 && endpointMoved > 0) this.pinEndpoints(state, start, end);
    if (changed) state.revision += 1;
    state.sleeping = !changed;
    return { substeps, changed };
  }

  static copyPoints(state: ChainGuideState, target: Point2D[]): Point2D[] {
    target.length = state.nodeCount;
    for (let index = 0; index < state.nodeCount; index += 1) {
      const source = state.nodes[index];
      const point = target[index] || { x: 0, y: 0 };
      point.x = source.x;
      point.y = source.y;
      target[index] = point;
    }
    return target;
  }

  static setPoints(state: ChainGuideState, points: readonly Point2D[], maxLength: number): void {
    state.initialize(points, maxLength, Math.min(points.length, ChainPerformanceBudget.maxGuideNodes));
  }

  private static step(
    state: ChainGuideState,
    start: Point2D,
    end: Point2D,
    dt: number,
    collisionBodies: readonly ChainGuideCircle[],
    collisionPadding: number,
  ): boolean {
    const nodes = state.nodes;
    const lastIndex = state.nodeCount - 1;
    const damping = Math.pow(ChainGuideSolver.DAMPING_PER_SECOND, dt);
    let maximumMotion = 0;
    for (let index = 1; index < lastIndex; index += 1) {
      const node = nodes[index];
      const velocityX = (node.x - node.previousX) * damping;
      const velocityY = (node.y - node.previousY) * damping;
      node.previousX = node.x;
      node.previousY = node.y;
      node.x += velocityX;
      node.y += velocityY;
      maximumMotion = Math.max(maximumMotion, Math.hypot(velocityX, velocityY));
    }
    this.pinEndpoints(state, start, end);
    for (let iteration = 0; iteration < ChainPerformanceBudget.guideConstraintIterations; iteration += 1) {
      this.solveMaximumSegments(state);
      ChainGuideCollision.solve(state, collisionBodies, collisionPadding);
      this.pinEndpoints(state, start, end);
    }
    return maximumMotion > ChainGuideSolver.SLEEP_DISTANCE
      || Math.hypot(nodes[0].x - start.x, nodes[0].y - start.y) > ChainGuideSolver.SLEEP_DISTANCE
      || Math.hypot(nodes[lastIndex].x - end.x, nodes[lastIndex].y - end.y) > ChainGuideSolver.SLEEP_DISTANCE;
  }

  private static solveMaximumSegments(state: ChainGuideState): void {
    const nodes = state.nodes;
    const lastIndex = state.nodeCount - 1;
    const segmentLength = state.restLength / lastIndex;
    for (let index = 0; index < lastIndex; index += 1) {
      const first = nodes[index];
      const second = nodes[index + 1];
      const dx = second.x - first.x;
      const dy = second.y - first.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= segmentLength || distance <= 0.0001) continue;
      const excessX = dx / distance * (distance - segmentLength);
      const excessY = dy / distance * (distance - segmentLength);
      if (index === 0) {
        second.x -= excessX;
        second.y -= excessY;
      } else if (index + 1 === lastIndex) {
        first.x += excessX;
        first.y += excessY;
      } else {
        first.x += excessX * 0.5;
        first.y += excessY * 0.5;
        second.x -= excessX * 0.5;
        second.y -= excessY * 0.5;
      }
    }
  }

  private static pinEndpoints(state: ChainGuideState, start: Point2D, end: Point2D): void {
    const first = state.nodes[0];
    const last = state.nodes[state.nodeCount - 1];
    first.x = start.x;
    first.y = start.y;
    first.previousX = start.x;
    first.previousY = start.y;
    last.x = end.x;
    last.y = end.y;
    last.previousX = end.x;
    last.previousY = end.y;
  }
}
