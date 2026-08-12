import { EnemyState } from './ArenaModel';
import { ContinuousCircleContact } from './ChainContactSolver';

export interface OrderedChainContact {
  topologyId: number;
  enemy: EnemyState;
  geometry: ContinuousCircleContact;
}

/** Keeps contact order independent from the source enemy-array order. */
export class ChainContactTopology<T extends OrderedChainContact> {
  private readonly ordered: T[] = [];
  private nextId = 1;

  get items(): readonly T[] {
    return this.ordered;
  }

  allocateId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  reset(): void {
    this.ordered.length = 0;
    this.nextId = 1;
  }

  replace(items: readonly T[]): void {
    this.ordered.length = 0;
    for (const item of items) this.ordered.push(item);
  }

  insertAt(item: T, index: number): void {
    this.ordered.splice(Math.max(0, Math.min(index, this.ordered.length)), 0, item);
  }

  remove(item: T): boolean {
    const index = this.ordered.indexOf(item);
    if (index < 0) return false;
    this.ordered.splice(index, 1);
    return true;
  }

  hasEnemy(enemy: EnemyState): boolean {
    return this.ordered.some((item) => item.enemy === enemy);
  }
}
