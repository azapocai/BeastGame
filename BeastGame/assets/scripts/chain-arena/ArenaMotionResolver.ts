import { Bounds, EnemyState, PlayerState } from './ArenaModel';
import { CircleCollisionSolver } from './CircleCollisionSolver';
import { Math2D, Point2D } from './Math2D';
import { IronBallTether } from './TetherSystem';

export interface ArenaMotionResult {
  playerDelta: Point2D;
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
  resolveIronBallFrame(
    player: PlayerState,
    ball: IronBallTether,
    enemies: readonly EnemyState[],
    bounds: Bounds,
    desiredPlayerDelta: Point2D,
  ): ArenaMotionResult {
    const startX = player.x;
    const startY = player.y;
    const candidate = {
      x: Math2D.clamp(startX + desiredPlayerDelta.x, bounds.left + player.radius, bounds.right - player.radius),
      y: Math2D.clamp(startY + desiredPlayerDelta.y, bounds.bottom + player.radius, bounds.top - player.radius),
      radius: player.radius,
    };

    for (const enemy of enemies) {
      if (enemy.dead || !enemy.collisionEnabled) continue;
      CircleCollisionSolver.separateMovable(candidate, enemy, 0, desiredPlayerDelta);
      candidate.x = Math2D.clamp(candidate.x, bounds.left + player.radius, bounds.right - player.radius);
      candidate.y = Math2D.clamp(candidate.y, bounds.bottom + player.radius, bounds.top - player.radius);
    }

    const leashClipped = this.clipToLeash(candidate, ball, ball.maxLength);
    player.x = candidate.x;
    player.y = candidate.y;

    this.resolveBallAgainstPlayer(ball, player, bounds);
    this.resolveBallAgainstEnemies(ball, enemies, bounds);

    // Ball separation can move the anchor. One final radial projection keeps
    // the invariant without iterating actor corrections or adding side force.
    const clippedAfterBodies = this.clipToLeash(player, ball, ball.maxLength);
    player.x = Math2D.clamp(player.x, bounds.left + player.radius, bounds.right - player.radius);
    player.y = Math2D.clamp(player.y, bounds.bottom + player.radius, bounds.top - player.radius);

    const distance = Math.hypot(player.x - ball.x, player.y - ball.y);
    ball.tension = Math2D.clamp((distance - ball.maxLength * 0.82) / (ball.maxLength * 0.18), 0, 1);
    return {
      playerDelta: { x: player.x - startX, y: player.y - startY },
      leashClipped: leashClipped || clippedAfterBodies,
    };
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
    const fallback = Math2D.normalize(ball.x - player.x || -player.vx, ball.y - player.y || -player.vy);
    CircleCollisionSolver.separateMovable(ball, player, 0.18, fallback);
    this.clampBall(ball, bounds);
  }

  private resolveBallAgainstEnemies(
    ball: IronBallTether,
    enemies: readonly EnemyState[],
    bounds: Bounds,
  ): void {
    for (const enemy of enemies) {
      if (enemy.dead || !enemy.collisionEnabled) continue;
      const fallback = Math2D.normalize(enemy.x - ball.x || -ball.vx, enemy.y - ball.y || -ball.vy);
      const result = CircleCollisionSolver.separateMovable(enemy, ball, 0, fallback);
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
