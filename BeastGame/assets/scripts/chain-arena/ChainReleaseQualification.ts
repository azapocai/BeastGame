import { CHAIN_FULL_TENSION, EnemyState } from './ArenaModel';

export type ChainReleaseBlockReason = 'angle' | 'orbit' | 'tension' | 'ready';

/**
 * One frame's authoritative automatic-release decision for one real contact.
 * The object is pooled by ChainSimulation and must be treated as read-only by
 * presentation consumers.
 */
export interface ChainReleaseQualification {
  enemy: EnemyState;
  contactAngle: number;
  playerOrbit: number;
  tension: number;
  contactReady: boolean;
  angleReady: boolean;
  orbitReady: boolean;
  tensionReady: boolean;
  canRelease: boolean;
  blockReason: ChainReleaseBlockReason;
}

export function updateChainReleaseQualification(
  target: ChainReleaseQualification,
  enemy: EnemyState,
  contactAngle: number,
  playerOrbit: number,
  tension: number,
  minimumContactAngle: number,
  minimumPlayerOrbit: number,
): void {
  target.enemy = enemy;
  target.contactAngle = contactAngle;
  target.playerOrbit = playerOrbit;
  target.tension = tension;
  target.contactReady = true;
  target.angleReady = contactAngle >= minimumContactAngle;
  target.orbitReady = playerOrbit >= minimumPlayerOrbit;
  target.tensionReady = tension >= CHAIN_FULL_TENSION;
  target.canRelease = target.contactReady
    && target.angleReady
    && target.orbitReady
    && target.tensionReady;
  target.blockReason = !target.angleReady
    ? 'angle'
    : !target.orbitReady
      ? 'orbit'
      : !target.tensionReady
        ? 'tension'
        : 'ready';
}
