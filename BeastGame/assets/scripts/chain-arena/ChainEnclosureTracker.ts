import { EnemyState } from './ArenaModel';
import { ChainPerformanceBudget } from './ChainPerformanceBudget';

/** Two-publication enclosure hysteresis with fixed enemy-budget arrays. */
export class ChainEnclosureTracker {
  readonly candidates: EnemyState[] = [];
  private readonly tracked: EnemyState[] = [];
  private readonly stableFrames: number[] = [];
  private readonly seen: EnemyState[] = [];

  reset(): void {
    this.candidates.length = 0;
    this.tracked.length = 0;
    this.stableFrames.length = 0;
    this.seen.length = 0;
  }

  beginFrame(): void {
    this.candidates.length = 0;
    this.seen.length = 0;
  }

  observeInside(enemy: EnemyState): void {
    this.seen.push(enemy);
    let index = this.tracked.indexOf(enemy);
    if (index < 0) {
      index = this.tracked.length;
      this.tracked.push(enemy);
      this.stableFrames.push(1);
    } else {
      this.stableFrames[index] = Math.min(
        ChainPerformanceBudget.enclosureStableSteps,
        this.stableFrames[index] + 1,
      );
    }
    if (this.stableFrames[index] >= ChainPerformanceBudget.enclosureStableSteps) {
      this.candidates.push(enemy);
    }
  }

  endFrame(): void {
    let retained = 0;
    for (let index = 0; index < this.tracked.length; index += 1) {
      const enemy = this.tracked[index];
      if (this.seen.indexOf(enemy) < 0) continue;
      this.tracked[retained] = enemy;
      this.stableFrames[retained] = this.stableFrames[index];
      retained += 1;
    }
    this.tracked.length = retained;
    this.stableFrames.length = retained;
  }
}
