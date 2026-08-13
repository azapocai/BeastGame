import { Color, Graphics } from 'cc';
import { EnemyState } from './ArenaModel';
import { IronBallTether, TetherSnapshot, TurntableTether } from './TetherSystem';
import { ChainRouteSnapshot } from './ChainRouteSnapshot';

const TETHER_COLORS = Object.freeze({
  slack: new Color(81, 76, 70),
  tense: new Color(240, 194, 107),
  ballHit: new Color(255, 240, 179),
  ball: new Color(62, 63, 67),
  ballStroke: new Color(17, 18, 22),
  turntableRod: new Color(73, 56, 42),
  turntableHub: new Color(103, 86, 67),
  turntableStroke: new Color(51, 42, 34),
  turntableHit: new Color(255, 224, 151),
  turntableEndpoint: new Color(190, 138, 72),
  snare: new Color(183, 193, 255, 220),
  debugTaut: new Color(255, 70, 70, 210),
  debugSlack: new Color(40, 160, 230, 150),
  debugAnchor: new Color(40, 160, 230, 210),
});

/** Placeholder vector presentation. Replaceable with repeated chain sprites later. */
export class TetherRenderer {
  static drawChainSnapshot(g: Graphics, snapshot: ChainRouteSnapshot, ox = 0, oy = 0): void {
    this.drawChainPoints(g, snapshot.points, snapshot.tension, ox, oy);
  }

  /** Redraws contact arcs after actors when sprite assets are unavailable. */
  static drawContactForeground(g: Graphics, snapshot: ChainRouteSnapshot, ox = 0, oy = 0): void {
    if (snapshot.contacts.length === 0) return;
    g.fillColor = snapshot.tension > 0.72 ? TETHER_COLORS.tense : TETHER_COLORS.slack;
    let previousStart = -1;
    let previousEnd = -1;
    for (const contact of snapshot.contacts) {
      const start = Math.max(0, contact.pointStart - 1);
      const end = Math.min(snapshot.points.length - 1, contact.pointEnd + 1);
      if (start === previousStart && end === previousEnd) continue;
      previousStart = start;
      previousEnd = end;
      for (let segment = start; segment < end; segment += 1) {
        const from = snapshot.points[segment];
        const to = snapshot.points[segment + 1];
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const distance = Math.hypot(dx, dy);
        const links = Math.max(2, Math.floor(distance / 15));
        for (let index = 1; index < links; index += 1) {
          const t = index / links;
          g.circle(from.x + dx * t + ox, from.y + dy * t + oy, 4);
          g.fill();
        }
      }
    }
  }

  private static drawChainPoints(
    g: Graphics,
    points: readonly { x: number; y: number }[],
    tension: number,
    ox: number,
    oy: number,
  ): void {
    g.fillColor = tension > 0.72 ? TETHER_COLORS.tense : TETHER_COLORS.slack;
    for (let segment = 0; segment < points.length - 1; segment += 1) {
      const start = points[segment];
      const end = points[segment + 1];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const distance = Math.hypot(dx, dy);
      const links = Math.max(2, Math.floor(distance / 15));
      for (let index = 1; index < links; index += 1) {
        const t = index / links;
        g.circle(start.x + dx * t + ox, start.y + dy * t + oy, 4);
        g.fill();
      }
    }
  }

  static drawIronBall(g: Graphics, tether: IronBallTether, ox = 0, oy = 0): void {
    g.fillColor = tether.hitPulse > 0 ? TETHER_COLORS.ballHit : TETHER_COLORS.ball;
    g.strokeColor = TETHER_COLORS.ballStroke;
    g.lineWidth = 5;
    g.circle(tether.x + ox, tether.y + oy, tether.radius + (tether.hitPulse > 0 ? 3 : 0));
    g.fill();
    g.stroke();
  }

  static drawTurntable(g: Graphics, tether: TurntableTether, ox = 0, oy = 0): void {
    const anchor = tether.getAnchorPosition();
    g.strokeColor = TETHER_COLORS.turntableRod;
    g.lineWidth = 18;
    g.moveTo(tether.centerX + ox, tether.centerY + oy);
    g.lineTo(anchor.x + ox, anchor.y + oy);
    g.stroke();

    g.fillColor = TETHER_COLORS.turntableHub;
    g.strokeColor = TETHER_COLORS.turntableStroke;
    g.lineWidth = 5;
    g.circle(tether.centerX + ox, tether.centerY + oy, tether.hubRadius);
    g.fill();
    g.stroke();

    g.fillColor = tether.hitPulse > 0 ? TETHER_COLORS.turntableHit : TETHER_COLORS.turntableEndpoint;
    g.circle(anchor.x + ox, anchor.y + oy, tether.endpointRadius + (tether.hitPulse > 0 ? 3 : 0));
    g.fill();
    g.stroke();
  }

  static drawSnare(g: Graphics, enemy: EnemyState, ox = 0, oy = 0): void {
    const phase = enemy.snareTimer * 5;
    g.fillColor = TETHER_COLORS.snare;
    for (let index = 0; index < 3; index += 1) {
      const angle = phase + index / 3 * Math.PI * 2;
      g.circle(enemy.x + Math.cos(angle) * 13 + ox, enemy.y + enemy.radius + 17 + Math.sin(angle) * 4 + oy, 3.5);
      g.fill();
    }
  }

  static drawDebug(g: Graphics, snapshot: TetherSnapshot, ox = 0, oy = 0): void {
    const player = snapshot.points[0];
    const anchor = snapshot.points[snapshot.points.length - 1];
    g.strokeColor = snapshot.currentLength >= snapshot.maxLength - 0.5
      ? TETHER_COLORS.debugTaut
      : TETHER_COLORS.debugSlack;
    g.lineWidth = 2;
    g.moveTo(player.x + ox, player.y + oy);
    g.lineTo(anchor.x + ox, anchor.y + oy);
    g.stroke();
    g.circle(anchor.x + ox, anchor.y + oy, snapshot.maxLength);
    g.stroke();

    g.fillColor = TETHER_COLORS.debugAnchor;
    g.circle(anchor.x + ox, anchor.y + oy, 7);
    g.fill();
  }
}
