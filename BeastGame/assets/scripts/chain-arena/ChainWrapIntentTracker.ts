import { EnemyState } from './ArenaModel';
import { Point2D } from './Math2D';

interface WrapIntentState {
  enemy: EnemyState;
  direction: number;
  playerOrbit: number;
  missedContactFrames: number;
  previousPlayerX: number;
  previousPlayerY: number;
  previousEnemyX: number;
  previousEnemyY: number;
  entryMotionX: number;
  entryMotionY: number;
  curvedPath: boolean;
}

/**
 * Tracks only player-authored relative orbit around currently contacted
 * enemies. Contact angle and tension remain authoritative in ChainSimulation.
 */
export class ChainWrapIntentTracker {
  static readonly MIN_PLAYER_ORBIT = Math.PI * (45 / 180);
  private static readonly CONTACT_GRACE_FRAMES = 2;
  private static readonly MAX_PLAYER_ORBIT = Math.PI * 2;
  private static readonly ANGLE_EPSILON = 1e-5;
  private static readonly MIN_HEADING_DEPARTURE = Math.PI * (6 / 180);
  private static readonly MIN_HEADING_DOT = Math.cos(ChainWrapIntentTracker.MIN_HEADING_DEPARTURE);

  private readonly states: WrapIntentState[] = [];
  private readonly freeStates: WrapIntentState[] = [];
  private readonly seen: EnemyState[] = [];

  reset(): void {
    for (const state of this.states) this.freeStates.push(state);
    this.states.length = 0;
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
    let index = this.findState(enemy);
    if (index < 0) {
      index = this.states.length;
      const state = this.freeStates.pop() || {
        enemy,
        direction: 0,
        playerOrbit: 0,
        missedContactFrames: 0,
        previousPlayerX: 0,
        previousPlayerY: 0,
        previousEnemyX: 0,
        previousEnemyY: 0,
        entryMotionX: 0,
        entryMotionY: 0,
        curvedPath: false,
      };
      state.enemy = enemy;
      state.direction = Math.sign(signedContactSweep);
      state.playerOrbit = 0;
      state.missedContactFrames = 0;
      state.previousPlayerX = player.x;
      state.previousPlayerY = player.y;
      state.previousEnemyX = enemy.x;
      state.previousEnemyY = enemy.y;
      const initialMotionLength = Math.hypot(playerDrivenMotion.x, playerDrivenMotion.y);
      state.entryMotionX = initialMotionLength > ChainWrapIntentTracker.ANGLE_EPSILON
        ? playerDrivenMotion.x / initialMotionLength
        : 0;
      state.entryMotionY = initialMotionLength > ChainWrapIntentTracker.ANGLE_EPSILON
        ? playerDrivenMotion.y / initialMotionLength
        : 0;
      state.curvedPath = false;
      this.states.push(state);
      return;
    }

    const state = this.states[index];
    state.missedContactFrames = 0;
    const contactDirection = Math.sign(signedContactSweep);
    if (state.direction === 0 && contactDirection !== 0) state.direction = contactDirection;
    const motionLength = Math.hypot(playerDrivenMotion.x, playerDrivenMotion.y);
    let motionX = 0;
    let motionY = 0;
    if (motionLength > ChainWrapIntentTracker.ANGLE_EPSILON) {
      motionX = playerDrivenMotion.x / motionLength;
      motionY = playerDrivenMotion.y / motionLength;
      const entryMotionLength = Math.hypot(state.entryMotionX, state.entryMotionY);
      if (entryMotionLength <= ChainWrapIntentTracker.ANGLE_EPSILON) {
        state.entryMotionX = motionX;
        state.entryMotionY = motionY;
      } else if (state.entryMotionX * motionX + state.entryMotionY * motionY
        <= ChainWrapIntentTracker.MIN_HEADING_DOT) {
        state.curvedPath = true;
      }
    }

    const previousRelativeAngle = Math.atan2(
      state.previousPlayerY - state.previousEnemyY,
      state.previousPlayerX - state.previousEnemyX,
    );
    const currentRelativeAngle = Math.atan2(player.y - enemy.y, player.x - enemy.x);
    const playerOnlyAngle = Math.atan2(
      state.previousPlayerY + playerDrivenMotion.y - state.previousEnemyY,
      state.previousPlayerX + playerDrivenMotion.x - state.previousEnemyX,
    );
    const actualDelta = this.normalizeAngle(currentRelativeAngle - previousRelativeAngle);
    const playerDelta = this.normalizeAngle(playerOnlyAngle - previousRelativeAngle);

    // Equal player/enemy translation has no actual relative angle. Enemy-only
    // motion has no player-authored angle. Only their same-signed overlap can
    // add or remove active orbit evidence.
    if (Math.abs(actualDelta) > ChainWrapIntentTracker.ANGLE_EPSILON
      && Math.abs(playerDelta) > ChainWrapIntentTracker.ANGLE_EPSILON
      && Math.sign(actualDelta) === Math.sign(playerDelta)) {
      const playerAuthoredDelta = Math.sign(actualDelta)
        * Math.min(Math.abs(actualDelta), Math.abs(playerDelta));
      const directedDelta = playerAuthoredDelta * state.direction;
      state.playerOrbit = Math.max(0, Math.min(
        ChainWrapIntentTracker.MAX_PLAYER_ORBIT,
        state.playerOrbit + directedDelta,
      ));
    }

    // A genuine reversal must first unwind the old net orbit. Only after it
    // reaches zero may the opposite contact direction start a new attempt.
    if (state.playerOrbit <= ChainWrapIntentTracker.ANGLE_EPSILON
      && contactDirection !== 0
      && contactDirection !== state.direction) {
      state.direction = contactDirection;
      state.playerOrbit = 0;
      state.entryMotionX = motionX;
      state.entryMotionY = motionY;
      state.curvedPath = false;
    }
    this.rememberPositions(state, player);
  }

