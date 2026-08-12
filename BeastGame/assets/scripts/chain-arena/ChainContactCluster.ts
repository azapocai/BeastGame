import { CircleBody } from './ChainContactSolver';

export interface ClusterMember {
  enemy: CircleBody;
}

/**
 * Detects contacts that have no usable chain corridor. Geometry is delegated
 * to ChainClusterBoundarySolver; this module only owns the cheap membership
 * threshold and its release hysteresis.
 */
export class ChainContactCluster {
  static needsBoundary(
    contacts: readonly ClusterMember[],
    padding: number,
    releaseHysteresis = 0,
  ): boolean {
    if (contacts.length < 2) return false;
    for (let left = 0; left < contacts.length; left += 1) {
      for (let right = left + 1; right < contacts.length; right += 1) {
        const a = contacts[left].enemy;
        const b = contacts[right].enemy;
        const corridor = a.radius + b.radius + padding * 2 + releaseHysteresis + 0.01;
        if (Math.hypot(a.x - b.x, a.y - b.y) <= corridor) return true;
      }
    }
    return false;
  }
}
