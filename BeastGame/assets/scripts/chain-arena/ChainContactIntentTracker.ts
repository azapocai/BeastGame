import { EnemyState } from './ArenaModel';
import { Point2D } from './Math2D';

/**
 * Separates a real player-driven wrap from an enemy merely touching a taut
 * chain. This is an intent gate only; the authoritative 45-degree geometry
 * and full-tension thresholds remain in ChainSimulation.
 */
export class ChainContactIntentTracker {
  private static readonly MIN_PLAYER_ORBIT = Math.PI * (8 / 180);

  private readonly enemies: EnemyState[] = [];
  private readonly orbit: number[] = [];
  private readonly wrapDirection: number[] = [];
  private readonly activeFrames: number[] = [];
  private readonly seen: EnemyState[] = [];

  reset(): void {
    this.enemies.length = 0;
    this.orbit.length = 0;
    this.wrapDirection.length = 0;
    this.activeFrames.length = 0;
    this.seen.length = 0;
  }

  beginFrame(): void {
    this.seen.length = 0;
  }

  observe(
    enemy: EnemyState,
    player: Point2D,
    playerDrivenMotion: Point2D,
    signedContactSweep: number,
  ): void {
    this.seen.push(enemy);
    let index = this.enemies.indexOf(enemy);
    if (index < 0) {
      index = this.enemies.length;
      this.enemies.push(enemy);
      this.orbit.push(0);
      this.wrapDirection.push(Math.sign(signedContactSweep));
      this.activeFrames.push(1);
      return;
    }
    this.activeFrames[index] += 1;
    const contactDirection = Math.sign(signedContactSweep);
    if (contactDirection !== 0 && contactDirection !== this.wrapDirection[index]) {
      // Crossing to the other side is a new wrap attempt. Progress from the
      // previous bend must never be carried across the straight configuration.
      this.wrapDirection[index] = contactDirection;
      this.orbit[index] = 0;
    }
    if (playerDrivenMotion.x === 0 && playerDrivenMotion.y === 0) return;
    const previousAngle = Math.atan2(
      player.y - playerDrivenMotion.y - enemy.y,
      player.x - playerDrivenMotion.x - enemy.x,
    );
    const currentAngle = Math.atan2(player.y - enemy.y, player.x - enemy.x);
    let delta = currentAngle - previousAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    // The contact sweep is ordered ball -> player. Player orbit in the same
    // signed direction deepens that bend; orbit in the opposite direction
    // unwraps it and therefore subtracts progress.
    const directedDelta = delta * this.wrapDirection[index];
    this.orbit[index] = Math.max(0, Math.min(Math.PI * 2, this.orbit[index] + directedDelta));
  }

  endFrame(): void {
    let retained = 0;
    for (let index = 0; index < this.enemies.length; index += 1) {
      const enemy = this.enemies[index];
      if (this.seen.indexOf(enemy) < 0) continue;
      this.enemies[retained] = enemy;
      this.orbit[retained] = this.orbit[index];
      this.wrapDirection[retained] = this.wrapDirection[index];
      this.activeFrames[retained] = this.activeFrames[index];
      retained += 1;
    }
    this.enemies.length = retained;
    this.orbit.length = retained;
    this.wrapDirection.length = retained;
    this.activeFrames.length = retained;
  }

  hasPlayerWrapIntent(enemy: EnemyState): boolean {
    const index = this.enemies.indexOf(enemy);
    return index >= 0
      && this.activeFrames[index] >= 2
      && this.orbit[index] >= ChainContactIntentTracker.MIN_PLAYER_ORBIT;
  }
}
