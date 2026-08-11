import {
  _decorator, Color, Component, Graphics, Label, Layers, Node, UITransform, Vec2,
} from 'cc';
import {
  BarrelState, Bounds, EnemyState, MELEE_ATTACK_RANGE, PlayerState, ROOM_DEFINITIONS,
} from './ArenaModel';
import { InputRouter } from './InputRouter';
import { CircleCollisionSolver } from './CircleCollisionSolver';
import { Math2D } from './Math2D';
import { IronBallTether, TurntableTether } from './TetherSystem';
import { TetherRenderer } from './TetherRenderer';
import { ChainSnareSystem } from './ChainSnareSystem';

const { ccclass } = _decorator;

interface ExplosionEffect {
  x: number;
  y: number;
  age: number;
  duration: number;
  radius: number;
}

const LOGICAL_WIDTH = 960;
const LOGICAL_HEIGHT = 600;
const BOUNDS: Bounds = { left: -446, right: 446, bottom: -258, top: 258 };

/** Owns the arena simulation, presentation, and room flow. */
@ccclass('ChainArenaController')
export class ChainArenaController extends Component {
  private graphics!: Graphics;
  private hud!: Label;
  private status!: Label;
  private help!: Label;
  private input = new InputRouter();

  private roomIndex = 0;
  private player = new PlayerState();
  private enemies: EnemyState[] = [];
  private barrels: BarrelState[] = [];
  private ironBall: IronBallTether | null = null;
  private turntable: TurntableTether | null = null;
  private snare = new ChainSnareSystem();
  private effects: ExplosionEffect[] = [];
  private state: 'playing' | 'transition' | 'lost' | 'won' = 'playing';
  private stateTimer = 0;
  private shake = 0;
  private debugTether = false;

  protected onLoad(): void {
    this.createVisuals();
    this.input.enable();
    this.startRun();
  }

  protected onDestroy(): void {
    this.input.disable();
  }

  protected update(deltaTime: number): void {
    const dt = Math.min(0.033, Math.max(0, deltaTime));
    const actions = this.input.consumeActions();
    if (actions.restart) this.startRun();
    if (actions.toggleDebug) this.debugTether = !this.debugTether;

    if (this.state === 'playing') this.updatePlaying(dt, actions.attack, actions.dash, actions.pullTether);
    else if (this.state === 'transition') {
      this.stateTimer -= dt;
      if (this.stateTimer <= 0) this.loadRoom(this.roomIndex + 1);
    }

    for (const effect of this.effects) effect.age += dt;
    this.effects = this.effects.filter((effect) => effect.age < effect.duration);
    this.shake = Math.max(0, this.shake - dt * 34);
    this.draw();
  }

  private createVisuals(): void {
    const renderer = new Node('ArenaRenderer');
    renderer.setParent(this.node);
    renderer.layer = Layers.Enum.UI_2D;
    const transform = renderer.addComponent(UITransform);
    transform.setContentSize(LOGICAL_WIDTH, LOGICAL_HEIGHT);
    transform.setAnchorPoint(0.5, 0.5);
    this.graphics = renderer.addComponent(Graphics);

    this.hud = this.createLabel('Hud', new Vec2(-430, 265), 18, new Color(247, 233, 205));
    this.status = this.createLabel('Status', new Vec2(0, 265), 18, new Color(255, 208, 111), true);
    this.help = this.createLabel('Help', new Vec2(0, -282), 13, new Color(95, 67, 43), true);
    this.help.string = 'WASD / 方向键移动 · 鼠标瞄准 · 点击/空格攻击 · Shift/K 闪避 · C 拉脱锁链 · R 重开 · F2 锁链调试\n触屏：左侧拖动移动，右侧上半攻击、右下闪避';
  }

