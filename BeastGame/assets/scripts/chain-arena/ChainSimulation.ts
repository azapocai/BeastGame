import { EnemyState } from './ArenaModel';
import { ChainPerformanceBudget } from './ChainPerformanceBudget';
import { ChainRouteSnapshot, RouteContactRange } from './ChainRouteSnapshot';
import { ChainSweepBounds, ChainSweepHitDetector } from './ChainSweepHitDetector';
import { ChainEnclosureTracker } from './ChainEnclosureTracker';
import { ChainContactIntentTracker } from './ChainContactIntentTracker';
import { Math2D, Point2D } from './Math2D';

interface ChainNode extends Point2D {
  previousX: number;
  previousY: number;
}

interface ChainContact {
  enemy: EnemyState;
  startNode: number;
  endNode: number;
  angle: number;
  signedSweep: number;
}

const ZERO_MOTION: Point2D = { x: 0, y: 0 };

/**
 * The only gameplay chain geometry.
 *
 * It owns one bounded PBD polyline. Collision, contact angle, tension, stun and
 * rendering all read these same nodes. It never writes actor positions.
 */
export class ChainSimulation {
  private static readonly CONTACT_PADDING = 2;
  private static readonly STUN_ANGLE = Math.PI * 0.25;
  private static readonly STUN_DURATION = 1.2;
  private static readonly DAMPING_PER_SECOND = 0.12;
  private static readonly STRAIGHTEN_DURATION = 0.24;

  private readonly nodes: ChainNode[] = [];
  private readonly contacts: ChainContact[] = [];
  private readonly contactPool: ChainContact[] = [];
  private readonly publishRanges: RouteContactRange[] = [];
  private readonly cumulativeLengths: number[] = [];
  private readonly enclosureTracker = new ChainEnclosureTracker();
  private readonly contactIntentTracker = new ChainContactIntentTracker();
  private readonly sweepStartNodes: Point2D[] = [];
  private readonly releaseTargetNodes: Point2D[] = [];
  private readonly sweepSegmentBounds: ChainSweepBounds[] = [];
  private readonly sweepOverallBounds: ChainSweepBounds = {
    minX: 0, minY: 0, maxX: 0, maxY: 0, moving: false,
  };
  private readonly releaseSeedBounds: ChainSweepBounds = {
    minX: 0, minY: 0, maxX: 0, maxY: 0, moving: false,
  };
  private readonly releaseCandidates: EnemyState[] = [];
  private readonly releaseHitTargets = new Set<EnemyState>();
  private readonly snapshot = new ChainRouteSnapshot();
  private readonly stunnedTargets = new Set<EnemyState>();
  private accumulator = 0;
  private maxLength = 1;
  private tension = 0;
  private initialized = false;
  private enclosedTargets = 0;
  private straightenTimer = 0;
  private evaluatedContactAngle = 0;
  private physicalRouteLength = 0;
  private releaseCandidatesSeeded = false;
  private collisionNarrowPhaseChecks = 0;

  get contactCount(): number { return this.contacts.length; }
  get securedCount(): number {
    let count = 0;
    for (const contact of this.contacts) {
      if (contact.angle >= ChainSimulation.STUN_ANGLE
        && this.contactIntentTracker.hasPlayerWrapIntent(contact.enemy)) count += 1;
    }
    return count;
  }
  get enclosedCount(): number { return this.enclosedTargets; }
  get activeCount(): number {
    let count = 0;
    for (const enemy of this.stunnedTargets) if (!enemy.dead && enemy.snareTimer > 0) count += 1;
    return count;
  }
  get totalContactAngle(): number { return this.evaluatedContactAngle; }
  get lastPullForce(): number { return this.tension; }
  get directionHint(): string { return this.contacts.length > 0 ? '沿链条收紧' : ''; }
  get pullThroughReady(): boolean {
    for (const contact of this.contacts) {
      if (contact.angle >= ChainSimulation.STUN_ANGLE
        && this.contactIntentTracker.hasPlayerWrapIntent(contact.enemy)) return true;
    }
    return false;
  }
  get lastCollisionNarrowPhaseChecks(): number { return this.collisionNarrowPhaseChecks; }
  get occupiedLength(): number {
    if (this.nodes.length < 2) return 0;
    const first = this.nodes[0];
    const last = this.nodes[this.nodes.length - 1];
    const directLength = Math.hypot(last.x - first.x, last.y - first.y);
    return Math.max(0, this.physicalRouteLength - directLength);
  }
  get influencingEnemy(): EnemyState | null {
    if (this.tension < 0.98) return null;
    for (const contact of this.contacts) if (contact.enemy.canInfluenceTether) return contact.enemy;
    return null;
  }

