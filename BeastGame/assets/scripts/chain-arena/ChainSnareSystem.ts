import { EnemyState, PlayerState } from './ArenaModel';
import { Math2D, Point2D } from './Math2D';
import { TetherSnapshot } from './TetherSystem';
import { ChainContactSolver, ContinuousCircleContact } from './ChainContactSolver';
import { ChainRouteSolver } from './ChainRouteSolver';
import { ChainReleaseTransition } from './ChainReleaseTransition';

interface BodyContact {
  enemy: EnemyState;
  geometry: ContinuousCircleContact;
  lastPlayerX: number;
  lastPlayerY: number;
  constraintEnemyX: number;
  constraintEnemyY: number;
  wasWrapped: boolean;
}

export type ChainWrapState = 'free' | 'contact' | 'wrapped' | 'stunned';

export interface MovableTetherBody {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
}

/**
 * Gameplay facade around the continuous circle-contact solver.
 *
 * The contact arc is the single source of truth for presentation, route
 * length, tension and wrapping progress. There is no separate visual loop or
 * threshold-time topology change.
 */
export class ChainSnareSystem {
  private static readonly CHAIN_CONTACT_PADDING = 2;
  /** Actual additional body arc required to trip: 135 degrees. */
  private static readonly WRAP_THRESHOLD = Math.PI * 0.75;
  private static readonly SNARE_DURATION = 1.2;
  private static readonly MAX_CONTACTS = 1;

  private contacts: BodyContact[] = [];
  private stunnedTargets = new Set<EnemyState>();
  private lastRoutedLength = 0;
  private pullForce = 0;
  private wrapState: ChainWrapState = 'free';
  private pendingAutoStun: BodyContact | null = null;
  private releaseTransition = new ChainReleaseTransition();
  private lastContactRoute: Point2D[] = [];
  private releaseStartTension = 0;
  private releasePassThroughTarget: EnemyState | null = null;

  get state(): ChainWrapState {
    return this.wrapState;
  }

  get directionHint(): string {
    const contact = this.contacts[0];
    if (!contact) return '';
    if (!contact.geometry.sideLocked) return '任意方向';
    return contact.geometry.side < 0 ? '逆时针' : '顺时针';
  }

  get activeTarget(): EnemyState | null {
    for (const enemy of this.stunnedTargets) {
      if (!enemy.dead && enemy.snareTimer > 0) return enemy;
    }
    return null;
  }

  get activeCount(): number {
    let count = 0;
    for (const enemy of this.stunnedTargets) if (!enemy.dead && enemy.snareTimer > 0) count += 1;
    return count;
  }

  get candidateTarget(): EnemyState | null {
    const contact = this.contacts[0];
    return contact && !this.isWrapped(contact) ? contact.enemy : null;
  }

  get progress(): number {
    const contact = this.contacts[0];
    if (!contact) return 0;
    return Math2D.clamp(
      ChainContactSolver.windingArc(contact.geometry) / ChainSnareSystem.WRAP_THRESHOLD,
      0,
      1,
    );
  }

  get windingAngle(): number {
    const contact = this.contacts[0];
    return contact ? ChainContactSolver.windingArc(contact.geometry) : 0;
  }

  get contactCount(): number {
    return this.contacts.length;
  }

  get securedCount(): number {
    return this.contacts.filter((contact) => this.isWrapped(contact)).length;
  }

  get lastPullForce(): number {
    return this.pullForce;
  }

  get routedLength(): number {
    return this.lastRoutedLength;
  }

  reset(): void {
    this.contacts = [];
    this.stunnedTargets.clear();
    this.lastRoutedLength = 0;
    this.pullForce = 0;
    this.wrapState = 'free';
    this.pendingAutoStun = null;
    this.releaseTransition.reset();
    this.lastContactRoute = [];
    this.releaseStartTension = 0;
    this.releasePassThroughTarget = null;
  }

  getVisualSnapshot(snapshot: TetherSnapshot): TetherSnapshot {
    if (snapshot.points.length < 2) return snapshot;
    const points = this.buildActiveRoute(snapshot);
    if (points.length === snapshot.points.length && !this.releaseTransition.active && this.contacts.length === 0) {
      return snapshot;
    }
    return {
      ...snapshot,
      points,
      currentLength: ChainRouteSolver.pathLength(points),
      tension: Math.max(
        snapshot.tension,
        this.pullForce,
        this.releaseStartTension * (1 - this.releaseTransition.progress),
      ),
    };
  }

