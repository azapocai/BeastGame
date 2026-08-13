import { Math2D, Point2D } from './Math2D';
import { ChainPerformanceBudget } from './ChainPerformanceBudget';

/** Shared gameplay/presentation threshold for a chain that is actually taut. */
export const CHAIN_FULL_TENSION = 0.98;

export interface Bounds {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

export interface EnemyDefinition {
  x: number;
  y: number;
  tier?: 1 | 2;
  /** Explicit gameplay tag: this unit may drag tether endpoints and trip the player. */
  tetherInfluence?: boolean;
}

export interface BarrelDefinition {
  x: number;
  y: number;
}

export interface RoomDefinition {
  name: string;
  subtitle: string;
  mechanic: 'none' | 'iron-ball' | 'turntable';
  playerStart?: Point2D;
  enemies: EnemyDefinition[];
  barrels: BarrelDefinition[];
}

export const ROOM_DEFINITIONS: RoomDefinition[] = [
  {
    name: '锁链缠绕实验场',
    subtitle: '铁球锁链：接触、绕行、拉脱与绊倒',
    mechanic: 'iron-ball',
    enemies: [
      // Spawn on the initial player-to-ball segment so each run starts with a direct wrapping case.
      { x: -54, y: -58 },
      // Outside the initial straight segment, but close enough to the first
      // body's upper release arc to test active-path contact handoff.
      { x: -54, y: -25 },
      // A third target outside the direct tether, reserved for ordered
      // multi-contact and middle-contact removal tests.
      { x: -12, y: 18 },
    ],
    barrels: [],
  },
];

for (const room of ROOM_DEFINITIONS) {
  if (room.enemies.length > ChainPerformanceBudget.maxActiveEnemies) {
    throw new Error(`Room ${room.name} exceeds the ${ChainPerformanceBudget.maxActiveEnemies}-enemy budget`);
  }
}

const TEST_ARENA_SPEED_SCALE = 2 / 3;
export const TEST_ARENA_DAMAGE_ENABLED = false;
export const MELEE_ATTACK_RANGE = 75;

export class PlayerState {
  x = 0;
  y = -62;
  vx = 0;
  vy = 0;
  radius = 17;
  health = 100;
  maxHealth = 100;
  aim: Point2D = { x: 0, y: 1 };
  attackCooldown = 0;
  attackFlash = 0;
  dashCooldown = 0;
  dashTimer = 0;
  dashDirection: Point2D = { x: 0, y: 1 };
  invincible = 0;
  hitFlash = 0;
  fallTimer = 0;

  /**
   * Advances action timers and returns the requested displacement without
   * committing a world position. Chain rooms pass this proposal to the one
   * authoritative motion resolver.
   */
  prepareMotion(
    dt: number,
    move: Point2D,
    aim: Point2D,
    dashRequested: boolean,
    output: Point2D = { x: 0, y: 0 },
  ): Point2D {
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.attackFlash = Math.max(0, this.attackFlash - dt);
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    this.dashTimer = Math.max(0, this.dashTimer - dt);
    this.invincible = Math.max(0, this.invincible - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.fallTimer = Math.max(0, this.fallTimer - dt);
    this.aim = aim;

    if (this.fallTimer > 0) {
      this.vx = 0;
      this.vy = 0;
      output.x = 0;
      output.y = 0;
      return output;
    }

    if (dashRequested && this.dashCooldown <= 0) {
      const direction = move.x || move.y ? move : aim;
      this.dashDirection = { x: direction.x, y: direction.y };
      this.dashTimer = 0.16;
      this.dashCooldown = 1.05;
      this.invincible = 0.23;
    }

    const moving = this.dashTimer > 0 ? this.dashDirection : move;
    const speed = (this.dashTimer > 0 ? 590 : 238) * TEST_ARENA_SPEED_SCALE;
    this.vx = moving.x * speed;
    this.vy = moving.y * speed;
    output.x = this.vx * dt;
    output.y = this.vy * dt;
    return output;
  }

  /** Legacy one-body entry point used by rooms without a motion resolver. */
  update(dt: number, move: Point2D, aim: Point2D, dashRequested: boolean, bounds: Bounds): void {
    const motion = this.prepareMotion(dt, move, aim, dashRequested);
    this.x = Math2D.clamp(this.x + motion.x, bounds.left + this.radius, bounds.right - this.radius);
    this.y = Math2D.clamp(this.y + motion.y, bounds.bottom + this.radius, bounds.top - this.radius);
  }

  tryAttack(): boolean {
    if (this.attackCooldown > 0) return false;
    this.attackCooldown = 0.34;
    this.attackFlash = 0.13;
    return true;
  }

  damage(amount: number, knockbackX: number, knockbackY: number): boolean {
    if (!TEST_ARENA_DAMAGE_ENABLED) {
      this.hitFlash = 0.08;
      return false;
    }
    if (this.invincible > 0) return false;
    this.health = Math.max(0, this.health - amount);
    this.hitFlash = 0.16;
    this.invincible = 0.55;
    this.x += knockbackX;
    this.y += knockbackY;
    return true;
  }

  applyFall(duration: number): void {
    this.fallTimer = Math.max(this.fallTimer, duration);
    this.dashTimer = 0;
    this.vx = 0;
    this.vy = 0;
  }
}

export class EnemyState {
  private static readonly COLLISION_RECOVERY_DURATION = 0.18;
  x: number;
  y: number;
  tier: 1 | 2;
  radius: number;
  health: number;
  maxHealth: number;
  speed: number;
  damageCooldown = Math.random() * 0.4;
  ballHitCooldown = 0;
  hitFlash = 0;
  attackFlash = 0;
  snareTimer = 0;
  collisionEnabled = true;
  collisionRecoveryTimer = 0;
  readonly canInfluenceTether: boolean;
  attackDirection: Point2D = { x: 1, y: 0 };
  private readonly moveDirection: Point2D = { x: 0, y: 0 };
  get collisionSeparationScale(): number {
    if (this.collisionRecoveryTimer <= 0) return 1;
    return Math.max(0.15, 1 - this.collisionRecoveryTimer / EnemyState.COLLISION_RECOVERY_DURATION);
  }
  knockback: Point2D = { x: 0, y: 0 };
  dead = false;