  endFrame(player: Point2D): void {
    let retained = 0;
    for (let index = 0; index < this.states.length; index += 1) {
      const state = this.states[index];
      if (this.seen.indexOf(state.enemy) < 0) {
        state.missedContactFrames += 1;
        if (state.missedContactFrames > ChainWrapIntentTracker.CONTACT_GRACE_FRAMES) {
          this.freeStates.push(state);
          continue;
        }
        // Do not accumulate motion while contact is absent and do not create a
        // jump when it returns. The grace period preserves only prior evidence.
        this.rememberPositions(state, player);
      }
      this.states[retained] = state;
      retained += 1;
    }
    this.states.length = retained;
  }

  getPlayerOrbit(enemy: EnemyState, signedContactSweep: number): number {
    const index = this.findState(enemy);
    if (index < 0) return 0;
    const state = this.states[index];
    const contactDirection = Math.sign(signedContactSweep);
    if (!state.curvedPath || contactDirection === 0 || contactDirection !== state.direction) return 0;
    return state.playerOrbit;
  }

  hasPlayerWrapIntent(enemy: EnemyState, signedContactSweep: number): boolean {
    return this.getPlayerOrbit(enemy, signedContactSweep)
      >= ChainWrapIntentTracker.MIN_PLAYER_ORBIT;
  }

  private findState(enemy: EnemyState): number {
    for (let index = 0; index < this.states.length; index += 1) {
      if (this.states[index].enemy === enemy) return index;
    }
    return -1;
  }

  private rememberPositions(state: WrapIntentState, player: Point2D): void {
    state.previousPlayerX = player.x;
    state.previousPlayerY = player.y;
    state.previousEnemyX = state.enemy.x;
    state.previousEnemyY = state.enemy.y;
  }

  private normalizeAngle(angle: number): number {
    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;
    return angle;
  }
}
