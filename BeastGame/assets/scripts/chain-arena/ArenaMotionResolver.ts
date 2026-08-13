import { Bounds, EnemyState, PlayerState } from './ArenaModel';
import { CircleCollisionSolver } from './CircleCollisionSolver';
import { Math2D, Point2D } from './Math2D';
import { IronBallTether } from './TetherSystem';

export interface ArenaMotionResult {
  playerDelta: Point2D;
  playerDrivenDelta: Point2D;
  leashClipped: boolean;
}

/**
 * The sole position committer for the player in the iron-ball room.
 *
 * Priority is explicit: input proposal -> arena bounds -> solid enemies ->
 * direct leash limit. Ball collisions move the ball or ordinary enemy, never
 * the player. Chain geometry is observational and cannot feed corrections
 * back into this resolver.
 */
export class ArenaMotionResolver {
  private readonly candidate = { x: 0, y: 0, radius: 0 };
  private readonly fallback = { x: 0, y: 0 };
  private readonly collisionResult = { normalX: 0, normalY: 0, penetration: 0 };
  private readonly result: ArenaMotionResult = {
    playerDelta: { x: 0, y: 0 },
    playerDrivenDelta: { x: 0, y: 0 },
    leashClipped: false,
  };

  resolveIronBallFrame(
    player: PlayerState,
    ball: IronBallTether,
    enemies: readonly EnemyState[],
    bounds: Bounds,
    desiredPlayerDelta: Point2D,
    occupiedChainLength = 0,
  ): ArenaMotionResult {
    const startX = player.x;
    const startY = player.y;
    const candidate = this.candidate;
    candidate.x = Math2D.clamp(startX + desiredPlayerDelta.x, bounds.left + player.radius, bounds.right - player.radius);
    candidate.y = Math2D.clamp(startY + desiredPlayerDelta.y, bounds.bottom + player.radius, bounds.top - player.radius);
    candidate.radius = player.radius;

    for (const enemy of enemies) {
      if (enemy.dead || !enemy.collisionEnabled) continue;
      CircleCollisionSolver.separateMovable(
        candidate,
        enemy,
        0,
        desiredPlayerDelta,
        this.collisionResult,
        enemy.collisionSeparationScale,
      );
      candidate.x = Math2D.clamp(candidate.x, bounds.left + player.radius, bounds.right - player.radius);
      candidate.y = Math2D.clamp(candidate.y, bounds.bottom + player.radius, bounds.top - player.radius);
    }

    const startDistance = Math.hypot(startX - ball.x, startY - ball.y);
    const routeAdjustedLimit = Math2D.clamp(ball.maxLength - occupiedChainLength, 1, ball.maxLength);
    // A body moving inside the chain may reduce future outward allowance, but
    // an ordinary body may never pull a stationary player inward. The current
    // accepted radius is therefore the floor for this frame.
    const movementLimit = startDistance <= ball.maxLength
      ? Math.max(startDistance, routeAdjustedLimit)
      : ball.maxLength;
    const leashClipped = this.clipToLeash(candidate, ball, movementLimit);
    player.x = candidate.x;
    player.y = candidate.y;

    this.resolveBallAgainstPlayer(ball, player, bounds);
    this.resolveBallAgainstEnemies(ball, enemies, bounds);

    // Ball separation can move the anchor. One final radial projection keeps
    // the invariant without iterating actor corrections or adding side force.
    const clippedAfterBodies = this.clipToLeash(player, ball, movementLimit);
    player.x = Math2D.clamp(player.x, bounds.left + player.radius, bounds.right - player.radius);
    player.y = Math2D.clamp(player.y, bounds.bottom + player.radius, bounds.top - player.radius);

    const distance = Math.hypot(player.x - ball.x, player.y - ball.y);
    ball.tension = Math2D.clamp((distance - ball.maxLength * 0.82) / (ball.maxLength * 0.18), 0, 1);
    this.result.playerDelta.x = player.x - startX;
    this.result.playerDelta.y = player.y - startY;
    const desiredLength = Math.hypot(desiredPlayerDelta.x, desiredPlayerDelta.y);
    if (desiredLength > 0.0001) {
      const directionX = desiredPlayerDelta.x / desiredLength;
      const directionY = desiredPlayerDelta.y / desiredLength;
      const acceptedAlongInput = Math.max(0, Math.min(
        desiredLength,
        this.result.playerDelta.x * directionX + this.result.playerDelta.y * directionY,
      ));
      this.result.playerDrivenDelta.x = directionX * acceptedAlongInput;
      this.result.playerDrivenDelta.y = directionY * acceptedAlongInput;
    } else {
      this.result.playerDrivenDelta.x = 0;
      this.result.playerDrivenDelta.y = 0;
    }
    this.result.leashClipped = leashClipped || clippedAfterBodies;
    return this.result;
  }

