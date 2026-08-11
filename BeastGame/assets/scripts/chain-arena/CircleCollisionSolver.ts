export interface MovableCircle {
  x: number;
  y: number;
  radius: number;
  vx?: number;
  vy?: number;
}

export interface CircleCollisionResult {
  normalX: number;
  normalY: number;
  penetration: number;
}

/** Pure one-sided circle separation used by authoritative tether bodies. */
export class CircleCollisionSolver {
  static separateMovable(
    movable: MovableCircle,
    obstacle: MovableCircle,
    restitution = 0,
    fallbackNormal = { x: 1, y: 0 },
  ): CircleCollisionResult | null {
    const dx = movable.x - obstacle.x;
    const dy = movable.y - obstacle.y;
    const distance = Math.hypot(dx, dy);
    const minimum = movable.radius + obstacle.radius;
    if (distance >= minimum) return null;

    const fallbackLength = Math.hypot(fallbackNormal.x, fallbackNormal.y);
    const normalX = distance > 0.001
      ? dx / distance
      : fallbackLength > 0.001 ? fallbackNormal.x / fallbackLength : 1;
    const normalY = distance > 0.001
      ? dy / distance
      : fallbackLength > 0.001 ? fallbackNormal.y / fallbackLength : 0;
    const penetration = minimum - distance;
    movable.x += normalX * penetration;
    movable.y += normalY * penetration;

    if (movable.vx !== undefined && movable.vy !== undefined) {
      const inwardSpeed = movable.vx * normalX + movable.vy * normalY;
      if (inwardSpeed < 0) {
        movable.vx -= normalX * inwardSpeed * (1 + restitution);
        movable.vy -= normalY * inwardSpeed * (1 + restitution);
      }
    }
    return { normalX, normalY, penetration };
  }

  /** Symmetric separation for peers such as two ordinary enemies. */
  static separatePair(
    first: MovableCircle,
    second: MovableCircle,
    fallbackNormal = { x: 1, y: 0 },
  ): CircleCollisionResult | null {
    const dx = first.x - second.x;
    const dy = first.y - second.y;
    const distance = Math.hypot(dx, dy);
    const minimum = first.radius + second.radius;
    if (distance >= minimum) return null;

    const fallbackLength = Math.hypot(fallbackNormal.x, fallbackNormal.y);
    const normalX = distance > 0.001
      ? dx / distance
      : fallbackLength > 0.001 ? fallbackNormal.x / fallbackLength : 1;
    const normalY = distance > 0.001
      ? dy / distance
      : fallbackLength > 0.001 ? fallbackNormal.y / fallbackLength : 0;
    const penetration = minimum - distance;
    const correction = penetration * 0.5;
    first.x += normalX * correction;
    first.y += normalY * correction;
    second.x -= normalX * correction;
    second.y -= normalY * correction;
    return { normalX, normalY, penetration };
  }
}