  reset(start?: Point2D, end?: Point2D, maxLength = 1): void {
    this.nodes.length = 0;
    this.contacts.length = 0;
    this.enclosureTracker.reset();
    this.contactIntentTracker.reset();
    this.releaseCandidates.length = 0;
    this.releaseHitTargets.clear();
    this.stunnedTargets.clear();
    this.snapshot.clear();
    this.accumulator = 0;
    this.maxLength = Math.max(1, maxLength);
    this.tension = 0;
    this.initialized = false;
    this.enclosedTargets = 0;
    this.straightenTimer = 0;
    this.evaluatedContactAngle = 0;
    this.physicalRouteLength = 0;
    this.releaseCandidatesSeeded = false;
    if (start && end) this.initialize(start, end, this.maxLength);
  }

  update(
    dt: number,
    start: Point2D,
    end: Point2D,
    enemies: readonly EnemyState[],
    maxLength: number,
    playerDrivenMotion: Point2D = ZERO_MOTION,
  ): void {
    this.collisionNarrowPhaseChecks = 0;
    if (!this.initialized || Math.abs(this.maxLength - maxLength) > 0.01) {
      this.initialize(start, end, maxLength);
    }
    this.maxLength = Math.max(1, maxLength);
    this.accumulator = Math.min(
      this.accumulator + Math.max(0, dt),
      ChainPerformanceBudget.guideFixedStep * ChainPerformanceBudget.maxGuideSubsteps,
    );
    let stepped = false;
    while (this.accumulator + 1e-8 >= ChainPerformanceBudget.guideFixedStep) {
      this.step(ChainPerformanceBudget.guideFixedStep, start, end, enemies);
      this.accumulator -= ChainPerformanceBudget.guideFixedStep;
      stepped = true;
    }
    if (!stepped) this.pinEndpoints(start, end);
    this.rebuildContacts(enemies, end, playerDrivenMotion);
    this.evaluatedContactAngle = this.contacts[0]?.angle || 0;
    this.measureTension();
    this.updateStuns();
    this.publish();
    for (const enemy of this.stunnedTargets) {
      if (enemy.dead || enemy.snareTimer <= 0) this.stunnedTargets.delete(enemy);
    }
  }

  triggerManualPull(): boolean {
    this.beginStraightening();
    const contact = this.contacts[0];
    if (contact) this.stun(contact.enemy);
    return true;
  }

  getRouteSnapshot(): ChainRouteSnapshot { return this.snapshot; }

  private initialize(start: Point2D, end: Point2D, maxLength: number): void {
    const count = ChainPerformanceBudget.targetGuideNodes;
    this.nodes.length = count;
    for (let index = 0; index < count; index += 1) {
      const t = index / (count - 1);
      const x = start.x + (end.x - start.x) * t;
      const y = start.y + (end.y - start.y) * t;
      const node = this.nodes[index] || { x: 0, y: 0, previousX: 0, previousY: 0 };
      node.x = x;
      node.y = y;
      node.previousX = x;
      node.previousY = y;
      this.nodes[index] = node;
    }
    this.maxLength = Math.max(1, maxLength);
    this.initialized = true;
  }

  private step(dt: number, start: Point2D, end: Point2D, enemies: readonly EnemyState[]): void {
    const last = this.nodes.length - 1;
    const damping = Math.pow(ChainSimulation.DAMPING_PER_SECOND, dt);
    for (let index = 1; index < last; index += 1) {
      const node = this.nodes[index];
      const velocityX = (node.x - node.previousX) * damping;
      const velocityY = (node.y - node.previousY) * damping;
      node.previousX = node.x;
      node.previousY = node.y;
      node.x += velocityX;
      node.y += velocityY;
    }
    this.pinEndpoints(start, end);
    for (let iteration = 0; iteration < ChainPerformanceBudget.guideConstraintIterations; iteration += 1) {
      this.solveSegmentLengths();
      this.solveEnemyCollisions(enemies);
      this.pinEndpoints(start, end);
    }
    const sweeping = this.straightenTimer > 0;
    if (sweeping) {
      if (!this.releaseCandidatesSeeded) this.seedReleaseCandidates(start, end, enemies);
      this.captureSweepStart();
      this.straightenSameNodes(dt, start, end);
    }
    this.solveSegmentLengths();
    this.pinEndpoints(start, end);
    if (sweeping) this.applyReleaseSweepHits(enemies);
    this.straightenTimer = Math.max(0, this.straightenTimer - dt);
    if (this.straightenTimer <= 0) {
      this.releaseCandidates.length = 0;
      this.releaseCandidatesSeeded = false;
      this.releaseHitTargets.clear();
    }
  }

