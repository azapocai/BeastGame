import { BarrelState, Bounds, EnemyState, PlayerState } from './ArenaModel';
import { Math2D, Point2D } from './Math2D';

export interface TetherSnapshot {
  points: Point2D[];
  tension: number;
  currentLength: number;
  maxLength: number;
  anchorKind: 'fixed' | 'iron-ball' | 'turntable';
}

export interface TetherAnchorProvider {
  readonly kind: TetherSnapshot['anchorKind'];
  getAnchorPosition(): Point2D;
}

/** Two-body custom tether used by the iron-ball room. */
export class IronBallTether implements TetherAnchorProvider {
  readonly kind = 'iron-ball' as const;
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  radius = 27;
  maxLength = 317;
  lastSpeed = 0;
  tension = 0;
  hitPulse = 0;
  private readonly impactDirection: Point2D = { x: 0, y: 0 };

  constructor(player: PlayerState) {
    this.x = player.x - 112;
    this.y = player.y + 8;
  }

  getAnchorPosition(): Point2D {
    return { x: this.x, y: this.y };
  }

  getSnapshot(player: PlayerState): TetherSnapshot {
    const currentLength = Math.hypot(player.x - this.x, player.y - this.y);
    return {
      points: [{ x: player.x, y: player.y }, this.getAnchorPosition()],
      tension: this.tension,
      currentLength,
      maxLength: this.maxLength,
      anchorKind: this.kind,
    };
  }

  /** Integrates only the iron ball. It never writes the player position. */
  integrate(dt: number, bounds: Bounds): void {
    this.hitPulse = Math.max(0, this.hitPulse - dt);
    const drag = Math.pow(0.32, dt);
    this.vx *= drag;
    this.vy *= drag;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    if (this.x < bounds.left + this.radius || this.x > bounds.right - this.radius) {
      this.x = Math2D.clamp(this.x, bounds.left + this.radius, bounds.right - this.radius);
      this.vx *= -0.48;
    }
    if (this.y < bounds.bottom + this.radius || this.y > bounds.top - this.radius) {
      this.y = Math2D.clamp(this.y, bounds.bottom + this.radius, bounds.top - this.radius);
      this.vy *= -0.48;
    }
    this.lastSpeed = Math.hypot(this.vx, this.vy);
  }

  applyHits(enemies: EnemyState[], barrels: BarrelState[], explodeBarrel: (barrel: BarrelState) => void): void {
    if (this.lastSpeed < 135) return;
    const direction = Math2D.normalize(this.vx, this.vy, this.impactDirection);
    const power = Math2D.clamp((this.lastSpeed - 120) / 180, 0.65, 2.2);
    for (const enemy of enemies) {
      if (enemy.dead || enemy.ballHitCooldown > 0 || !Math2D.overlaps(this, enemy)) continue;
      enemy.damage(power >= 1.2 ? 3 : 2, direction.x * 300 * power, direction.y * 300 * power);
      enemy.ballHitCooldown = 0.42;
      this.vx *= 0.72;
      this.vy *= 0.72;
      this.hitPulse = 0.13;
    }
    for (const barrel of barrels) {
      if (!barrel.exploded && Math2D.overlaps(this, barrel) && this.lastSpeed >= 175) explodeBarrel(barrel);
    }
  }
}

/**
 * A rotating anchor. The chain has only the player and current rod endpoint in
 * its path, so orbiting can rotate the rod but never creates accumulated wraps.
 */
export class TurntableTether implements TetherAnchorProvider {
  readonly kind = 'turntable' as const;
  centerX: number;
  centerY: number;
  angle = -0.35;
  angularVelocity = 0;
  rodLength = 86;
  hubRadius = 31;
  endpointRadius = 18;
  maxLength = 178;
  tension = 0;
  lastAnchorSpeed = 0;
  hitPulse = 0;

  constructor(centerX = 0, centerY = 0) {
    this.centerX = centerX;
    this.centerY = centerY;
  }

  getAnchorPosition(): Point2D {
    return {
      x: this.centerX + Math.cos(this.angle) * this.rodLength,
      y: this.centerY + Math.sin(this.angle) * this.rodLength,
    };
  }