  update(
    dt: number,
    snapshot: TetherSnapshot | null,
    player: PlayerState,
    enemies: EnemyState[],
    playerMotion: Point2D | null = null,
  ): void {
    this.releaseTransition.update(dt);
    if (!this.releaseTransition.collisionActive) {
      this.releasePassThroughTarget = null;
      this.releaseStartTension = 0;
    }
    this.cleanState();
    if (!snapshot || snapshot.points.length < 2) {
      this.contacts = [];
      this.lastRoutedLength = 0;
      this.pullForce = 0;
      this.wrapState = 'free';
      this.releaseTransition.reset();
      this.releasePassThroughTarget = null;
      return;
    }

    this.contacts = this.contacts.filter(
      (contact) => this.updateContact(contact, snapshot, player, playerMotion),
    );
    if (this.pendingAutoStun && this.contacts.indexOf(this.pendingAutoStun) === -1) {
      this.pendingAutoStun = null;
    }
    this.addNewContact(snapshot, player, enemies, playerMotion);

    const route = this.buildActiveRoute(snapshot);
    const routeLength = ChainRouteSolver.pathLength(route);
    const previousPullForce = this.pullForce;
    const previousRouteLength = this.lastRoutedLength > 0 ? this.lastRoutedLength : snapshot.currentLength;
    const routedTension = Math2D.clamp(
      (routeLength - snapshot.maxLength * 0.82) / (snapshot.maxLength * 0.18),
      0,
      1,
    );
    this.pullForce = Math.max(snapshot.tension, routedTension);

    const contact = this.contacts[0];
    if (contact) {
      const wrapped = this.isWrapped(contact);
      const routeGrowing = routeLength > previousRouteLength + 0.05;
      const crossedTensionLimit = previousPullForce < 1 && this.pullForce >= 1;
      if (wrapped && this.pullForce >= 1 && (routeGrowing || crossedTensionLimit)) {
        this.pendingAutoStun = contact;
      }
      contact.wasWrapped = wrapped;
    }

    this.lastRoutedLength = routeLength;
    if (this.contacts.length > 0) {
      this.lastContactRoute = route.map((point) => ({ x: point.x, y: point.y }));
    }
    this.updateWrapState();
  }