  private solveSegmentLengths(): void {
    const last = this.nodes.length - 1;
    const segmentLength = this.maxLength / last;
    for (let index = 0; index < last; index += 1) {
      const first = this.nodes[index];
      const second = this.nodes[index + 1];
      const dx = second.x - first.x;
      const dy = second.y - first.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= segmentLength || distance <= 0.0001) continue;
      const correctionX = dx / distance * (distance - segmentLength);
      const correctionY = dy / distance * (distance - segmentLength);
      if (index === 0) {
        this.translateNode(second, -correctionX, -correctionY);
      } else if (index + 1 === last) {
        this.translateNode(first, correctionX, correctionY);
      } else {
        this.translateNode(first, correctionX * 0.5, correctionY * 0.5);
        this.translateNode(second, -correctionX * 0.5, -correctionY * 0.5);
      }
    }
  }

  private solveEnemyCollisions(enemies: readonly EnemyState[]): void {
    const last = this.nodes.length - 1;
    const enemyLimit = Math.min(enemies.length, ChainPerformanceBudget.maxActiveEnemies);
    let minX = this.nodes[0].x;
    let minY = this.nodes[0].y;
    let maxX = minX;
    let maxY = minY;
    for (let index = 1; index <= last; index += 1) {
      const node = this.nodes[index];
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    }
    for (let enemyIndex = 0; enemyIndex < enemyLimit; enemyIndex += 1) {
      const enemy = enemies[enemyIndex];
      if (enemy.dead || !enemy.collisionEnabled || enemy.snareTimer > 0) continue;
      const radius = (enemy.radius + ChainSimulation.CONTACT_PADDING) * enemy.collisionSeparationScale;
      if (enemy.x + radius < minX || enemy.x - radius > maxX
        || enemy.y + radius < minY || enemy.y - radius > maxY) continue;
      const radiusSquared = radius * radius;
      for (let nodeIndex = 1; nodeIndex < last; nodeIndex += 1) {
        const node = this.nodes[nodeIndex];
        const dx = node.x - enemy.x;
        const dy = node.y - enemy.y;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared >= radiusSquared) continue;
        const distance = Math.sqrt(distanceSquared);
        const nx = distance > 0.0001 ? dx / distance : 0;
        const ny = distance > 0.0001 ? dy / distance : 1;
        this.translateNode(node, enemy.x + nx * radius - node.x, enemy.y + ny * radius - node.y);
      }
      for (let segment = 0; segment < last; segment += 1) {
        this.projectSegment(segment, enemy, radius);
      }
    }
  }

  private projectSegment(index: number, enemy: EnemyState, radius: number): void {
    const first = this.nodes[index];
    const second = this.nodes[index + 1];
    if (enemy.x + radius < Math.min(first.x, second.x)
      || enemy.x - radius > Math.max(first.x, second.x)
      || enemy.y + radius < Math.min(first.y, second.y)
      || enemy.y - radius > Math.max(first.y, second.y)) return;
    this.collisionNarrowPhaseChecks += 1;
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= 0.0001) return;
    const t = Math2D.clamp(((enemy.x - first.x) * dx + (enemy.y - first.y) * dy) / lengthSquared, 0, 1);
    const closestX = first.x + dx * t;
    const closestY = first.y + dy * t;
    let nx = closestX - enemy.x;
    let ny = closestY - enemy.y;
    let distance = Math.hypot(nx, ny);
    if (distance >= radius - 0.01) return;
    if (distance <= 0.0001) {
      const previousClosestX = first.previousX + (second.previousX - first.previousX) * t;
      const previousClosestY = first.previousY + (second.previousY - first.previousY) * t;
      nx = previousClosestX - enemy.x;
      ny = previousClosestY - enemy.y;
      distance = Math.hypot(nx, ny);
      if (distance > 0.0001) {
        nx /= distance;
        ny /= distance;
      } else {
        const inverse = 1 / Math.sqrt(lengthSquared);
        nx = -dy * inverse;
        ny = dx * inverse;
        // The exact-centre case has two valid sides. Choose one canonical
        // side so a stationary body can never flip the route frame to frame.
        if (ny < 0 || (Math.abs(ny) < 0.0001 && nx < 0)) {
          nx = -nx;
          ny = -ny;
        }
      }
    } else {
      nx /= distance;
      ny /= distance;
    }
    const correction = radius - distance + 0.02;
    const last = this.nodes.length - 1;
    if (index > 0) {
      this.translateNode(first, nx * correction * (1 - t), ny * correction * (1 - t));
    }
    if (index + 1 < last) {
      this.translateNode(second, nx * correction * t, ny * correction * t);
    }
  }

  private rebuildContacts(
    enemies: readonly EnemyState[],
    player: Point2D = this.nodes[this.nodes.length - 1],
    playerDrivenMotion: Point2D = ZERO_MOTION,
  ): void {
    this.contacts.length = 0;
    this.enclosureTracker.beginFrame();
    this.contactIntentTracker.beginFrame();
    this.enclosedTargets = 0;
    const limit = Math.min(enemies.length, ChainPerformanceBudget.maxActiveEnemies);
    for (let enemyIndex = 0; enemyIndex < limit; enemyIndex += 1) {
      const enemy = enemies[enemyIndex];
      if (enemy.dead || !enemy.collisionEnabled || enemy.snareTimer > 0) continue;
      const radius = (enemy.radius + ChainSimulation.CONTACT_PADDING + 1.5)
        * enemy.collisionSeparationScale;
      const threshold = radius * radius;
      let runStart = -1;
      let bestStart = -1;
      let bestEnd = -1;
      let bestAngle = -1;
      let bestSweep = 0;
      for (let index = 0; index <= this.nodes.length - 1; index += 1) {
        const touching = index < this.nodes.length - 1
          && this.distanceSquaredToSegment(enemy, this.nodes[index], this.nodes[index + 1]) <= threshold;
        if (touching) {
          if (runStart < 0) runStart = index;
          continue;
        }
        if (runStart < 0) continue;
        const runEnd = index;
        const sweep = this.contactSweep(enemy, runStart, runEnd);
        const angle = Math.abs(sweep);
        if (angle > bestAngle) {
          bestStart = runStart;
          bestEnd = runEnd;
          bestAngle = angle;
          bestSweep = sweep;
        }
        runStart = -1;
      }
      if (bestStart >= 0) {
        const contactIndex = this.contacts.length;
        const contact = this.contactPool[contactIndex] || {
          enemy,
          startNode: 0,
          endNode: 0,
          angle: 0,
          signedSweep: 0,
        };
        contact.enemy = enemy;
        contact.startNode = bestStart;
        contact.endNode = bestEnd;
        contact.angle = bestAngle;
        contact.signedSweep = bestSweep;
        this.contactPool[contactIndex] = contact;
        this.contacts.push(contact);
        this.contactIntentTracker.observe(enemy, player, playerDrivenMotion, contact.signedSweep);
      }
      // Enclosure is independent from a shallow body brush. A target inside
      // the guide loop remains an enclosure candidate even when it also has a
      // sub-threshold contact. Two consecutive logic publications are needed
      // before it can share an automatic release event.
      if (this.pointInsideGuide(enemy.x, enemy.y)) this.enclosureTracker.observeInside(enemy);
    }
    this.enclosureTracker.endFrame();
    this.contactIntentTracker.endFrame();
    this.enclosedTargets = this.enclosureTracker.candidates.length;
    this.contacts.sort((a, b) => a.startNode - b.startNode);
    if (this.contacts.length > ChainPerformanceBudget.maxContacts) {
      this.contacts.length = ChainPerformanceBudget.maxContacts;
    }
  }

  private updateStuns(): void {
    if (this.tension < 0.98) return;
    let triggered = false;
    for (const contact of this.contacts) {
      if (contact.angle < ChainSimulation.STUN_ANGLE) continue;
      if (!this.contactIntentTracker.hasPlayerWrapIntent(contact.enemy)) continue;
      this.stun(contact.enemy);
      triggered = true;
    }
    if (triggered) {
      this.beginStraightening();
      // These targets were inside the same valid guide loop on the exact
      // automatic-release frame. They are not granted normal wrap progress;
      // they only share this release event.
      for (const enemy of this.enclosureTracker.candidates) this.stun(enemy);
    }
    let retained = 0;
    for (const contact of this.contacts) {
      if (contact.enemy.snareTimer > 0) continue;
      this.contacts[retained] = contact;
      retained += 1;
    }
    this.contacts.length = retained;
  }

  private stun(enemy: EnemyState): void {
    enemy.applySnare(ChainSimulation.STUN_DURATION);
    this.stunnedTargets.add(enemy);
  }

  private beginStraightening(): void {
    if (this.straightenTimer <= 0) {
      this.releaseCandidates.length = 0;
      this.releaseCandidatesSeeded = false;
      this.releaseHitTargets.clear();
    }
    this.straightenTimer = ChainSimulation.STRAIGHTEN_DURATION;
  }

  private captureSweepStart(): void {
    this.sweepStartNodes.length = this.nodes.length;
    for (let index = 0; index < this.nodes.length; index += 1) {
      const source = this.nodes[index];
      const target = this.sweepStartNodes[index] || { x: 0, y: 0 };
      target.x = source.x;
      target.y = source.y;
      this.sweepStartNodes[index] = target;
    }
  }

  private applyReleaseSweepHits(enemies: readonly EnemyState[]): void {
    const segmentCount = ChainSweepHitDetector.prepareSweep(
      this.sweepStartNodes,
      this.nodes,
      this.sweepSegmentBounds,
      this.sweepOverallBounds,
    );
    this.addReleaseCandidates(enemies, this.sweepOverallBounds);
    let retained = 0;
    for (const enemy of this.releaseCandidates) {
      if (enemy.dead || !enemy.collisionEnabled || enemy.snareTimer > 0 || this.releaseHitTargets.has(enemy)) continue;
      if (!ChainSweepHitDetector.circleOverlapsBounds(
        enemy,
        this.sweepOverallBounds,
        ChainSimulation.CONTACT_PADDING,
      )) {
        this.releaseCandidates[retained] = enemy;
        retained += 1;
        continue;
      }
      if (!ChainSweepHitDetector.hitsPreparedSweep(
        this.sweepStartNodes,
        this.nodes,
        this.sweepSegmentBounds,
        segmentCount,
        enemy,
        ChainSimulation.CONTACT_PADDING,
      )) {
        this.releaseCandidates[retained] = enemy;
        retained += 1;
        continue;
      }
      this.releaseHitTargets.add(enemy);
      this.stun(enemy);
    }
    this.releaseCandidates.length = retained;
  }

  private seedReleaseCandidates(start: Point2D, end: Point2D, enemies: readonly EnemyState[]): void {
    const last = this.nodes.length - 1;
    this.releaseTargetNodes.length = this.nodes.length;
    for (let index = 0; index <= last; index += 1) {
      const t = index / last;
      const target = this.releaseTargetNodes[index] || { x: 0, y: 0 };
      target.x = start.x + (end.x - start.x) * t;
      target.y = start.y + (end.y - start.y) * t;
      this.releaseTargetNodes[index] = target;
    }
    ChainSweepHitDetector.prepareSweep(
      this.nodes,
      this.releaseTargetNodes,
      this.sweepSegmentBounds,
      this.releaseSeedBounds,
    );
    this.addReleaseCandidates(enemies, this.releaseSeedBounds);
    this.releaseCandidatesSeeded = true;
  }

  private addReleaseCandidates(enemies: readonly EnemyState[], bounds: ChainSweepBounds): void {
    const limit = Math.min(enemies.length, ChainPerformanceBudget.maxActiveEnemies);
    for (let index = 0; index < limit; index += 1) {
      const enemy = enemies[index];
      if (enemy.dead || !enemy.collisionEnabled || enemy.snareTimer > 0 || this.releaseHitTargets.has(enemy)) continue;
      if (!ChainSweepHitDetector.circleOverlapsBounds(enemy, bounds, ChainSimulation.CONTACT_PADDING)) continue;
      if (this.releaseCandidates.indexOf(enemy) < 0) this.releaseCandidates.push(enemy);
    }
  }

  private publish(): void {
    this.publishRanges.length = this.contacts.length;
    for (let index = 0; index < this.contacts.length; index += 1) {
      const contact = this.contacts[index];
      const range = this.publishRanges[index] || {
        id: 0,
        enemy: contact.enemy,
        order: 0,
        pointStart: 0,
        pointEnd: 0,
        startLength: 0,
        endLength: 0,
      };
      range.id = index + 1;
      range.enemy = contact.enemy;
      range.order = index;
      range.pointStart = contact.startNode;
      range.pointEnd = contact.endNode;
      range.startLength = this.cumulativeLengths[contact.startNode];
      range.endLength = this.cumulativeLengths[contact.endNode];
      this.publishRanges[index] = range;
    }
    this.snapshot.publish(this.nodes, this.publishRanges, this.tension);
  }

  private measureTension(): void {
    this.cumulativeLengths.length = this.nodes.length;
    this.cumulativeLengths[0] = 0;
    let measuredTotalLength = 0;
    let constrainedLength = 0;
    const maximumSegmentLength = this.maxLength / (this.nodes.length - 1);
    for (let index = 1; index < this.nodes.length; index += 1) {
      const segmentLength = Math.hypot(
        this.nodes[index].x - this.nodes[index - 1].x,
        this.nodes[index].y - this.nodes[index - 1].y,
      );
      measuredTotalLength += segmentLength;
      // Collision/constraint iterations can leave a small local overrun.
      // It is diagnostic geometry error, not additional physical rope length.
      constrainedLength += Math.min(segmentLength, maximumSegmentLength);
      this.cumulativeLengths[index] = measuredTotalLength;
    }
    this.tension = Math2D.clamp(
      (constrainedLength - this.maxLength * 0.94) / (this.maxLength * 0.06),
      0,
      1,
    );
    this.physicalRouteLength = constrainedLength;
  }

  private straightenSameNodes(dt: number, start: Point2D, end: Point2D): void {
    const last = this.nodes.length - 1;
    const blend = 1 - Math.exp(-18 * dt);
    for (let index = 1; index < last; index += 1) {
      const t = index / last;
      const targetX = start.x + (end.x - start.x) * t;
      const targetY = start.y + (end.y - start.y) * t;
      const node = this.nodes[index];
      this.translateNode(node, (targetX - node.x) * blend, (targetY - node.y) * blend);
    }
  }

  /** Constraint projection changes shape, not velocity. */
  private translateNode(node: ChainNode, dx: number, dy: number): void {
    node.x += dx;
    node.y += dy;
    node.previousX += dx;
    node.previousY += dy;
  }

  private pinEndpoints(start: Point2D, end: Point2D): void {
    const first = this.nodes[0];
    const last = this.nodes[this.nodes.length - 1];
    first.x = start.x;
    first.y = start.y;
    first.previousX = start.x;
    first.previousY = start.y;
    last.x = end.x;
    last.y = end.y;
    last.previousX = end.x;
    last.previousY = end.y;
  }

  private contactSweep(enemy: EnemyState, startNode: number, endNode: number): number {
    let previous = Math.atan2(this.nodes[startNode].y - enemy.y, this.nodes[startNode].x - enemy.x);
    let sweep = 0;
    for (let index = startNode + 1; index <= endNode; index += 1) {
      let angle = Math.atan2(this.nodes[index].y - enemy.y, this.nodes[index].x - enemy.x);
      while (angle - previous > Math.PI) angle -= Math.PI * 2;
      while (angle - previous < -Math.PI) angle += Math.PI * 2;
      sweep += angle - previous;
      previous = angle;
    }
    return sweep;
  }

  private distanceSquaredToSegment(point: Point2D, start: Point2D, end: Point2D): number {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0
      ? Math2D.clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1)
      : 0;
    const offsetX = point.x - (start.x + dx * t);
    const offsetY = point.y - (start.y + dy * t);
    return offsetX * offsetX + offsetY * offsetY;
  }

  private pointInsideGuide(x: number, y: number): boolean {
    let inside = false;
    for (let current = 0, previous = this.nodes.length - 1; current < this.nodes.length; previous = current, current += 1) {
      const a = this.nodes[current];
      const b = this.nodes[previous];
      const crosses = (a.y > y) !== (b.y > y)
        && x < (b.x - a.x) * (y - a.y) / ((b.y - a.y) || 1e-8) + a.x;
      if (crosses) inside = !inside;
    }
    return inside;
  }
}