  private createLabel(name: string, position: Vec2, fontSize: number, color: Color, centered = false): Label {
    const node = new Node(name);
    node.setParent(this.node);
    node.layer = Layers.Enum.UI_2D;
    const transform = node.addComponent(UITransform);
    transform.setContentSize(centered ? 900 : 430, 54);
    transform.setAnchorPoint(centered ? 0.5 : 0, 0.5);
    node.setPosition(position.x, position.y);
    const label = node.addComponent(Label);
    label.fontSize = fontSize;
    label.lineHeight = fontSize + 6;
    label.color = color;
    label.horizontalAlign = centered ? Label.HorizontalAlign.CENTER : Label.HorizontalAlign.LEFT;
    return label;
  }

  private startRun(): void {
    this.loadRoom(0);
  }

  private loadRoom(index: number): void {
    this.roomIndex = index;
    const room = ROOM_DEFINITIONS[index];
    this.player = new PlayerState();
    if (room.playerStart) {
      this.player.x = room.playerStart.x;
      this.player.y = room.playerStart.y;
    }
    this.enemies = room.enemies.map((definition) => new EnemyState(definition));
    this.barrels = room.barrels.map((definition) => new BarrelState(definition));
    this.ironBall = room.mechanic === 'iron-ball' ? new IronBallTether(this.player) : null;
    this.turntable = room.mechanic === 'turntable' ? new TurntableTether(0, 0) : null;
    this.snare.reset();
    this.effects = [];
    this.state = 'playing';
    this.stateTimer = 0;
  }

  private updatePlaying(dt: number, attackRequested: boolean, dashRequested: boolean, pullRequested: boolean): void {
    const move = this.input.getMove();
    const aim = this.input.getAim(this.player);
    const playerFrameStartX = this.player.x;
    const playerFrameStartY = this.player.y;
    this.player.update(dt, move, aim, dashRequested, BOUNDS);

    if (this.ironBall) {
      this.ironBall.update(dt, this.player, BOUNDS);
      this.player.x = Math2D.clamp(this.player.x, BOUNDS.left + this.player.radius, BOUNDS.right - this.player.radius);
      this.player.y = Math2D.clamp(this.player.y, BOUNDS.bottom + this.player.radius, BOUNDS.top - this.player.radius);
    }
    if (this.turntable) {
      this.turntable.update(dt, this.player);
      this.player.x = Math2D.clamp(this.player.x, BOUNDS.left + this.player.radius, BOUNDS.right - this.player.radius);
      this.player.y = Math2D.clamp(this.player.y, BOUNDS.bottom + this.player.radius, BOUNDS.top - this.player.radius);
    }
    const snarePlayerMotion = {
      x: this.player.x - playerFrameStartX,
      y: this.player.y - playerFrameStartY,
    };

    if (attackRequested && this.player.tryAttack()) this.resolvePlayerAttack();
    for (const enemy of this.enemies) if (!enemy.dead) enemy.update(dt, this.player, this.enemies, BOUNDS);
    if (this.ironBall) {
      this.ironBall.applyHits(this.enemies, this.barrels, this.explodeBarrel.bind(this));
    }
    if (this.turntable) this.turntable.applyHits(this.enemies, this.barrels, this.explodeBarrel.bind(this));
    this.resolveSolidBodyCollisions();

    const tetherSnapshot = this.ironBall
      ? this.ironBall.getSnapshot(this.player)
      : this.turntable
        ? this.turntable.getSnapshot(this.player)
        : null;
    this.snare.update(dt, tetherSnapshot, this.player, this.enemies, snarePlayerMotion);
    if (pullRequested) this.snare.triggerManualPull();
    if (tetherSnapshot && this.snare.enforceRoutedLength(tetherSnapshot, this.player, this.ironBall)) {
      this.player.x = Math2D.clamp(this.player.x, BOUNDS.left + this.player.radius, BOUNDS.right - this.player.radius);
      this.player.y = Math2D.clamp(this.player.y, BOUNDS.bottom + this.player.radius, BOUNDS.top - this.player.radius);
    }
    this.resolvePlayerEnemyCollisions();

    if (this.player.health <= 0) {
      this.state = 'lost';
      return;
    }

    if (this.enemies.every((enemy) => enemy.dead)) {
      if (this.roomIndex < ROOM_DEFINITIONS.length - 1) {
        this.state = 'transition';
        this.stateTimer = 1.2;
      } else {
        this.state = 'won';
      }
    }
  }