  constructor(definition: EnemyDefinition) {
    this.x = definition.x;
    this.y = definition.y;
    this.tier = definition.tier || 1;
    this.canInfluenceTether = definition.tetherInfluence === true;
    this.radius = this.tier === 2 ? 22 : 16;
    this.health = this.tier === 2 ? 4 : 2;
    this.maxHealth = this.health;
    this.speed = (this.tier === 2 ? 74 : 100) * TEST_ARENA_SPEED_SCALE;
  }

  update(dt: number, player: PlayerState, enemies: EnemyState[], bounds: Bounds): void {
    this.damageCooldown = Math.max(0, this.damageCooldown - dt);
    this.ballHitCooldown = Math.max(0, this.ballHitCooldown - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.attackFlash = Math.max(0, this.attackFlash - dt);
    const wasSnared = this.snareTimer > 0;
    this.snareTimer = Math.max(0, this.snareTimer - dt);
    if (this.dead || this.snareTimer > 0) {
      this.collisionEnabled = false;
      this.collisionRecoveryTimer = EnemyState.COLLISION_RECOVERY_DURATION;
    } else {
      this.collisionEnabled = true;
      if (wasSnared) {
        this.collisionRecoveryTimer = EnemyState.COLLISION_RECOVERY_DURATION;
        this.damageCooldown = Math.max(this.damageCooldown, EnemyState.COLLISION_RECOVERY_DURATION);
      }
      else this.collisionRecoveryTimer = Math.max(0, this.collisionRecoveryTimer - dt);
    }

    if (Math.hypot(this.knockback.x, this.knockback.y) > 8) {
      this.x += this.knockback.x * dt;
      this.y += this.knockback.y * dt;
      const drag = Math.pow(0.018, dt);
      this.knockback.x *= drag;
      this.knockback.y *= drag;
    } else if (this.snareTimer <= 0) {
      const chase = Math2D.normalize(player.x - this.x, player.y - this.y, this.attackDirection);
      const playerDistance = Math.hypot(player.x - this.x, player.y - this.y);
      if (playerDistance > MELEE_ATTACK_RANGE + player.radius) {
        let separateX = 0;
        let separateY = 0;
        for (const other of enemies) {
          if (other === this || other.dead) continue;
          const dx = this.x - other.x;
          const dy = this.y - other.y;
          const distance = Math.hypot(dx, dy);
          if (distance > 0 && distance < this.radius + other.radius + 8) {
            separateX += dx / distance;
            separateY += dy / distance;
          }
        }
        const direction = Math2D.normalize(
          chase.x + separateX * 0.35,
          chase.y + separateY * 0.35,
          this.moveDirection,
        );
        this.x += direction.x * this.speed * dt;
        this.y += direction.y * this.speed * dt;
      } else if (this.damageCooldown <= 0) {
        player.damage(this.tier === 2 ? 16 : 10, chase.x * 22, chase.y * 22);
        this.damageCooldown = 0.90;
        this.attackFlash = 0.18;
      }
    }

    this.x = Math2D.clamp(this.x, bounds.left + this.radius, bounds.right - this.radius);
    this.y = Math2D.clamp(this.y, bounds.bottom + this.radius, bounds.top - this.radius);

  }

  damage(amount: number, knockbackX: number, knockbackY: number): void {
    if (this.dead) return;
    if (!TEST_ARENA_DAMAGE_ENABLED) {
      this.hitFlash = 0.08;
      return;
    }
    const finalAmount = this.snareTimer > 0 ? Math.ceil(amount * 1.5) : amount;
    this.health -= finalAmount;
    this.hitFlash = 0.14;
    this.knockback.x += knockbackX;
    this.knockback.y += knockbackY;
    if (this.health <= 0) {
      this.dead = true;
      this.collisionEnabled = false;
    }
  }

  applySnare(duration: number): void {
    if (this.dead) return;
    this.snareTimer = Math.max(this.snareTimer, duration);
    this.collisionEnabled = false;
    this.collisionRecoveryTimer = EnemyState.COLLISION_RECOVERY_DURATION;
    this.damageCooldown = Math.max(this.damageCooldown, duration);
    this.hitFlash = 0.16;
  }
}

export class BarrelState {
  x: number;
  y: number;
  radius = 18;
  exploded = false;

  constructor(definition: BarrelDefinition) {
    this.x = definition.x;
    this.y = definition.y;
  }
}
