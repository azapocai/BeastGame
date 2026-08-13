import { Color, Layers, Node, Sprite, SpriteFrame, UITransform } from 'cc';
import { BarrelState, EnemyState, PlayerState } from './ArenaModel';
import { ChainPerformanceBudget } from './ChainPerformanceBudget';
import { SpriteAssetLoader } from './SpriteAssetLoader';
import { IronBallTether } from './TetherSystem';

const SPRITE_COLORS = Object.freeze({
  player: new Color(45, 143, 152),
  playerHit: new Color(255, 244, 222),
  enemy: new Color(173, 73, 55),
  enemyHeavy: new Color(116, 46, 43),
  enemyStunned: new Color(91, 101, 188),
  enemyHit: new Color(255, 240, 222),
  white: new Color(255, 255, 255),
  ballHit: new Color(255, 240, 179),
});

/** Fixed-capacity Sprite presentation for arena bodies and background. */
export class ArenaSpriteRenderer {
  readonly actorRoot = new Node('ArenaActorSprites');
  readonly backgroundRoot = new Node('ArenaBackgroundSprite');

  private readonly arena = this.createSprite('ArenaBoard', this.backgroundRoot, 960, 600);
  private readonly player = this.createSprite('PlayerSprite', this.actorRoot, 40, 40);
  private readonly ironBall = this.createSprite('IronBallSprite', this.actorRoot, 62, 62);
  private readonly enemies: Sprite[] = [];
  private readonly barrels: Sprite[] = [];
  private arenaFrame: SpriteFrame | null = null;
  private unitFrame: SpriteFrame | null = null;
  private ballFrame: SpriteFrame | null = null;
  private barrelFrame: SpriteFrame | null = null;
  private readonly enemyDiameters: number[] = [];
  private readonly enemyColorState: number[] = [];
  private playerColorState = -1;
  private ballColorState = -1;

  constructor(parent: Node) {
    this.backgroundRoot.setParent(parent);
    this.actorRoot.setParent(parent);
    this.backgroundRoot.layer = Layers.Enum.UI_2D;
    this.actorRoot.layer = Layers.Enum.UI_2D;
    for (let index = 0; index < ChainPerformanceBudget.maxActiveEnemies; index += 1) {
      this.enemies.push(this.createSprite(`EnemySprite-${index}`, this.actorRoot, 40, 40));
    }
    for (let index = 0; index < ChainPerformanceBudget.maxVisibleBarrels; index += 1) {
      this.barrels.push(this.createSprite(`BarrelSprite-${index}`, this.actorRoot, 38, 50));
    }
    const frames = SpriteAssetLoader.getFrames();
    this.arenaFrame = frames.arena;
    this.unitFrame = frames.unit;
    this.ballFrame = frames.ironBall;
    this.barrelFrame = frames.barrel;
    this.arena.spriteFrame = frames.arena;
    this.player.spriteFrame = frames.unit;
    this.ironBall.spriteFrame = frames.ironBall;
    for (const sprite of this.enemies) sprite.spriteFrame = frames.unit;
    for (const sprite of this.barrels) sprite.spriteFrame = frames.barrel;
  }

  get arenaReady(): boolean { return this.arenaFrame !== null; }
  get unitReady(): boolean { return this.unitFrame !== null; }
  get ballReady(): boolean { return this.ballFrame !== null; }
  get barrelReady(): boolean { return this.barrelFrame !== null; }

  render(
    playerState: PlayerState,
    enemyStates: readonly EnemyState[],
    barrelStates: readonly BarrelState[],
    ball: IronBallTether | null,
    shakeX = 0,
    shakeY = 0,
  ): void {
    this.setPositionIfChanged(this.backgroundRoot, shakeX, shakeY);
    this.setPositionIfChanged(this.actorRoot, shakeX, shakeY);
    this.setActiveIfChanged(this.arena.node, this.arenaReady);

    this.setActiveIfChanged(this.player.node, this.unitReady);
    if (this.unitReady) {
      this.setPositionIfChanged(this.player.node, playerState.x, playerState.y);
      const colorState = playerState.hitFlash > 0 ? 1 : 0;
      if (colorState !== this.playerColorState) {
        this.player.color = colorState === 1 ? SPRITE_COLORS.playerHit : SPRITE_COLORS.player;
        this.playerColorState = colorState;
      }
    }

    for (let index = 0; index < this.enemies.length; index += 1) {
      const sprite = this.enemies[index];
      const enemy = enemyStates[index];
      this.setActiveIfChanged(sprite.node, this.unitReady && !!enemy && !enemy.dead);
      if (!sprite.node.active || !enemy) continue;
      this.setPositionIfChanged(sprite.node, enemy.x, enemy.y);
      const diameter = enemy.radius * 2 + 8;
      if (this.enemyDiameters[index] !== diameter) {
        sprite.node.getComponent(UITransform)!.setContentSize(diameter, diameter);
        this.enemyDiameters[index] = diameter;
      }
      const colorState = enemy.hitFlash > 0 ? 3 : enemy.snareTimer > 0 ? 2 : enemy.tier === 2 ? 1 : 0;
      if (this.enemyColorState[index] !== colorState) {
        sprite.color = colorState === 3 ? SPRITE_COLORS.enemyHit
          : colorState === 2 ? SPRITE_COLORS.enemyStunned
            : colorState === 1 ? SPRITE_COLORS.enemyHeavy : SPRITE_COLORS.enemy;
        this.enemyColorState[index] = colorState;
      }
    }

    this.setActiveIfChanged(this.ironBall.node, this.ballReady && ball !== null);
    if (this.ironBall.node.active && ball) {
      this.setPositionIfChanged(this.ironBall.node, ball.x, ball.y);
      const scale = ball.hitPulse > 0 ? 1.1 : 1;
      if (this.ironBall.node.scale.x !== scale) this.ironBall.node.setScale(scale, scale, 1);
      const colorState = ball.hitPulse > 0 ? 1 : 0;
      if (this.ballColorState !== colorState) {
        this.ironBall.color = colorState === 1 ? SPRITE_COLORS.ballHit : SPRITE_COLORS.white;
        this.ballColorState = colorState;
      }
    }

    for (let index = 0; index < this.barrels.length; index += 1) {
      const sprite = this.barrels[index];
      const barrel = barrelStates[index];
      this.setActiveIfChanged(sprite.node, this.barrelReady && !!barrel && !barrel.exploded);
      if (sprite.node.active && barrel) this.setPositionIfChanged(sprite.node, barrel.x, barrel.y);
    }
  }

  destroy(): void {
    if (this.backgroundRoot.isValid) this.backgroundRoot.destroy();
    if (this.actorRoot.isValid) this.actorRoot.destroy();
  }

  private createSprite(name: string, parent: Node, width: number, height: number): Sprite {
    const node = new Node(name);
    node.setParent(parent);
    node.layer = Layers.Enum.UI_2D;
    node.addComponent(UITransform).setContentSize(width, height);
    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    node.active = false;
    return sprite;
  }

  private setActiveIfChanged(node: Node, active: boolean): void {
    if (node.active !== active) node.active = active;
  }

  private setPositionIfChanged(node: Node, x: number, y: number): void {
    const position = node.position;
    if (position.x !== x || position.y !== y || position.z !== 0) node.setPosition(x, y, 0);
  }

}