  private resolvePlayerAttack(): void {
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const dx = enemy.x - this.player.x;
      const dy = enemy.y - this.player.y;
      const distance = Math.hypot(dx, dy);
      if (distance > MELEE_ATTACK_RANGE + enemy.radius) continue;
      const direction = Math2D.normalize(dx, dy);
      if (Math2D.dot(direction.x, direction.y, this.player.aim.x, this.player.aim.y) < 0.22) continue;
      enemy.damage(1, direction.x * 225, direction.y * 225);
    }
    for (const barrel of this.barrels) {
      if (barrel.exploded) continue;
      const dx = barrel.x - this.player.x;
      const dy = barrel.y - this.player.y;
      const distance = Math.hypot(dx, dy);
      const direction = Math2D.normalize(dx, dy);
      if (distance < 72 && Math2D.dot(direction.x, direction.y, this.player.aim.x, this.player.aim.y) > 0.3) {
        this.explodeBarrel(barrel);
      }
    }
  }

  private explodeBarrel(barrel: BarrelState): void {
    if (barrel.exploded) return;
    barrel.exploded = true;
    this.shake = 10;
    this.effects.push({ x: barrel.x, y: barrel.y, age: 0, duration: 0.48, radius: 120 });
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const dx = enemy.x - barrel.x;
      const dy = enemy.y - barrel.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 120) continue;
      const direction = Math2D.normalize(dx, dy);
      enemy.damage(3, direction.x * 430, direction.y * 430);
    }
    const playerDistance = Math.hypot(this.player.x - barrel.x, this.player.y - barrel.y);
    if (playerDistance < 92) {
      const direction = Math2D.normalize(this.player.x - barrel.x, this.player.y - barrel.y);
      this.player.damage(18, direction.x * 35, direction.y * 35);
    }
  }

  private resolvePlayerEnemyCollisions(): void {
    for (const enemy of this.enemies) {
      if (!enemy.collisionEnabled) continue;
      const dx = this.player.x - enemy.x;
      const dy = this.player.y - enemy.y;
      const distance = Math.hypot(dx, dy);
      const minimum = this.player.radius + enemy.radius;
      if (distance >= minimum) continue;
      const direction = distance > 0.001 ? { x: dx / distance, y: dy / distance } : { x: 1, y: 0 };
      this.player.x = enemy.x + direction.x * minimum;
      this.player.y = enemy.y + direction.y * minimum;
    }
  }

  /** Resolves peer bodies after AI motion and before the chain reads their positions. */
  private resolveSolidBodyCollisions(): void {
    // A ball can push one enemy into another. Two short passes settle that
    // interaction without introducing a general-purpose physics simulation.
    for (let iteration = 0; iteration < 2; iteration += 1) {
      if (this.ironBall) this.ironBall.resolveBodyCollisions(this.player, this.enemies, BOUNDS);
      this.resolveEnemyEnemyCollisions();
    }
  }

  private resolveEnemyEnemyCollisions(): void {
    for (let firstIndex = 0; firstIndex < this.enemies.length - 1; firstIndex += 1) {
      const first = this.enemies[firstIndex];
      if (first.dead || !first.collisionEnabled) continue;
      for (let secondIndex = firstIndex + 1; secondIndex < this.enemies.length; secondIndex += 1) {
        const second = this.enemies[secondIndex];
        if (second.dead || !second.collisionEnabled) continue;
        const fallback = (firstIndex + secondIndex) % 2 === 0 ? { x: 1, y: 0 } : { x: 0, y: 1 };
        if (!CircleCollisionSolver.separatePair(first, second, fallback)) continue;
        first.x = Math2D.clamp(first.x, BOUNDS.left + first.radius, BOUNDS.right - first.radius);
        first.y = Math2D.clamp(first.y, BOUNDS.bottom + first.radius, BOUNDS.top - first.radius);
        second.x = Math2D.clamp(second.x, BOUNDS.left + second.radius, BOUNDS.right - second.radius);
        second.y = Math2D.clamp(second.y, BOUNDS.bottom + second.radius, BOUNDS.top - second.radius);
      }
    }
  }

  private draw(): void {
    const g = this.graphics;
    g.clear();
    const shakeX = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    const shakeY = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    this.drawArena(g, shakeX, shakeY);
    if (this.turntable) TetherRenderer.drawTurntable(g, this.turntable, shakeX, shakeY);
    if (this.ironBall) {
      const snapshot = this.ironBall.getSnapshot(this.player);
      TetherRenderer.drawChain(g, this.snare.getVisualSnapshot(snapshot), shakeX, shakeY);
    }
    if (this.turntable) {
      const snapshot = this.turntable.getSnapshot(this.player);
      TetherRenderer.drawChain(g, this.snare.getVisualSnapshot(snapshot), shakeX, shakeY);
    }
    for (const barrel of this.barrels) this.drawBarrel(g, barrel, shakeX, shakeY);
    for (const enemy of this.enemies) if (!enemy.dead) this.drawEnemy(g, enemy, shakeX, shakeY);
    for (const enemy of this.enemies) if (!enemy.dead && enemy.snareTimer > 0) TetherRenderer.drawSnare(g, enemy, shakeX, shakeY);
    this.drawPlayer(g, shakeX, shakeY);
    if (this.ironBall) TetherRenderer.drawIronBall(g, this.ironBall, shakeX, shakeY);
    if (this.debugTether && this.ironBall) TetherRenderer.drawDebug(g, this.ironBall.getSnapshot(this.player), shakeX, shakeY);
    if (this.debugTether && this.turntable) TetherRenderer.drawDebug(g, this.turntable.getSnapshot(this.player), shakeX, shakeY);
    this.drawEffects(g, shakeX, shakeY);
    this.drawTouchHints(g);
    this.updateLabels();
  }

  private drawArena(g: Graphics, ox: number, oy: number): void {
    g.fillColor = new Color(218, 205, 177);
    g.rect(-480 + ox, -300 + oy, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    g.fill();
    g.strokeColor = new Color(111, 85, 57, 50);
    g.lineWidth = 1;
    for (let x = -410; x < 430; x += 72) {
      g.moveTo(x + ox, BOUNDS.bottom + oy);
      g.lineTo(x - 18 + ox, BOUNDS.top + oy);
      g.stroke();
    }
    for (let y = -230; y < 250; y += 64) {
      g.moveTo(BOUNDS.left + ox, y + oy);
      g.lineTo(BOUNDS.right + ox, y + 12 + oy);
      g.stroke();
    }
    g.strokeColor = new Color(93, 71, 49);
    g.lineWidth = 12;
    g.rect(BOUNDS.left + ox, BOUNDS.bottom + oy, BOUNDS.right - BOUNDS.left, BOUNDS.top - BOUNDS.bottom);
    g.stroke();
  }

  private drawPlayer(g: Graphics, ox: number, oy: number): void {
    const player = this.player;
    if (player.attackFlash > 0) {
      const angle = Math.atan2(player.aim.y, player.aim.x);
      g.fillColor = new Color(255, 209, 118, 96);
      g.moveTo(player.x + ox, player.y + oy);
      g.arc(player.x + ox, player.y + oy, 68, angle - 0.72, angle + 0.72, false);
      g.close();
      g.fill();
    }
    g.fillColor = player.hitFlash > 0 ? new Color(255, 244, 222) : new Color(45, 143, 152);
    g.strokeColor = new Color(23, 61, 68);
    g.lineWidth = 4;
    g.circle(player.x + ox, player.y + oy, player.radius);
    g.fill();
    g.stroke();
    g.strokeColor = new Color(233, 216, 180);
    g.lineWidth = 8;
    g.moveTo(player.x + ox, player.y + oy);
    g.lineTo(player.x + player.aim.x * 26 + ox, player.y + player.aim.y * 26 + oy);
    g.stroke();
    if (player.fallTimer > 0) {
      g.strokeColor = new Color(238, 109, 75, 210);
      g.lineWidth = 3;
      g.moveTo(player.x - 25 + ox, player.y - 25 + oy);
      g.lineTo(player.x - 14 + ox, player.y - 14 + oy);
      g.moveTo(player.x + 25 + ox, player.y - 25 + oy);
      g.lineTo(player.x + 14 + ox, player.y - 14 + oy);
      g.stroke();
    }
  }

  private drawEnemy(g: Graphics, enemy: EnemyState, ox: number, oy: number): void {
    if (enemy.attackFlash > 0) {
      const angle = Math.atan2(enemy.attackDirection.y, enemy.attackDirection.x);
      g.fillColor = new Color(202, 68, 48, 64);
      g.moveTo(enemy.x + ox, enemy.y + oy);
      g.arc(enemy.x + ox, enemy.y + oy, MELEE_ATTACK_RANGE, angle - 0.62, angle + 0.62, false);
      g.close();
      g.fill();
    }
    g.fillColor = enemy.hitFlash > 0
      ? new Color(255, 240, 222)
      : enemy.snareTimer > 0
        ? new Color(91, 101, 188)
        : enemy.tier === 2 ? new Color(116, 46, 43) : new Color(173, 73, 55);
    g.strokeColor = new Color(75, 32, 28);
    g.lineWidth = 4;
    g.circle(enemy.x + ox, enemy.y + oy, enemy.radius);
    g.fill();
    g.stroke();
    if (enemy.tier === 2) {
      g.strokeColor = new Color(213, 178, 118);
      g.lineWidth = 5;
      g.arc(enemy.x + ox, enemy.y + oy, enemy.radius - 6, Math.PI * 0.15, Math.PI * 1.85, false);
      g.stroke();
    }
    if (enemy.canInfluenceTether) {
      const markerY = enemy.y + enemy.radius + 24;
      g.fillColor = new Color(231, 172, 63, 230);
      g.moveTo(enemy.x + ox, markerY + 7 + oy);
      g.lineTo(enemy.x + 7 + ox, markerY + oy);
      g.lineTo(enemy.x + ox, markerY - 7 + oy);
      g.lineTo(enemy.x - 7 + ox, markerY + oy);
      g.close();
      g.fill();
    }
    g.fillColor = new Color(64, 38, 30, 150);
    g.rect(enemy.x - 19 + ox, enemy.y + enemy.radius + 10 + oy, 38, 5);
    g.fill();
    g.fillColor = new Color(212, 83, 61);
    g.rect(enemy.x - 19 + ox, enemy.y + enemy.radius + 10 + oy, 38 * Math.max(0, enemy.health / enemy.maxHealth), 5);
    g.fill();
  }

  private drawBarrel(g: Graphics, barrel: BarrelState, ox: number, oy: number): void {
    if (barrel.exploded) return;
    g.fillColor = new Color(141, 58, 39);
    g.strokeColor = new Color(62, 36, 25);
    g.lineWidth = 4;
    g.roundRect(barrel.x - 15 + ox, barrel.y - 20 + oy, 30, 40, 6);
    g.fill();
    g.stroke();
    g.strokeColor = new Color(208, 155, 74);
    g.lineWidth = 3;
    g.moveTo(barrel.x - 14 + ox, barrel.y - 9 + oy);
    g.lineTo(barrel.x + 14 + ox, barrel.y - 9 + oy);
    g.moveTo(barrel.x - 14 + ox, barrel.y + 9 + oy);
    g.lineTo(barrel.x + 14 + ox, barrel.y + 9 + oy);
    g.stroke();
  }

  private drawEffects(g: Graphics, ox: number, oy: number): void {
    for (const effect of this.effects) {
      const t = effect.age / effect.duration;
      g.fillColor = new Color(241, 138, 48, Math.round((1 - t) * 180));
      g.circle(effect.x + ox, effect.y + oy, effect.radius * (0.2 + t * 0.8));
      g.fill();
    }
  }

  private drawTouchHints(g: Graphics): void {
    const stick = this.input.getJoystick();
    if (stick.active) {
      g.strokeColor = new Color(56, 44, 33, 110);
      g.lineWidth = 4;
      g.circle(stick.origin.x, stick.origin.y, 54);
      g.stroke();
      const offset = Math2D.normalize(stick.position.x - stick.origin.x, stick.position.y - stick.origin.y);
      const distance = Math.min(46, Math.hypot(stick.position.x - stick.origin.x, stick.position.y - stick.origin.y));
      g.fillColor = new Color(213, 161, 88, 140);
      g.circle(stick.origin.x + offset.x * distance, stick.origin.y + offset.y * distance, 22);
      g.fill();
    }
    g.fillColor = new Color(73, 55, 38, 45);
    g.roundRect(355, -240, 72, 48, 9);
    g.fill();
    g.roundRect(355, -184, 72, 48, 9);
    g.fill();
  }

  private updateLabels(): void {
    const room = ROOM_DEFINITIONS[this.roomIndex];
    const remaining = this.enemies.filter((enemy) => !enemy.dead).length;
    this.hud.string = `${room.name}\n${room.subtitle}\n敌人 ${remaining}  ·  生命 ${Math.ceil(this.player.health)}`;
    if (this.state === 'transition') this.status.string = `房间通过 · 即将进入 ${ROOM_DEFINITIONS[this.roomIndex + 1].name}`;
    else if (this.state === 'lost') this.status.string = '挑战失败 · 按 R 重新开始';
    else if (this.state === 'won') this.status.string = 'Demo 完成 · 按 R 再玩一次';
    else if (this.ironBall) this.status.string = `铁球速度 ${Math.round(this.ironBall.lastSpeed)} · 无伤害测试`;
    else if (this.turntable) {
      this.status.string = `杆端速度 ${Math.round(this.turntable.lastAnchorSpeed)} · 张力 ${Math.round(this.turntable.tension * 100)}%`;
    }
    else this.status.string = '近战命中敌人两次即可击杀';
    if (this.snare.activeCount > 0) this.status.string += ` · 绊倒 ${this.snare.activeCount}`;
    if (this.snare.contactCount > 0) {
      const contactAngles = `绕体 ${Math.round(this.snare.totalContactAngle * 180 / Math.PI)}° · 绕行 ${Math.round(this.snare.playerOrbitAngle * 180 / Math.PI)}°`;
      const state = this.snare.securedCount > 0
        ? `${contactAngles} · 已绕住 · 张力 100% 或按 C 可绊倒`
        : this.snare.pullThroughReady
          ? `${contactAngles} · 张力 100% 可拉脱`
          : `${contactAngles} · ${this.snare.directionHint} · 按 C 强制绊倒`;
      this.status.string += ` · ${state} · 拉力 ${Math.round(this.snare.lastPullForce * 100)}%`;
    }
    if (this.player.fallTimer > 0) this.status.string += ` · 摔倒 ${this.player.fallTimer.toFixed(1)} 秒`;
    if (this.debugTether && (this.ironBall || this.turntable)) this.status.string += ' · 锁链调试 ON';
  }
}
