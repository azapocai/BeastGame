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
import { SpriteChainRenderer } from './SpriteChainRenderer';
import { ChainSimulation } from './ChainSimulation';
import { ArenaMotionResolver } from './ArenaMotionResolver';
import { ChainVisualDynamics } from './ChainVisualDynamics';
import { ArenaSpriteRenderer } from './ArenaSpriteRenderer';

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
const PEER_FALLBACK_X = Object.freeze({ x: 1, y: 0 });
const PEER_FALLBACK_Y = Object.freeze({ x: 0, y: 1 });
const DRAW_COLORS = Object.freeze({
  arena: new Color(218, 205, 177),
  grid: new Color(111, 85, 57, 50),
  border: new Color(93, 71, 49),
  attack: new Color(255, 209, 118, 96),
  playerHit: new Color(255, 244, 222),
  player: new Color(45, 143, 152),
  playerStroke: new Color(23, 61, 68),
  aim: new Color(233, 216, 180),
  fall: new Color(238, 109, 75, 210),
  enemyAttack: new Color(202, 68, 48, 64),
  enemyHit: new Color(255, 240, 222),
  enemyStunned: new Color(91, 101, 188),
  enemyHeavy: new Color(116, 46, 43),
  enemy: new Color(173, 73, 55),
  enemyStroke: new Color(75, 32, 28),
  heavyAccent: new Color(213, 178, 118),
  influence: new Color(231, 172, 63, 230),
  healthBack: new Color(64, 38, 30, 150),
  health: new Color(212, 83, 61),
  barrel: new Color(141, 58, 39),
  barrelStroke: new Color(62, 36, 25),
  barrelBand: new Color(208, 155, 74),
  touchStroke: new Color(56, 44, 33, 110),
  touchKnob: new Color(213, 161, 88, 140),
  touchButton: new Color(73, 55, 38, 45),
});

/** Owns the arena simulation, presentation, and room flow. */
@ccclass('ChainArenaController')
export class ChainArenaController extends Component {
  private graphics!: Graphics;
  private staticRenderer!: Node;
  private staticGraphics!: Graphics;
  private spriteChain!: SpriteChainRenderer;
  private arenaSprites!: ArenaSpriteRenderer;
  private hud!: Label;
  private status!: Label;
  private help!: Label;
  private input = new InputRouter();
  private readonly desiredPlayerMotion = { x: 0, y: 0 };
  private readonly influencerMotion = { x: 0, y: 0 };
  private readonly chainPlayerMotion = { x: 0, y: 0 };
  private readonly tempDirection = { x: 0, y: 0 };
  private readonly peerCollisionResult = { normalX: 0, normalY: 0, penetration: 0 };
  private readonly explodeBarrelHandler = (barrel: BarrelState): void => this.explodeBarrel(barrel);
  private readonly explosionColor = new Color(241, 138, 48, 180);

  private roomIndex = 0;
  private player = new PlayerState();
  private enemies: EnemyState[] = [];
  private barrels: BarrelState[] = [];
  private ironBall: IronBallTether | null = null;
  private turntable: TurntableTether | null = null;
  private chain = new ChainSimulation();
  private visualChain = new ChainVisualDynamics();
  private motionResolver = new ArenaMotionResolver();
  private effects: ExplosionEffect[] = [];
  private state: 'playing' | 'transition' | 'lost' | 'won' = 'playing';
  private stateTimer = 0;
  private shake = 0;
  private debugTether = false;
  private lastHudText = '';
  private lastStatusText = '';

  protected onLoad(): void {
    this.createVisuals();
    this.input.enable();
    this.startRun();
  }

  protected onDestroy(): void {
    this.input.disable();
    this.spriteChain?.destroy();
    this.arenaSprites?.destroy();
    if (this.staticRenderer?.isValid) this.staticRenderer.destroy();
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

    let liveEffectCount = 0;
    for (const effect of this.effects) {
      effect.age += dt;
      if (effect.age >= effect.duration) continue;
      this.effects[liveEffectCount] = effect;
      liveEffectCount += 1;
    }
    this.effects.length = liveEffectCount;
    this.shake = Math.max(0, this.shake - dt * 34);
    this.visualChain.update(dt, this.chain.getRouteSnapshot());
    this.draw();
  }

