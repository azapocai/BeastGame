import {
  Color, ImageAsset, Layers, Node, resources, Sprite, SpriteFrame, Texture2D, UITransform, warn,
} from 'cc';
import { ChainRouteSnapshot } from './ChainRouteSnapshot';
import { ChainPerformanceBudget } from './ChainPerformanceBudget';

/**
 * Fixed-capacity chain-link sprite pool. It only reads an authoritative route
 * and never performs collision or geometry work.
 */
export class SpriteChainRenderer {
  private static readonly MAX_LINKS = ChainPerformanceBudget.maxVisibleLinks;
  private static readonly LINK_SPACING = 14;
  private readonly backRoot = new Node('ChainSpriteBack');
  private readonly frontRoot = new Node('ChainSpriteFront');
  private readonly links: Sprite[] = [];
  private readonly slackColor = new Color(113, 106, 95);
  private readonly tenseColor = new Color(240, 194, 107);
  private spriteFrame: SpriteFrame | null = null;
  private loaded = false;
  private loadError = '';

  constructor(parent: Node) {
    this.backRoot.setParent(parent);
    this.frontRoot.setParent(parent);
    this.backRoot.layer = Layers.Enum.UI_2D;
    this.frontRoot.layer = Layers.Enum.UI_2D;
    this.loadSpriteFrame();
  }

  get ready(): boolean {
    return this.loaded && this.spriteFrame !== null;
  }

  get errorMessage(): string {
    return this.loadError;
  }

  /** Places free segments behind actors and contact arcs in front of actors. */
  placeAround(actorRenderer: Node): void {
    const index = actorRenderer.getSiblingIndex();
    this.backRoot.setSiblingIndex(Math.max(0, index));
    actorRenderer.setSiblingIndex(this.backRoot.getSiblingIndex() + 1);
    this.frontRoot.setSiblingIndex(actorRenderer.getSiblingIndex() + 1);
  }

  render(snapshot: ChainRouteSnapshot, ox = 0, oy = 0): number {
    if (!this.ready || snapshot.points.length < 2 || snapshot.totalLength <= 0.01) {
      this.hideAll();
      return 0;
    }
    this.ensurePool();
    const requested = Math.max(2, Math.floor(snapshot.totalLength / SpriteChainRenderer.LINK_SPACING));
    const linkCount = Math.min(SpriteChainRenderer.MAX_LINKS, requested);
    const color = snapshot.tension > 0.72 ? this.tenseColor : this.slackColor;
    for (let index = 0; index < this.links.length; index += 1) {
      const sprite = this.links[index];
      const visible = index < linkCount;
      sprite.node.active = visible;
      if (!visible) continue;
      const distance = snapshot.totalLength * (index + 0.5) / linkCount;
      const sample = this.sample(snapshot, distance);
      const targetRoot = this.isContactDistance(snapshot, distance) ? this.frontRoot : this.backRoot;
      if (sprite.node.parent !== targetRoot) sprite.node.setParent(targetRoot);
      sprite.node.setPosition(sample.x + ox, sample.y + oy, 0);
      sprite.node.angle = Math.atan2(sample.dy, sample.dx) * 180 / Math.PI;
      sprite.color = color;
    }
    return linkCount;
  }

  destroy(): void {
    if (this.backRoot.isValid) this.backRoot.destroy();
    if (this.frontRoot.isValid) this.frontRoot.destroy();
  }

  private ensurePool(): void {
    if (!this.spriteFrame) return;
    while (this.links.length < SpriteChainRenderer.MAX_LINKS) {
      const node = new Node(`ChainLink-${this.links.length}`);
      node.setParent(this.backRoot);
      node.layer = Layers.Enum.UI_2D;
      const transform = node.addComponent(UITransform);
      transform.setContentSize(13, 19);
      const sprite = node.addComponent(Sprite);
      sprite.spriteFrame = this.spriteFrame;
      sprite.sizeMode = Sprite.SizeMode.CUSTOM;
      node.active = false;
      this.links.push(sprite);
    }
  }

  private loadSpriteFrame(): void {
    resources.load('chain-link/spriteFrame', SpriteFrame, (firstError, firstFrame) => {
      if (this.acceptSpriteFrame(firstFrame)) return;
      resources.load('chain-link', SpriteFrame, (secondError, secondFrame) => {
        if (this.acceptSpriteFrame(secondFrame)) return;
        resources.load('chain-link', ImageAsset, (imageError, imageAsset) => {
          if (imageAsset && this.backRoot.isValid && this.frontRoot.isValid) {
            const texture = new Texture2D();
            texture.image = imageAsset;
            const spriteFrame = new SpriteFrame();
            spriteFrame.texture = texture;
            if (this.acceptSpriteFrame(spriteFrame)) return;
          }
          const errors = [firstError, secondError, imageError]
            .filter((error) => !!error)
            .map((error) => String(error!.message || error));
          this.loadError = errors.join(' | ') || '资源返回为空';
          warn(`[ChainSpriteRenderer] chain-link 加载失败，启用 Graphics 回退：${this.loadError}`);
        });
      });
    });
  }

  private acceptSpriteFrame(spriteFrame: SpriteFrame | null): boolean {
    if (!spriteFrame || !this.backRoot.isValid || !this.frontRoot.isValid) return false;
    this.spriteFrame = spriteFrame;
    this.loaded = true;
    this.loadError = '';
    this.ensurePool();
    return true;
  }

  private hideAll(): void {
    for (const link of this.links) link.node.active = false;
  }

  private sample(snapshot: ChainRouteSnapshot, distance: number): { x: number; y: number; dx: number; dy: number } {
    const lengths = snapshot.cumulativeLengths;
    let segment = 0;
    while (segment < lengths.length - 2 && lengths[segment + 1] < distance) segment += 1;
    const start = snapshot.points[segment];
    const end = snapshot.points[segment + 1];
    const segmentLength = Math.max(0.0001, lengths[segment + 1] - lengths[segment]);
    const t = Math.max(0, Math.min(1, (distance - lengths[segment]) / segmentLength));
    return {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
      dx: end.x - start.x,
      dy: end.y - start.y,
    };
  }

  private isContactDistance(snapshot: ChainRouteSnapshot, distance: number): boolean {
    for (const contact of snapshot.contacts) {
      if (distance >= contact.startLength - 0.01 && distance <= contact.endLength + 0.01) return true;
    }
    return false;
  }
}