  getSnapshot(player: PlayerState): TetherSnapshot {
    const anchor = this.getAnchorPosition();
    return {
      points: [{ x: player.x, y: player.y }, anchor],
      tension: this.tension,
      currentLength: Math.hypot(player.x - anchor.x, player.y - anchor.y),
      maxLength: this.maxLength,
      anchorKind: this.kind,
    };
  }

  update(dt: number, player: PlayerState): void {
    this.hitPulse = Math.max(0, this.hitPulse - dt);
    this.angularVelocity *= Math.pow(0.18, dt);

    const anchor = this.getAnchorPosition();
    const dx = player.x - anchor.x;
    const dy = player.y - anchor.y;
    const distance = Math.max(0.0001, Math.hypot(dx, dy));
    const nx = dx / distance;
    const ny = dy / distance;
    this.tension = Math2D.clamp((distance - this.maxLength * 0.80) / (this.maxLength * 0.20), 0, 1);

    if (this.tension > 0) {
      const tangentX = -Math.sin(this.angle);
      const tangentY = Math.cos(this.angle);
      const anchorVx = tangentX * this.rodLength * this.angularVelocity;
      const anchorVy = tangentY * this.rodLength * this.angularVelocity;
      const outwardVelocity = Math.max(0, (player.vx - anchorVx) * nx + (player.vy - anchorVy) * ny);
      const extension = Math.max(0, distance - this.maxLength * 0.80);
      const pull = extension * 18 + outwardVelocity * 2.5;
      const torqueSign = Math.cos(this.angle) * ny - Math.sin(this.angle) * nx;
      this.angularVelocity += torqueSign * (pull / this.rodLength) * dt * 6;
      this.angularVelocity = Math2D.clamp(this.angularVelocity, -4.8, 4.8);
    }

    this.angle += this.angularVelocity * dt;
    if (this.angle > Math.PI) this.angle -= Math.PI * 2;
    else if (this.angle < -Math.PI) this.angle += Math.PI * 2;
    this.lastAnchorSpeed = Math.abs(this.angularVelocity) * this.rodLength;

    const updatedAnchor = this.getAnchorPosition();
    const updatedDx = player.x - updatedAnchor.x;
    const updatedDy = player.y - updatedAnchor.y;
    const updatedDistance = Math.max(0.0001, Math.hypot(updatedDx, updatedDy));
    if (updatedDistance > this.maxLength) {
      player.x = updatedAnchor.x + updatedDx / updatedDistance * this.maxLength;
      player.y = updatedAnchor.y + updatedDy / updatedDistance * this.maxLength;
    }
    this.resolveHubCollision(player);
  }

  applyHits(enemies: EnemyState[], barrels: BarrelState[], explodeBarrel: (barrel: BarrelState) => void): void {
    if (this.lastAnchorSpeed < 115) return;
    const anchor = this.getAnchorPosition();
    const tangent = {
      x: -Math.sin(this.angle) * Math.sign(this.angularVelocity || 1),
      y: Math.cos(this.angle) * Math.sign(this.angularVelocity || 1),
    };
    const collider = { x: anchor.x, y: anchor.y, radius: this.endpointRadius };
    for (const enemy of enemies) {
      if (enemy.dead || enemy.ballHitCooldown > 0 || !Math2D.overlaps(collider, enemy)) continue;
      const power = Math2D.clamp(this.lastAnchorSpeed / 130, 0.9, 2.2);
      enemy.damage(power > 1.35 ? 3 : 2, tangent.x * 280 * power, tangent.y * 280 * power);
      enemy.ballHitCooldown = 0.42;
      this.angularVelocity *= 0.76;
      this.hitPulse = 0.13;
    }
    if (this.lastAnchorSpeed >= 160) {
      for (const barrel of barrels) {
        if (!barrel.exploded && Math2D.overlaps(collider, barrel)) explodeBarrel(barrel);
      }
    }
  }

  private resolveHubCollision(player: PlayerState): void {
    const dx = player.x - this.centerX;
    const dy = player.y - this.centerY;
    const distance = Math.hypot(dx, dy);
    const minimum = this.hubRadius + player.radius + 4;
    if (distance >= minimum) return;
    const direction = distance > 0.001 ? { x: dx / distance, y: dy / distance } : { x: 1, y: 0 };
    player.x = this.centerX + direction.x * minimum;
    player.y = this.centerY + direction.y * minimum;
  }
}