  private createVisuals(): void {
    this.staticRenderer = new Node('ArenaStaticRenderer');
    this.staticRenderer.setParent(this.node);
    this.staticRenderer.layer = Layers.Enum.UI_2D;
    const staticTransform = this.staticRenderer.addComponent(UITransform);
    staticTransform.setContentSize(LOGICAL_WIDTH, LOGICAL_HEIGHT);
    staticTransform.setAnchorPoint(0.5, 0.5);
    this.staticGraphics = this.staticRenderer.addComponent(Graphics);
    this.drawArena(this.staticGraphics, 0, 0);
    this.arenaSprites = new ArenaSpriteRenderer(this.node);
    this.spriteChain = new SpriteChainRenderer(this.node);

    const renderer = new Node('ArenaRenderer');
    renderer.setParent(this.node);
    renderer.layer = Layers.Enum.UI_2D;
    const transform = renderer.addComponent(UITransform);
    transform.setContentSize(LOGICAL_WIDTH, LOGICAL_HEIGHT);
    transform.setAnchorPoint(0.5, 0.5);
    this.graphics = renderer.addComponent(Graphics);
    this.spriteChain.placeAround(this.arenaSprites.actorRoot, renderer);

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
    this.chain.reset();
    this.visualChain.reset();
    this.effects = [];
    this.state = 'playing';
    this.stateTimer = 0;
  }

  private updatePlaying(dt: number, attackRequested: boolean, dashRequested: boolean, pullRequested: boolean): void {
    const move = this.input.getMove();
    const aim = this.input.getAim(this.player);
    const previousInfluencer = this.chain.influencingEnemy;
    const influencerStartX = previousInfluencer?.x || 0;
    const influencerStartY = previousInfluencer?.y || 0;
    this.chainPlayerMotion.x = 0;
    this.chainPlayerMotion.y = 0;
    if (this.ironBall) {
      this.player.prepareMotion(dt, move, aim, dashRequested, this.desiredPlayerMotion);
      this.ironBall.integrate(dt, BOUNDS);
    } else {
      this.player.update(dt, move, aim, dashRequested, BOUNDS);
    }
    if (this.turntable) {
      this.turntable.update(dt, this.player);
      this.player.x = Math2D.clamp(this.player.x, BOUNDS.left + this.player.radius, BOUNDS.right - this.player.radius);
      this.player.y = Math2D.clamp(this.player.y, BOUNDS.bottom + this.player.radius, BOUNDS.top - this.player.radius);
    }
    if (attackRequested && this.player.tryAttack()) this.resolvePlayerAttack();
    for (const enemy of this.enemies) if (!enemy.dead) enemy.update(dt, this.player, this.enemies, BOUNDS);
    // Settle enemy peers before the authoritative endpoint solve. No later
    // peer pass may push a body back into the accepted player/ball pose.
    for (let iteration = 0; iteration < 2; iteration += 1) this.resolveEnemyEnemyCollisions();
    if (this.ironBall) {
      this.ironBall.applyHits(this.enemies, this.barrels, this.explodeBarrelHandler);
      const motionResult = this.motionResolver.resolveIronBallFrame(
        this.player,
        this.ironBall,
        this.enemies,
        BOUNDS,
        this.desiredPlayerMotion,
        this.chain.occupiedLength,
      );
      this.chainPlayerMotion.x = motionResult.playerDrivenDelta.x;
      this.chainPlayerMotion.y = motionResult.playerDrivenDelta.y;
      if (previousInfluencer) {
        this.influencerMotion.x = previousInfluencer.x - influencerStartX;
        this.influencerMotion.y = previousInfluencer.y - influencerStartY;
        this.motionResolver.applyTaggedTetherInfluence(
          this.player,
          this.ironBall,
          previousInfluencer,
          this.influencerMotion,
          BOUNDS,
        );
      }
    }
    if (this.turntable) this.turntable.applyHits(this.enemies, this.barrels, this.explodeBarrelHandler);

    if (this.ironBall) {
      this.chain.update(
        dt,
        this.ironBall,
        this.player,
        this.enemies,
        this.ironBall.maxLength,
        this.chainPlayerMotion,
      );
    } else if (this.turntable) {
      const anchor = this.turntable.getAnchorPosition();
      this.chain.update(dt, anchor, this.player, this.enemies, this.turntable.maxLength);
    }
    if (pullRequested) this.chain.triggerManualPull();

    if (this.player.health <= 0) {
      this.state = 'lost';
      return;
    }

    let allEnemiesDead = true;
    for (const enemy of this.enemies) {
      if (!enemy.dead) {
        allEnemiesDead = false;
        break;
      }
    }
    if (allEnemiesDead) {
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
      const direction = Math2D.normalize(dx, dy, this.tempDirection);
      if (Math2D.dot(direction.x, direction.y, this.player.aim.x, this.player.aim.y) < 0.22) continue;
      enemy.damage(1, direction.x * 225, direction.y * 225);
    }
    for (const barrel of this.barrels) {
      if (barrel.exploded) continue;
      const dx = barrel.x - this.player.x;
      const dy = barrel.y - this.player.y;
      const distance = Math.hypot(dx, dy);
      const direction = Math2D.normalize(dx, dy, this.tempDirection);
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
      const direction = Math2D.normalize(dx, dy, this.tempDirection);
      enemy.damage(3, direction.x * 430, direction.y * 430);
    }
    const playerDistance = Math.hypot(this.player.x - barrel.x, this.player.y - barrel.y);
    if (playerDistance < 92) {
      const direction = Math2D.normalize(
        this.player.x - barrel.x,
        this.player.y - barrel.y,
        this.tempDirection,
      );
      this.player.damage(18, direction.x * 35, direction.y * 35);
    }
  }