  /**
   * Explicit exception for tagged heavy units. The caller supplies that
   * unit's measured frame displacement; no enemy class or visual form is
   * inferred here.
   */
  applyTaggedTetherInfluence(
    player: PlayerState,
    ball: IronBallTether,
    source: EnemyState,
    sourceDelta: Point2D,
    bounds: Bounds,
  ): boolean {
    if (!source.canInfluenceTether || source.dead || source.snareTimer > 0) return false;
    const distance = Math.hypot(sourceDelta.x, sourceDelta.y);
    if (distance <= 0.01) return false;
    const scale = Math.min(1, 12 / distance);
    const dx = sourceDelta.x * scale;
    const dy = sourceDelta.y * scale;
    ball.x = Math2D.clamp(ball.x + dx, bounds.left + ball.radius, bounds.right - ball.radius);
    ball.y = Math2D.clamp(ball.y + dy, bounds.bottom + ball.radius, bounds.top - ball.radius);
    player.x = Math2D.clamp(player.x + dx, bounds.left + player.radius, bounds.right - player.radius);
    player.y = Math2D.clamp(player.y + dy, bounds.bottom + player.radius, bounds.top - player.radius);
    player.applyFall(0.45);
    return true;
  }

  private resolveBallAgainstPlayer(ball: IronBallTether, player: PlayerState, bounds: Bounds): void {
    const fallback = Math2D.normalize(
      ball.x - player.x || -player.vx,
      ball.y - player.y || -player.vy,
      this.fallback,
    );
    CircleCollisionSolver.separateMovable(ball, player, 0.18, fallback, this.collisionResult);
    this.clampBall(ball, bounds);
  }

  private resolveBallAgainstEnemies(
    ball: IronBallTether,
    enemies: readonly EnemyState[],
    bounds: Bounds,
  ): void {
    for (const enemy of enemies) {
      if (enemy.dead || !enemy.collisionEnabled) continue;
      const fallback = Math2D.normalize(
        enemy.x - ball.x || -ball.vx,
        enemy.y - ball.y || -ball.vy,
        this.fallback,
      );
      const result = CircleCollisionSolver.separateMovable(
        enemy,
        ball,
        0,
        fallback,
        this.collisionResult,
        enemy.collisionSeparationScale,
      );
      if (!result) continue;
      const impactSpeed = Math.max(0, ball.vx * result.normalX + ball.vy * result.normalY);
      if (impactSpeed > 1) {
        enemy.knockback.x += result.normalX * impactSpeed * 0.32;
        enemy.knockback.y += result.normalY * impactSpeed * 0.32;
      }
      enemy.x = Math2D.clamp(enemy.x, bounds.left + enemy.radius, bounds.right - enemy.radius);
      enemy.y = Math2D.clamp(enemy.y, bounds.bottom + enemy.radius, bounds.top - enemy.radius);
    }
  }

  private clipToLeash(movable: Point2D, anchor: Point2D, maxLength: number): boolean {
    const dx = movable.x - anchor.x;
    const dy = movable.y - anchor.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= maxLength || distance <= 0.001) return false;
    movable.x = anchor.x + dx / distance * maxLength;
    movable.y = anchor.y + dy / distance * maxLength;
    return true;
  }

  private clampBall(ball: IronBallTether, bounds: Bounds): void {
    ball.x = Math2D.clamp(ball.x, bounds.left + ball.radius, bounds.right - ball.radius);
    ball.y = Math2D.clamp(ball.y, bounds.bottom + ball.radius, bounds.top - ball.radius);
  }
}