  /** Applies the same continuous route as a real movement-length boundary. */
  enforceRoutedLength(
    snapshot: TetherSnapshot,
    player: PlayerState,
    anchorBody: MovableTetherBody | null = null,
  ): boolean {
    const contact = this.contacts[0];
    if (!contact) return false;
    let constrained = false;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      let currentSnapshot = this.snapshotAtBodies(snapshot, player, anchorBody);
      this.refreshContactGeometry(contact, currentSnapshot);
      let route = this.buildActiveRoute(currentSnapshot);
      let excess = ChainRouteSolver.pathLength(route) - snapshot.maxLength;
      if (excess <= 0.01 || route.length < 2) {
        this.lastRoutedLength = ChainRouteSolver.pathLength(route);
        break;
      }

      if (!contact.enemy.canInfluenceTether && this.constrainEnemyMovement(contact, currentSnapshot)) {
        constrained = true;
        currentSnapshot = this.snapshotAtBodies(snapshot, player, anchorBody);
        this.refreshContactGeometry(contact, currentSnapshot);
        route = this.buildActiveRoute(currentSnapshot);
        excess = ChainRouteSolver.pathLength(route) - snapshot.maxLength;
        if (excess <= 0.01) {
          this.lastRoutedLength = ChainRouteSolver.pathLength(route);
          break;
        }
      }

      const playerDirection = Math2D.normalize(player.x - route[1].x, player.y - route[1].y);
      const anchorPoint = route[route.length - 2];
      const anchorDirection = anchorBody
        ? Math2D.normalize(anchorBody.x - anchorPoint.x, anchorBody.y - anchorPoint.y)
        : { x: 0, y: 0 };
      const playerShare = contact.enemy.canInfluenceTether && anchorBody ? 0.5 : 1;
      player.x -= playerDirection.x * excess * playerShare;
      player.y -= playerDirection.y * excess * playerShare;
      if (contact.enemy.canInfluenceTether && anchorBody) {
        anchorBody.x -= anchorDirection.x * excess * 0.5;
        anchorBody.y -= anchorDirection.y * excess * 0.5;
        player.applyFall(0.55);
      }
      constrained = true;
    }
    contact.lastPlayerX = player.x;
    contact.lastPlayerY = player.y;
    contact.constraintEnemyX = contact.enemy.x;
    contact.constraintEnemyY = contact.enemy.y;
    if (this.pendingAutoStun === contact) {
      const releaseSnapshot = this.snapshotAtBodies(snapshot, player, anchorBody);
      this.refreshContactGeometry(contact, releaseSnapshot);
      this.detachContact(contact, true, this.buildActiveRoute(releaseSnapshot));
    }
    return constrained;
  }

  triggerManualPull(): boolean {
    const contact = this.contacts[0];
    if (!contact) return false;
    // C is an explicit test command: release the current contact and force the
    // same stun/result presentation even when the automatic wrap gate was not met.
    this.detachContact(contact, true, this.lastContactRoute);
    return true;
  }

  private updateContact(
    contact: BodyContact,
    snapshot: TetherSnapshot,
    player: PlayerState,
    playerMotion: Point2D | null,
  ): boolean {
    const anchor = snapshot.points[snapshot.points.length - 1];
    const effectiveMotion = playerMotion || {
      x: player.x - contact.lastPlayerX,
      y: player.y - contact.lastPlayerY,
    };
    const active = ChainContactSolver.update(
      contact.geometry,
      player,
      anchor,
      contact.enemy,
      ChainSnareSystem.CHAIN_CONTACT_PADDING,
      effectiveMotion,
    );
    contact.lastPlayerX = player.x;
    contact.lastPlayerY = player.y;
    return active;
  }

  private addNewContact(
    snapshot: TetherSnapshot,
    player: PlayerState,
    enemies: EnemyState[],
    playerMotion: Point2D | null,
  ): void {
    if (this.contacts.length >= ChainSnareSystem.MAX_CONTACTS) return;
    const anchor = snapshot.points[snapshot.points.length - 1];
    const collisionPath = this.buildActiveRoute(snapshot);
    for (const enemy of enemies) {
      if (enemy.dead
        || enemy.snareTimer > 0
        || !enemy.collisionEnabled
        || enemy === this.releasePassThroughTarget
        || this.hasContact(enemy)) continue;
      const intersection = ChainContactSolver.findPathIntersection(
        collisionPath,
        enemy,
        ChainSnareSystem.CHAIN_CONTACT_PADDING,
      );
      if (!intersection) continue;
      const geometry = ChainContactSolver.create(
        player,
        anchor,
        enemy,
        ChainSnareSystem.CHAIN_CONTACT_PADDING,
        playerMotion,
      );
      if (!geometry) continue;
      const contact: BodyContact = {
        enemy,
        geometry,
        lastPlayerX: player.x,
        lastPlayerY: player.y,
        constraintEnemyX: enemy.x,
        constraintEnemyY: enemy.y,
        wasWrapped: false,
      };
      const trialRoute = ChainRouteSolver.build(
        snapshot.points,
        geometry,
        enemy,
        ChainSnareSystem.CHAIN_CONTACT_PADDING,
      );
      if (Math.max(
        ChainRouteSolver.pathLength(collisionPath),
        ChainRouteSolver.pathLength(trialRoute),
      ) > snapshot.maxLength + 0.5) continue;
      if (this.releaseTransition.collisionActive) {
        const contactFraction = ChainRouteSolver.pathFractionAt(
          collisionPath,
          intersection.segmentIndex,
          (intersection.entryT + intersection.exitT) * 0.5,
        );
        this.releaseTransition.beginContactHandoff(collisionPath, contactFraction);
      } else {
        this.releaseTransition.reset();
      }
      this.releaseStartTension = 0;
      this.releasePassThroughTarget = null;
      this.contacts.push(contact);
      break;
    }
  }

  private buildContactRoute(snapshot: TetherSnapshot): Point2D[] {
    const contact = this.contacts[0];
    return ChainRouteSolver.build(
      snapshot.points,
      contact ? contact.geometry : null,
      contact ? contact.enemy : null,
      ChainSnareSystem.CHAIN_CONTACT_PADDING,
    );
  }

  /** Single authoritative path for rendering, collision, length and tension. */
  private buildActiveRoute(snapshot: TetherSnapshot): Point2D[] {
    const contactRoute = this.buildContactRoute(snapshot);
    return this.releaseTransition.build(snapshot.points, contactRoute);
  }

  private cleanState(): void {
    this.contacts = this.contacts.filter((contact) => !contact.enemy.dead && contact.enemy.collisionEnabled);
    if (this.pendingAutoStun && this.contacts.indexOf(this.pendingAutoStun) === -1) this.pendingAutoStun = null;
    for (const enemy of this.stunnedTargets) {
      if (enemy.dead || enemy.snareTimer <= 0) this.stunnedTargets.delete(enemy);
    }
  }

  private updateWrapState(): void {
    if (this.activeTarget) {
      this.wrapState = 'stunned';
      return;
    }
    const contact = this.contacts[0];
    this.wrapState = contact ? (this.isWrapped(contact) ? 'wrapped' : 'contact') : 'free';
  }

  private refreshContactGeometry(contact: BodyContact, snapshot: TetherSnapshot): void {
    const player = snapshot.points[0];
    const anchor = snapshot.points[snapshot.points.length - 1];
    ChainContactSolver.refresh(
      contact.geometry,
      player,
      anchor,
      contact.enemy,
      ChainSnareSystem.CHAIN_CONTACT_PADDING,
    );
  }

  private snapshotAtBodies(
    snapshot: TetherSnapshot,
    player: PlayerState,
    anchorBody: MovableTetherBody | null,
  ): TetherSnapshot {
    const lastIndex = snapshot.points.length - 1;
    const points = snapshot.points.map((point, index) => {
      if (index === 0) return { x: player.x, y: player.y };
      if (index === lastIndex && anchorBody) return { x: anchorBody.x, y: anchorBody.y };
      return { x: point.x, y: point.y };
    });
    return {
      ...snapshot,
      points,
      currentLength: Math.hypot(player.x - points[points.length - 1].x, player.y - points[points.length - 1].y),
    };
  }

  private constrainEnemyMovement(contact: BodyContact, snapshot: TetherSnapshot): boolean {
    const enemy = contact.enemy;
    const targetX = enemy.x;
    const targetY = enemy.y;
    const moveX = targetX - contact.constraintEnemyX;
    const moveY = targetY - contact.constraintEnemyY;
    if (Math.hypot(moveX, moveY) <= 0.001) return false;

    enemy.x = contact.constraintEnemyX;
    enemy.y = contact.constraintEnemyY;
    this.refreshContactGeometry(contact, snapshot);
    if (ChainRouteSolver.pathLength(this.buildActiveRoute(snapshot)) > snapshot.maxLength) {
      enemy.x = targetX;
      enemy.y = targetY;
      this.refreshContactGeometry(contact, snapshot);
      return false;
    }

    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const t = (low + high) * 0.5;
      enemy.x = contact.constraintEnemyX + moveX * t;
      enemy.y = contact.constraintEnemyY + moveY * t;
      this.refreshContactGeometry(contact, snapshot);
      if (ChainRouteSolver.pathLength(this.buildActiveRoute(snapshot)) <= snapshot.maxLength) low = t;
      else high = t;
    }
    enemy.x = contact.constraintEnemyX + moveX * low;
    enemy.y = contact.constraintEnemyY + moveY * low;
    this.refreshContactGeometry(contact, snapshot);
    return low < 0.999;
  }

  private detachContact(contact: BodyContact, stun: boolean, releaseRoute: Point2D[] | null = null): void {
    if (releaseRoute && releaseRoute.length > 2) {
      this.releaseTransition.begin(releaseRoute);
      this.releaseStartTension = this.pullForce;
      this.releasePassThroughTarget = contact.enemy;
    }
    if (stun) {
      contact.enemy.applySnare(ChainSnareSystem.SNARE_DURATION);
      this.stunnedTargets.add(contact.enemy);
    }
    this.contacts = this.contacts.filter((item) => item !== contact);
    if (this.pendingAutoStun === contact) this.pendingAutoStun = null;
    this.lastRoutedLength = 0;
    this.pullForce = 0;
    this.updateWrapState();
  }

  private hasContact(enemy: EnemyState): boolean {
    return this.contacts.some((contact) => contact.enemy === enemy);
  }

  private isWrapped(contact: BodyContact): boolean {
    return ChainContactSolver.windingArc(contact.geometry) >= ChainSnareSystem.WRAP_THRESHOLD - 0.001;
  }
}
