import { Color, Layers, Node, Sprite, SpriteFrame, UITransform } from 'cc';
import { ChainRouteSnapshot } from './ChainRouteSnapshot';
import { ChainPerformanceBudget } from './ChainPerformanceBudget';
import { SpriteAssetLoader } from './SpriteAssetLoader';
import { CHAIN_FULL_TENSION } from './ArenaModel';

/**
 * Fixed-capacity chain-link sprite pool. It only reads an authoritative route
 * and never performs collision or geometry work.
 */
export class SpriteChainRenderer {
  private static readonly MAX_LINKS = ChainPerformanceBudget.maxVisibleLinks;
  private static readonly LINK_SPACING = 14;
  // Keep samples 14 px apart; render the icon at half of its original size.
  private static readonly LINK_WIDTH = 7;
  private static readonly LINK_HEIGHT = 10;
  private readonly backRoot = new Node('ChainSpriteBack');
  private readonly frontRoot = new Node('ChainSpriteFront');
  private readonly links: Sprite[] = [];
  private readonly slackColor = new Color(113, 106, 95);
  private readonly tenseColor = new Color(240, 194, 107);
  private readonly sampleResult = { x: 0, y: 0, dx: 0, dy: 0 };
  private spriteFrame: SpriteFrame | null = null;
  private loaded = false;
  private loadError = '';
  private lastRevision = -1;
  private lastOffsetX = Number.NaN;
  private lastOffsetY = Number.NaN;
  private lastLinkCount = 0;

  constructor(parent: Node) {
    this.backRoot.setParent(parent);
    this.frontRoot.setParent(parent);
    this.backRoot.layer = Layers.Enum.UI_2D;
    this.frontRoot.layer = Layers.Enum.UI_2D;
    this.spriteFrame = SpriteAssetLoader.getFrames().chainLink;
    this.loaded = true;
    this.ensurePool();
  }

  get ready(): boolean {
    return this.loaded && this.spriteFrame !== null;
  }

  get errorMessage(): string {
    return this.loadError;
  }

  /** Places free segments behind actors and contact arcs in front of actors. */
  placeAround(actorRenderer: Node, overlayRenderer?: Node): void {
    const index = actorRenderer.getSiblingIndex();
    this.backRoot.setSiblingIndex(Math.max(0, index));
    actorRenderer.setSiblingIndex(this.backRoot.getSiblingIndex() + 1);
    this.frontRoot.setSiblingIndex(actorRenderer.getSiblingIndex() + 1);
    if (overlayRenderer) overlayRenderer.setSiblingIndex(this.frontRoot.getSiblingIndex() + 1);
  }

  render(snapshot: ChainRouteSnapshot, ox = 0, oy = 0): number {
    if (!this.ready || snapshot.points.length < 2 || snapshot.totalLength <= 0.01) {
      this.hideAll();
      return 0;
    }
    if (snapshot.revision === this.lastRevision && ox === this.lastOffsetX && oy === this.lastOffsetY) {
      return this.lastLinkCount;
    }
    this.ensurePool();
    const requested = Math.max(2, Math.floor(snapshot.totalLength / SpriteChainRenderer.LINK_SPACING));
    const linkCount = Math.min(SpriteChainRenderer.MAX_LINKS, requested);
    const color = snapshot.tension >= CHAIN_FULL_TENSION ? this.tenseColor : this.slackColor;
    for (let index = 0; index < this.links.length; index += 1) {
      const sprite = this.links[index];
      const visible = index < linkCount;
      if (sprite.node.active !== visible) sprite.node.active = visible;
      if (!visible) continue;
      const distance = snapshot.totalLength * (index + 0.5) / linkCount;
      const sample = this.sample(snapshot, distance, this.sampleResult);
      const targetRoot = this.isContactDistance(snapshot, distance) ? this.frontRoot : this.backRoot;
      if (sprite.node.parent !== targetRoot) sprite.node.setParent(targetRoot);
      const x = sample.x + ox;
      const y = sample.y + oy;
      const position = sprite.node.position;
      if (position.x !== x || position.y !== y || position.z !== 0) sprite.node.setPosition(x, y, 0);
      const angle = Math.atan2(sample.dy, sample.dx) * 180 / Math.PI;
      if (sprite.node.angle !== angle) sprite.node.angle = angle;
      if (!sprite.color.equals(color)) sprite.color = color;
    }
    this.lastRevision = snapshot.revision;
    this.lastOffsetX = ox;
    this.lastOffsetY = oy;
    this.lastLinkCount = linkCount;
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
      const sprite = node.addComponent(Sprite);
      sprite.spriteFrame = this.spriteFrame;
      sprite.sizeMode = Sprite.SizeMode.CUSTOM;
      transform.setContentSize(SpriteChainRenderer.LINK_WIDTH, SpriteChainRenderer.LINK_HEIGHT);
      node.active = false;
      this.links.push(sprite);
    }
    // Existing pools survive editor script hot-reload. Reapply only when their
    // cached UI size differs, so the visible icon updates without changing the
    // 14 px path sampling interval or adding steady-state transform writes.
    for (const sprite of this.links) {
      const transform = sprite.getComponent(UITransform);
      if (!transform) continue;
      const size = transform.contentSize;
      if (size.width !== SpriteChainRenderer.LINK_WIDTH || size.height !== SpriteChainRenderer.LINK_HEIGHT) {
        transform.setContentSize(SpriteChainRenderer.LINK_WIDTH, SpriteChainRenderer.LINK_HEIGHT);
      }
    }
  }

  private hideAll(): void {
    for (const link of this.links) if (link.node.active) link.node.active = false;
    this.lastRevision = -1;
    this.lastLinkCount = 0;
  }

  private sample(
    snapshot: ChainRouteSnapshot,
    distance: number,
    output: { x: number; y: number; dx: number; dy: number },
  ): { x: number; y: number; dx: number; dy: number } {
    const lengths = snapshot.cumulativeLengths;
    let segment = 0;
    while (segment < lengths.length - 2 && lengths[segment + 1] < distance) segment += 1;
    const start = snapshot.points[segment];
    const end = snapshot.points[segment + 1];
    const segmentLength = Math.max(0.0001, lengths[segment + 1] - lengths[segment]);
    const t = Math.max(0, Math.min(1, (distance - lengths[segment]) / segmentLength));
    output.x = start.x + (end.x - start.x) * t;
    output.y = start.y + (end.y - start.y) * t;
    output.dx = end.x - start.x;
    output.dy = end.y - start.y;
    return output;
  }

  private isContactDistance(snapshot: ChainRouteSnapshot, distance: number): boolean {
    for (const contact of snapshot.contacts) {
      if (distance >= contact.startLength - 0.01 && distance <= contact.endLength + 0.01) return true;
    }
    return false;
  }
}
