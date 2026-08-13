import { ChainPerformanceBudget } from './ChainPerformanceBudget';
import { ChainRouteSnapshot, RouteContactRange } from './ChainRouteSnapshot';
import { Point2D } from './Math2D';
import { CHAIN_FULL_TENSION } from './ArenaModel';

interface VisualNode extends Point2D {
  velocityX: number;
  velocityY: number;
}

/**
 * Display-only resampling of the authoritative chain route. Player endpoint
 * movement snaps the display path immediately; residual chain-shape smoothing
 * is limited to authority changes while the player endpoint is stationary.
 *
 * It has no actor references and no gameplay outputs. All nodes use the same
 * response; contact, slack and wrap direction deliberately do not select
 * visual behaviours.
 */
export class ChainVisualDynamics {
  private static readonly SPRING = 210;
  private static readonly DAMPING = 20;
  private static readonly MAX_DEVIATION = 6;
  private static readonly SLEEP_ERROR = 0.025;
  private static readonly SLEEP_FRAMES = 8;

  private readonly nodes: VisualNode[] = [];
  private readonly targets: Point2D[] = [];
  private readonly ranges: RouteContactRange[] = [];
  private readonly snapshot = new ChainRouteSnapshot();
  private initialized = false;
  private sleeping = false;
  private stillFrames = 0;
  private previousTension = 0;
  private contactSignature = 0;
  private previousPlayerEndX = 0;
  private previousPlayerEndY = 0;

  constructor() {
    for (let index = 0; index < ChainPerformanceBudget.visualNodes; index += 1) {
      this.nodes.push({ x: 0, y: 0, velocityX: 0, velocityY: 0 });
      this.targets.push({ x: 0, y: 0 });
    }
  }

  reset(): void {
    this.initialized = false;
    this.sleeping = false;
    this.stillFrames = 0;
    this.previousTension = 0;
    this.contactSignature = 0;
    this.previousPlayerEndX = 0;
    this.previousPlayerEndY = 0;
    this.snapshot.clear();
  }

  getSnapshot(): ChainRouteSnapshot {
    return this.snapshot;
  }

  update(dt: number, authority: ChainRouteSnapshot): ChainRouteSnapshot {
    if (authority.points.length < 2 || authority.totalLength <= 0.001) {
      if (this.snapshot.points.length > 0) this.snapshot.clear(authority.tension);
      this.initialized = false;
      this.sleeping = false;
      return this.snapshot;
    }

    let maximumError = 0;
    for (let index = 0; index < this.targets.length; index += 1) {
      const distance = authority.totalLength * index / (this.targets.length - 1);
      const target = this.targets[index];
      this.sample(authority, distance, target);
      if (this.initialized) {
        maximumError = Math.max(maximumError, Math.hypot(
          target.x - this.nodes[index].x,
          target.y - this.nodes[index].y,
        ));
      }
    }

    const signature = this.buildContactSignature(authority);
    const playerEnd = this.targets[this.targets.length - 1];
    const playerEndpointMoved = this.initialized && Math.hypot(
      playerEnd.x - this.previousPlayerEndX,
      playerEnd.y - this.previousPlayerEndY,
    ) > ChainVisualDynamics.SLEEP_ERROR;
    const tensionStateChanged = (authority.tension >= CHAIN_FULL_TENSION)
      !== (this.previousTension >= CHAIN_FULL_TENSION);
    const presentationChanged = tensionStateChanged
      || Math.abs(authority.tension - this.previousTension) > 0.005
      || signature !== this.contactSignature;

    if (!this.initialized) {
      for (let index = 0; index < this.nodes.length; index += 1) this.snapNode(index);
      this.initialized = true;
      this.publish(authority);
      this.rememberPublishedState(authority.tension, signature);
      this.rememberPlayerEndpoint(playerEnd);
      return this.snapshot;
    }

    // Player movement must never leave a delayed visual tail behind the
    // character. Snap the display-only resampling to the current authority;
    // gameplay PBD continuity and iron-ball inertia are intentionally outside
    // this presentation rule.
    if (playerEndpointMoved) {
      for (let index = 0; index < this.nodes.length; index += 1) this.snapNode(index);
      this.sleeping = false;
      this.stillFrames = 0;
      this.publish(authority);
      this.rememberPublishedState(authority.tension, signature);
      this.rememberPlayerEndpoint(playerEnd);
      return this.snapshot;
    }

    if (this.sleeping && maximumError <= ChainVisualDynamics.SLEEP_ERROR && !presentationChanged) {
      this.rememberPlayerEndpoint(playerEnd);
      return this.snapshot;
    }
    if (maximumError > ChainVisualDynamics.SLEEP_ERROR || presentationChanged) this.sleeping = false;

    const step = Math.min(1 / 30, Math.max(0, dt));
    const velocityDamping = Math.exp(-ChainVisualDynamics.DAMPING * step);
    let maximumVelocity = 0;
    for (let index = 1; index < this.nodes.length - 1; index += 1) {
      const node = this.nodes[index];
      const target = this.targets[index];
      node.velocityX = (node.velocityX + (target.x - node.x) * ChainVisualDynamics.SPRING * step)
        * velocityDamping;
      node.velocityY = (node.velocityY + (target.y - node.y) * ChainVisualDynamics.SPRING * step)
        * velocityDamping;
      node.x += node.velocityX * step;
      node.y += node.velocityY * step;
      const dx = node.x - target.x;
      const dy = node.y - target.y;
      const deviation = Math.hypot(dx, dy);
      if (deviation > ChainVisualDynamics.MAX_DEVIATION) {
        const scale = ChainVisualDynamics.MAX_DEVIATION / deviation;
        node.x = target.x + dx * scale;
        node.y = target.y + dy * scale;
      }
      maximumVelocity = Math.max(maximumVelocity, Math.hypot(node.velocityX, node.velocityY));
    }
    this.snapNode(0);
    this.snapNode(this.nodes.length - 1);

    if (maximumError <= ChainVisualDynamics.SLEEP_ERROR && maximumVelocity <= 0.03) {
      this.stillFrames += 1;
      if (this.stillFrames >= ChainVisualDynamics.SLEEP_FRAMES) {
        for (let index = 0; index < this.nodes.length; index += 1) this.snapNode(index);
        this.sleeping = true;
      }
    } else {
      this.stillFrames = 0;
    }
    this.publish(authority);
    this.rememberPublishedState(authority.tension, signature);
    this.rememberPlayerEndpoint(playerEnd);
    return this.snapshot;
  }

