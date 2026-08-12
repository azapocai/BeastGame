import { ChainGuideState } from './ChainGuideState';

export interface ChainGuideCircle {
  x: number;
  y: number;
  radius: number;
}

/** Circle projection for the bounded rule guide; it never moves game bodies. */
export class ChainGuideCollision {
  static solve(state: ChainGuideState, bodies: readonly ChainGuideCircle[], padding: number): void {
    const lastIndex = state.nodeCount - 1;
    for (const body of bodies) {
      const radius = body.radius + padding;
      const radiusSquared = radius * radius;
      for (let index = 1; index < lastIndex; index += 1) {
        const node = state.nodes[index];
        const dx = node.x - body.x;
        const dy = node.y - body.y;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared >= radiusSquared) continue;
        this.recordTouch(state, body);
        const distance = Math.sqrt(distanceSquared);
        const nx = distance > 0.0001 ? dx / distance : 0;
        const ny = distance > 0.0001 ? dy / distance : 1;
        node.x = body.x + nx * radius;
        node.y = body.y + ny * radius;
      }
      for (let index = 0; index < lastIndex; index += 1) {
        this.projectCrossingSegment(state, index, body, radius);
      }
    }
  }

  private static projectCrossingSegment(
    state: ChainGuideState,
    index: number,
    body: ChainGuideCircle,
    radius: number,
  ): void {
    const first = state.nodes[index];
    const second = state.nodes[index + 1];
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= 0.0001) return;
    const t = Math.max(0, Math.min(1,
      ((body.x - first.x) * dx + (body.y - first.y) * dy) / lengthSquared,
    ));
    const closestX = first.x + dx * t;
    const closestY = first.y + dy * t;
    let normalX = closestX - body.x;
    let normalY = closestY - body.y;
    let distance = Math.hypot(normalX, normalY);
    if (distance >= radius - 0.001) return;
    this.recordTouch(state, body);
    if (distance <= 0.0001) {
      const inverseLength = 1 / Math.sqrt(lengthSquared);
      normalX = -dy * inverseLength;
      normalY = dx * inverseLength;
      distance = 0;
    } else {
      normalX /= distance;
      normalY /= distance;
    }
    const correction = radius - distance + 0.01;
    const lastIndex = state.nodeCount - 1;
    const firstMovable = index > 0;
    const secondMovable = index + 1 < lastIndex;
    if (!firstMovable && !secondMovable) return;
    if (firstMovable && secondMovable) {
      const firstWeight = 1 - t;
      const secondWeight = t;
      const total = Math.max(0.001, firstWeight * firstWeight + secondWeight * secondWeight);
      first.x += normalX * correction * firstWeight / total;
      first.y += normalY * correction * firstWeight / total;
      second.x += normalX * correction * secondWeight / total;
      second.y += normalY * correction * secondWeight / total;
    } else if (firstMovable) {
      first.x += normalX * correction / Math.max(0.08, 1 - t);
      first.y += normalY * correction / Math.max(0.08, 1 - t);
    } else {
      second.x += normalX * correction / Math.max(0.08, t);
      second.y += normalY * correction / Math.max(0.08, t);
    }
  }

  private static recordTouch(state: ChainGuideState, body: ChainGuideCircle): void {
    if (state.touchedBodies.indexOf(body) < 0) state.touchedBodies.push(body);
  }
}
