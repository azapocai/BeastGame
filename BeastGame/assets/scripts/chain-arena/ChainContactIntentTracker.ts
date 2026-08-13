import { EnemyState } from './ArenaModel';
import { Point2D } from './Math2D';

/**
 * Separates a real player-driven wrap from an enemy merely touching a taut
 * chain. This is an intent gate only; the authoritative 45-degree geometry
 * and full-tension thresholds remain in ChainSimulation.
 */
export class ChainContactIntentTracker {
  private static readonly MIN_PLAYER_ORBIT = Math.PI * (8 / 180);
  private static readonly MIN_PLAYER_PATH_TURN = Math.PI * (6 / 180);

  private readonly enemies: EnemyState[] = [];
  private readonly orbit: number[] = [];
  private readonly wrapDirection: number[] = [];
  private readonly activeFrames: number[] = [];
  private readonly previousEnemyX: number[] = [];
  private readonly previousEnemyY: number[] = [];
  private readonly previousSweepMagnitude: number[] = [];
  private readonly previousMotionX: number[] = [];
  private readonly previousMotionY: number[] = [];
  private readonly pathTurn: number[] = [];
  private readonly seen: EnemyState[] = [];

  reset(): void {
    this.enemies.length = 0;
    this.orbit.length = 0;
    this.wrapDirection.length = 0;
    this.activeFrames.length = 0;
    this.previousEnemyX.length = 0;
    this.previousEnemyY.length = 0;
    this.previousSweepMagnitude.length = 0;
    this.previousMotionX.length = 0;
    this.previousMotionY.length = 0;
    this.pathTurn.length = 0;
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
      this.previousEnemyX.push(enemy.x);
      this.previousEnemyY.push(enemy.y);
      this.previousSweepMagnitude.push(Math.abs(signedContactSweep));
      const motionLength = Math.hypot(playerDrivenMotion.x, playerDrivenMotion.y);
      this.previousMotionX.push(motionLength > 0.0001 ? playerDrivenMotion.x / motionLength : 0);
      this.previousMotionY.push(motionLength > 0.0001 ? playerDrivenMotion.y / motionLength : 0);
      this.pathTurn.push(0);
      return;
    }
    this.activeFrames[index] += 1;
    const contactDirection = Math.sign(signedContactSweep);
    if (contactDirection !== 0 && contactDirection !== this.wrapDirection[index]) {
      // Crossing to the other side is a new wrap attempt. Progress from the
      // previous bend must never be carried across the straight configuration.
      this.wrapDirection[index] = contactDirection;
      this.orbit[index] = 0;
      this.pathTurn[index] = 0;
    }
    const sweepMagnitude = Math.abs(signedContactSweep);
    const sweepChange = sweepMagnitude - this.previousSweepMagnitude[index];
    // Stored player intent cannot outlive the geometry it created. If the
    // actual body wrap is opening while both actors travel together, remove
    // the same angular amount from the old intent. Enemy-driven increases are
    // deliberately ignored and can never manufacture player intent.
    if (sweepChange < 0) this.orbit[index] = Math.max(0, this.orbit[index] + sweepChange);
    this.previousSweepMagnitude[index] = sweepMagnitude;
    if (playerDrivenMotion.x === 0 && playerDrivenMotion.y === 0) {
      this.previousEnemyX[index] = enemy.x;
      this.previousEnemyY[index] = enemy.y;
      return;
    }
    const previousAngle = Math.atan2(
      player.y - playerDrivenMotion.y - this.previousEnemyY[index],
      player.x - playerDrivenMotion.x - this.previousEnemyX[index],
    );
    const currentAngle = Math.atan2(player.y - enemy.y, player.x - enemy.x);
    let delta = currentAngle - previousAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    // The contact sweep is ordered ball -> player. Intent is earned only by
    // the overlap of two facts in the same frame: the player moves around the
    // enemy in the contact direction, and the real body wrap becomes deeper.
    // Straight pursuit/parallel travel may change the relative polar angle,
    // while enemy motion or PBD projection may deepen the bend, but neither
    // signal is allowed to manufacture intent on its own.
    const directedDelta = delta * this.wrapDirection[index];
    if (directedDelta > 0 && sweepChange > 0) {
      const motionLength = Math.hypot(playerDrivenMotion.x, playerDrivenMotion.y);
      const motionX = playerDrivenMotion.x / motionLength;
      const motionY = playerDrivenMotion.y / motionLength;
      const previousMotionLength = Math.hypot(this.previousMotionX[index], this.previousMotionY[index]);
      if (previousMotionLength > 0.0001) {
        const headingDot = Math.max(-1, Math.min(1,
          this.previousMotionX[index] * motionX + this.previousMotionY[index] * motionY));
        this.pathTurn[index] = Math.min(Math.PI * 2,
          this.pathTurn[index] + Math.acos(headingDot));
      }
      this.orbit[index] = Math.min(
        Math.PI * 2,
        this.orbit[index] + Math.min(directedDelta, sweepChange),
      );
    } else if (directedDelta < 0) {
      this.orbit[index] = Math.max(0, this.orbit[index] + directedDelta);
    }
    const motionLength = Math.hypot(playerDrivenMotion.x, playerDrivenMotion.y);
    this.previousMotionX[index] = playerDrivenMotion.x / motionLength;
    this.previousMotionY[index] = playerDrivenMotion.y / motionLength;
    this.previousEnemyX[index] = enemy.x;
    this.previousEnemyY[index] = enemy.y;
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
      this.previousEnemyX[retained] = this.previousEnemyX[index];
      this.previousEnemyY[retained] = this.previousEnemyY[index];
      this.previousSweepMagnitude[retained] = this.previousSweepMagnitude[index];
      this.previousMotionX[retained] = this.previousMotionX[index];
      this.previousMotionY[retained] = this.previousMotionY[index];
      this.pathTurn[retained] = this.pathTurn[index];
      retained += 1;
    }
    this.enemies.length = retained;
    this.orbit.length = retained;
    this.wrapDirection.length = retained;
    this.activeFrames.length = retained;
    this.previousEnemyX.length = retained;
    this.previousEnemyY.length = retained;
    this.previousSweepMagnitude.length = retained;
    this.previousMotionX.length = retained;
    this.previousMotionY.length = retained;
    this.pathTurn.length = retained;
  }

  hasPlayerWrapIntent(enemy: EnemyState): boolean {
    const index = this.enemies.indexOf(enemy);
    return index >= 0
      && this.activeFrames[index] >= 2
      && this.orbit[index] >= ChainContactIntentTracker.MIN_PLAYER_ORBIT
      && this.pathTurn[index] >= ChainContactIntentTracker.MIN_PLAYER_PATH_TURN;
  }
}