  private rememberPublishedState(tension: number, contactSignature: number): void {
    this.previousTension = tension;
    this.contactSignature = contactSignature;
  }

  private rememberPlayerEndpoint(playerEnd: Point2D): void {
    this.previousPlayerEndX = playerEnd.x;
    this.previousPlayerEndY = playerEnd.y;
  }

  private snapNode(index: number): void {
    const node = this.nodes[index];
    const target = this.targets[index];
    node.x = target.x;
    node.y = target.y;
    node.velocityX = 0;
    node.velocityY = 0;
  }

  private sample(authority: ChainRouteSnapshot, distance: number, output: Point2D): void {
    const lengths = authority.cumulativeLengths;
    let segment = 0;
    while (segment < lengths.length - 2 && lengths[segment + 1] < distance) segment += 1;
    const start = authority.points[segment];
    const end = authority.points[segment + 1];
    const segmentLength = Math.max(0.0001, lengths[segment + 1] - lengths[segment]);
    const t = Math.max(0, Math.min(1, (distance - lengths[segment]) / segmentLength));
    output.x = start.x + (end.x - start.x) * t;
    output.y = start.y + (end.y - start.y) * t;
  }

  private publish(authority: ChainRouteSnapshot): void {
    let visualLength = 0;
    for (let index = 1; index < this.nodes.length; index += 1) {
      visualLength += Math.hypot(
        this.nodes[index].x - this.nodes[index - 1].x,
        this.nodes[index].y - this.nodes[index - 1].y,
      );
    }
    this.ranges.length = authority.contacts.length;
    for (let index = 0; index < authority.contacts.length; index += 1) {
      const source = authority.contacts[index];
      const startRatio = source.startLength / Math.max(0.0001, authority.totalLength);
      const endRatio = source.endLength / Math.max(0.0001, authority.totalLength);
      const target = this.ranges[index] || { ...source };
      target.id = source.id;
      target.enemy = source.enemy;
      target.order = source.order;
      target.pointStart = Math.floor(startRatio * (this.nodes.length - 1));
      target.pointEnd = Math.ceil(endRatio * (this.nodes.length - 1));
      target.startLength = startRatio * visualLength;
      target.endLength = endRatio * visualLength;
      this.ranges[index] = target;
    }
    this.snapshot.publish(this.nodes, this.ranges, authority.tension);
  }

  private buildContactSignature(authority: ChainRouteSnapshot): number {
    let signature = authority.contacts.length;
    for (const contact of authority.contacts) {
      signature = (signature * 31 + contact.id * 7
        + Math.round(contact.startLength) * 3 + Math.round(contact.endLength)) | 0;
    }
    return signature;
  }
}