  private resolveEnemyEnemyCollisions(): void {
    for (let firstIndex = 0; firstIndex < this.enemies.length - 1; firstIndex += 1) {
      const first = this.enemies[firstIndex];
      if (first.dead || !first.collisionEnabled) continue;
      for (let secondIndex = firstIndex + 1; secondIndex < this.enemies.length; secondIndex += 1) {
        const second = this.enemies[secondIndex];
        if (second.dead || !second.collisionEnabled) continue;
        const fallback = (firstIndex + secondIndex) % 2 === 0 ? PEER_FALLBACK_X : PEER_FALLBACK_Y;
        const recoveryScale = Math.min(first.collisionSeparationScale, second.collisionSeparationScale);
        if (!CircleCollisionSolver.separatePair(
          first,
          second,
          fallback,
          recoveryScale,
          this.peerCollisionResult,
        )) continue;
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
    this.arenaSprites.render(this.player, this.enemies, this.barrels, this.ironBall, shakeX, shakeY);
    this.staticRenderer.active = !this.arenaSprites.arenaReady;
    if (this.staticRenderer.active) this.staticRenderer.setPosition(shakeX, shakeY, 0);
    if (this.turntable) TetherRenderer.drawTurntable(g, this.turntable, shakeX, shakeY);
    const chainSnapshot = this.visualChain.getSnapshot();
    if (this.ironBall || this.turntable) {
      const links = this.spriteChain.render(chainSnapshot, shakeX, shakeY);
      if (links === 0) TetherRenderer.drawChainSnapshot(g, chainSnapshot, shakeX, shakeY);
    }
    if (!this.arenaSprites.barrelReady) {
      for (const barrel of this.barrels) this.drawBarrel(g, barrel, shakeX, shakeY);
    }
    for (const enemy of this.enemies) {
      if (!enemy.dead) this.drawEnemy(g, enemy, shakeX, shakeY, !this.arenaSprites.unitReady);
    }
    if (!this.spriteChain.ready) {
      TetherRenderer.drawContactForeground(g, chainSnapshot, shakeX, shakeY);
    }
    for (const enemy of this.enemies) if (!enemy.dead && enemy.snareTimer > 0) TetherRenderer.drawSnare(g, enemy, shakeX, shakeY);
    this.drawPlayer(g, shakeX, shakeY, !this.arenaSprites.unitReady);
    if (this.ironBall && !this.arenaSprites.ballReady) {
      TetherRenderer.drawIronBall(g, this.ironBall, shakeX, shakeY);
    }
    if (this.debugTether && this.ironBall) TetherRenderer.drawDebug(g, this.ironBall.getSnapshot(this.player), shakeX, shakeY);
    if (this.debugTether && this.turntable) TetherRenderer.drawDebug(g, this.turntable.getSnapshot(this.player), shakeX, shakeY);
    this.drawEffects(g, shakeX, shakeY);
    this.drawTouchHints(g);
    this.updateLabels();
  }

  private drawArena(g: Graphics, ox: number, oy: number): void {
    g.fillColor = DRAW_COLORS.arena;
    g.rect(-480 + ox, -300 + oy, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    g.fill();
    g.strokeColor = DRAW_COLORS.grid;
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
    g.strokeColor = DRAW_COLORS.border;
    g.lineWidth = 12;
    g.rect(BOUNDS.left + ox, BOUNDS.bottom + oy, BOUNDS.right - BOUNDS.left, BOUNDS.top - BOUNDS.bottom);
    g.stroke();
  }

  private drawPlayer(g: Graphics, ox: number, oy: number, drawBody: boolean): void {
    const player = this.player;
    if (player.attackFlash > 0) {
      const angle = Math.atan2(player.aim.y, player.aim.x);
      g.fillColor = DRAW_COLORS.attack;
      g.moveTo(player.x + ox, player.y + oy);
      g.arc(player.x + ox, player.y + oy, 68, angle - 0.72, angle + 0.72, false);
      g.close();
      g.fill();
    }
    if (drawBody) {
      g.fillColor = player.hitFlash > 0 ? DRAW_COLORS.playerHit : DRAW_COLORS.player;
      g.strokeColor = DRAW_COLORS.playerStroke;
      g.lineWidth = 4;
      g.circle(player.x + ox, player.y + oy, player.radius);
      g.fill();
      g.stroke();
    }
    g.strokeColor = DRAW_COLORS.aim;
    g.lineWidth = 8;
    g.moveTo(player.x + ox, player.y + oy);
    g.lineTo(player.x + player.aim.x * 26 + ox, player.y + player.aim.y * 26 + oy);
    g.stroke();
    if (player.fallTimer > 0) {
      g.strokeColor = DRAW_COLORS.fall;
      g.lineWidth = 3;
      g.moveTo(player.x - 25 + ox, player.y - 25 + oy);
      g.lineTo(player.x - 14 + ox, player.y - 14 + oy);
      g.moveTo(player.x + 25 + ox, player.y - 25 + oy);
      g.lineTo(player.x + 14 + ox, player.y - 14 + oy);
      g.stroke();
    }
  }

  private drawEnemy(g: Graphics, enemy: EnemyState, ox: number, oy: number, drawBody: boolean): void {
    if (enemy.attackFlash > 0) {
      const angle = Math.atan2(enemy.attackDirection.y, enemy.attackDirection.x);
      g.fillColor = DRAW_COLORS.enemyAttack;
      g.moveTo(enemy.x + ox, enemy.y + oy);
      g.arc(enemy.x + ox, enemy.y + oy, MELEE_ATTACK_RANGE, angle - 0.62, angle + 0.62, false);
      g.close();
      g.fill();
    }
    if (drawBody) {
      g.fillColor = enemy.hitFlash > 0
        ? DRAW_COLORS.enemyHit
        : enemy.snareTimer > 0
          ? DRAW_COLORS.enemyStunned
          : enemy.tier === 2 ? DRAW_COLORS.enemyHeavy : DRAW_COLORS.enemy;
      g.strokeColor = DRAW_COLORS.enemyStroke;
      g.lineWidth = 4;
      g.circle(enemy.x + ox, enemy.y + oy, enemy.radius);
      g.fill();
      g.stroke();
    }
    if (enemy.tier === 2) {
      g.strokeColor = DRAW_COLORS.heavyAccent;
      g.lineWidth = 5;
      g.arc(enemy.x + ox, enemy.y + oy, enemy.radius - 6, Math.PI * 0.15, Math.PI * 1.85, false);
      g.stroke();
    }
    if (enemy.canInfluenceTether) {
      const markerY = enemy.y + enemy.radius + 24;
      g.fillColor = DRAW_COLORS.influence;
      g.moveTo(enemy.x + ox, markerY + 7 + oy);
      g.lineTo(enemy.x + 7 + ox, markerY + oy);
      g.lineTo(enemy.x + ox, markerY - 7 + oy);
      g.lineTo(enemy.x - 7 + ox, markerY + oy);
      g.close();
      g.fill();
    }
    g.fillColor = DRAW_COLORS.healthBack;
    g.rect(enemy.x - 19 + ox, enemy.y + enemy.radius + 10 + oy, 38, 5);
    g.fill();
    g.fillColor = DRAW_COLORS.health;
    g.rect(enemy.x - 19 + ox, enemy.y + enemy.radius + 10 + oy, 38 * Math.max(0, enemy.health / enemy.maxHealth), 5);
    g.fill();
  }

  private drawBarrel(g: Graphics, barrel: BarrelState, ox: number, oy: number): void {
    if (barrel.exploded) return;
    g.fillColor = DRAW_COLORS.barrel;
    g.strokeColor = DRAW_COLORS.barrelStroke;
    g.lineWidth = 4;
    g.roundRect(barrel.x - 15 + ox, barrel.y - 20 + oy, 30, 40, 6);
    g.fill();
    g.stroke();
    g.strokeColor = DRAW_COLORS.barrelBand;
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
      this.explosionColor.a = Math.round((1 - t) * 180);
      g.fillColor = this.explosionColor;
      g.circle(effect.x + ox, effect.y + oy, effect.radius * (0.2 + t * 0.8));
      g.fill();
    }
  }

  private drawTouchHints(g: Graphics): void {
    const stick = this.input.getJoystick();
    if (stick.active) {
      g.strokeColor = DRAW_COLORS.touchStroke;
      g.lineWidth = 4;
      g.circle(stick.origin.x, stick.origin.y, 54);
      g.stroke();
      const offset = Math2D.normalize(
        stick.position.x - stick.origin.x,
        stick.position.y - stick.origin.y,
        this.tempDirection,
      );
      const distance = Math.min(46, Math.hypot(stick.position.x - stick.origin.x, stick.position.y - stick.origin.y));
      g.fillColor = DRAW_COLORS.touchKnob;
      g.circle(stick.origin.x + offset.x * distance, stick.origin.y + offset.y * distance, 22);
      g.fill();
    }
    g.fillColor = DRAW_COLORS.touchButton;
    g.roundRect(355, -240, 72, 48, 9);
    g.fill();
    g.roundRect(355, -184, 72, 48, 9);
    g.fill();
  }

  private updateLabels(): void {
    const room = ROOM_DEFINITIONS[this.roomIndex];
    let remaining = 0;
    for (const enemy of this.enemies) if (!enemy.dead) remaining += 1;
    const hudText = `${room.name}\n${room.subtitle}\n敌人 ${remaining}  ·  生命 ${Math.ceil(this.player.health)}`;
    let statusText = '';
    if (this.state === 'transition') statusText = `房间通过 · 即将进入 ${ROOM_DEFINITIONS[this.roomIndex + 1].name}`;
    else if (this.state === 'lost') statusText = '挑战失败 · 按 R 重新开始';
    else if (this.state === 'won') statusText = 'Demo 完成 · 按 R 再玩一次';
    else if (this.ironBall) statusText = `铁球速度 ${Math.round(this.ironBall.lastSpeed)} · 无伤害测试`;
    else if (this.turntable) {
      statusText = `杆端速度 ${Math.round(this.turntable.lastAnchorSpeed)} · 张力 ${Math.round(this.turntable.tension * 100)}%`;
    }
    else statusText = '近战命中敌人两次即可击杀';
    if (this.chain.activeCount > 0) statusText += ` · 绊倒 ${this.chain.activeCount}`;
    if (this.chain.enclosedCount > 0) statusText += ` · 圈内候选 ${this.chain.enclosedCount}`;
    if (this.chain.contactCount > 0) {
      const qualification = this.chain.primaryReleaseQualification;
      const contactAngle = Math.round((qualification?.contactAngle || 0) * 180 / Math.PI);
      const playerOrbit = Math.round((qualification?.playerOrbit || 0) * 180 / Math.PI);
      let releaseState = '沿链条收紧';
      if (qualification?.blockReason === 'orbit') releaseState = '需要主动同向绕行';
      else if (qualification?.blockReason === 'tension') releaseState = '已绕住 · 继续拉满张力';
      else if (qualification?.blockReason === 'ready') releaseState = '可以滑脱';
      statusText += ` · 局部绕角 ${contactAngle}° · 玩家绕行 ${playerOrbit}°`
        + ` · ${releaseState} · 拉力 ${Math.round(this.chain.lastPullForce * 100)}%`
        + ' · 按 C 强制绊倒';
    }
    if (this.player.fallTimer > 0) statusText += ` · 摔倒 ${this.player.fallTimer.toFixed(1)} 秒`;
    if (this.debugTether && (this.ironBall || this.turntable)) statusText += ' · 锁链调试 ON';
    if (hudText !== this.lastHudText) {
      this.hud.string = hudText;
      this.lastHudText = hudText;
    }
    if (statusText !== this.lastStatusText) {
      this.status.string = statusText;
      this.lastStatusText = statusText;
    }
  }
}
