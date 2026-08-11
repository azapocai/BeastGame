import { Color, Graphics } from 'cc';
import { EnemyState } from './ArenaModel';
import { IronBallTether, TetherSnapshot, TurntableTether } from './TetherSystem';

/** Placeholder vector presentation. Replaceable with repeated chain sprites later. */
export class TetherRenderer {
  static drawChain(g: Graphics, snapshot: TetherSnapshot, ox = 0, oy = 0): void {
    g.fillColor = snapshot.tension > 0.72 ? new Color(240, 194, 107) : new Color(81, 76, 70);
    for (let segment = 0; segment < snapshot.points.length - 1; segment += 1) {
      const start = snapshot.points[segment];
      const end = snapshot.points[segment + 1];
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
    g.fillColor = tether.hitPulse > 0 ? new Color(255, 240, 179) : new Color(62, 63, 67);
    g.strokeColor = new Color(17, 18, 22);
    g.lineWidth = 5;
    g.circle(tether.x + ox, tether.y + oy, tether.radius + (tether.hitPulse > 0 ? 3 : 0));
    g.fill();
    g.stroke();
  }

  static drawTurntable(g: Graphics, tether: TurntableTether, ox = 0, oy = 0): void {
    const anchor = tether.getAnchorPosition();
    g.strokeColor = new Color(73, 56, 42);
    g.lineWidth = 18;
    g.moveTo(tether.centerX + ox, tether.centerY + oy);
    g.lineTo(anchor.x + ox, anchor.y + oy);
    g.stroke();

    g.fillColor = new Color(103, 86, 67);
    g.strokeColor = new Color(51, 42, 34);
    g.lineWidth = 5;
    g.circle(tether.centerX + ox, tether.centerY + oy, tether.hubRadius);
    g.fill();
    g.stroke();

    g.fillColor = tether.hitPulse > 0 ? new Color(255, 224, 151) : new Color(190, 138, 72);
    g.circle(anchor.x + ox, anchor.y + oy, tether.endpointRadius + (tether.hitPulse > 0 ? 3 : 0));
    g.fill();
    g.stroke();
  }

  static drawSnare(g: Graphics, enemy: EnemyState, ox = 0, oy = 0): void {
    const phase = enemy.snareTimer * 5;
    g.fillColor = new Color(183, 193, 255, 220);
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
      ? new Color(255, 70, 70, 210)
      : new Color(40, 160, 230, 150);
    g.lineWidth = 2;
    g.moveTo(player.x + ox, player.y + oy);
    g.lineTo(anchor.x + ox, anchor.y + oy);
    g.stroke();
    g.circle(anchor.x + ox, anchor.y + oy, snapshot.maxLength);
    g.stroke();

    g.fillColor = new Color(40, 160, 230, 210);
    g.circle(anchor.x + ox, anchor.y + oy, 7);
    g.fill();
  }
}
