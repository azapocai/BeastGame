import { EnemyState, PlayerState } from './ArenaModel';
import { Math2D, Point2D } from './Math2D';
import { TetherSnapshot } from './TetherSystem';
import { ChainContactSolver, ContinuousCircleContact } from './ChainContactSolver';
import { ChainRouteSolver } from './ChainRouteSolver';
import { ChainReleaseTransition } from './ChainReleaseTransition';
import { ChainRouteSnapshot, RouteContactRange } from './ChainRouteSnapshot';
import { ChainRuntimeStats } from './ChainRuntimeStats';
import { ChainContactTopology, OrderedChainContact } from './ChainContactTopology';
import { ChainPerformanceBudget } from './ChainPerformanceBudget';
import { ChainGuideState } from './ChainGuideState';
import { ChainGuideSolver } from './ChainGuideSolver';
import { ChainGuideCollision } from './ChainGuideCollision';
import { ChainEnclosureAnalyzer } from './ChainEnclosureAnalyzer';
import { ChainAnalyticContactRefiner } from './ChainAnalyticContactRefiner';

interface BodyContact extends OrderedChainContact {
  enemy: EnemyState;
  geometry: ContinuousCircleContact;
  lastPlayerX: number;
  lastPlayerY: number;
  constraintEnemyX: number;
  constraintEnemyY: number;
  wasWrapped: boolean;
  pathFraction: number;
}

interface ContactRouteData {
  valid: boolean;
  points: Point2D[];
  ranges: Array<{ id: number; enemy: EnemyState; pointStart: number; pointEnd: number; endLength: number }>;
  totalLength: number;
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
 * The contact route is the source of truth for presentation, length and
 * tension. Its geometry separately exposes total visible contact, added
 * winding and player-caused orbit so design thresholds stay readable.
 */
export class ChainSnareSystem {
  private static readonly CHAIN_CONTACT_PADDING = 2;
  /** Additional body arc required for the stable fully-wrapped state: 135 degrees. */
  private static readonly WRAP_THRESHOLD = Math.PI * 0.75;
  /** Full-tension pull-through begins once the rope has turned around the body by 45 degrees. */
  private static readonly PULL_THROUGH_THRESHOLD = Math.PI * 0.25;
  private static readonly SNARE_DURATION = 1.2;
  private static readonly MAX_CONTACTS = ChainPerformanceBudget.maxContacts;
  private static readonly MAX_EXACT_CANDIDATES = ChainPerformanceBudget.maxExactCandidates;

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
  private routeSnapshot = new ChainRouteSnapshot();
  private runtimeStats = new ChainRuntimeStats();
  private topology = new ChainContactTopology<BodyContact>();
  private rejectedCandidates = new Map<EnemyState, { x: number; y: number; remaining: number }>();
  private readonly exactCandidateEnemies: EnemyState[] = [];
  private readonly exactCandidateScores: number[] = [];
  private readonly guideState = new ChainGuideState();
  private readonly guidePoints: Point2D[] = [];
  private readonly guideCollisionEnemies: EnemyState[] = [];
  private readonly guideTouchedEnemies: EnemyState[] = [];
  private readonly enclosureAnalyzer = new ChainEnclosureAnalyzer<EnemyState>();

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

  /** Full visible rope-on-body arc; unlike progress it includes capture baseline. */
  get totalContactAngle(): number {
    const contact = this.contacts[0];
    return contact ? ChainContactSolver.contactArc(contact.geometry) : 0;
  }

  /** Real angular displacement produced by player movement after the contact was created. */
  get playerOrbitAngle(): number {
    const contact = this.contacts[0];
    return contact ? ChainContactSolver.playerOrbitArc(contact.geometry) : 0;
  }

  get contactCount(): number {
    return this.contacts.length;
  }

  get securedCount(): number {
    return this.contacts.filter((contact) => this.isWrapped(contact)).length;
  }

  get enclosedCount(): number {
    return this.enclosureAnalyzer.enclosed.length;
  }

  get pullThroughReady(): boolean {
    const contact = this.contacts[0];
    return contact ? this.canPullThrough(contact) : false;
  }

  get lastPullForce(): number {
    return this.pullForce;
  }

  get routedLength(): number {
    return this.lastRoutedLength;
  }

  /** Last route published after gameplay constraints; renderers must only read it. */
  getRouteSnapshot(): ChainRouteSnapshot {
    return this.routeSnapshot;
  }

  /** Reused development-only counters; callers must not mutate them. */
  getRuntimeStats(): ChainRuntimeStats {
    return this.runtimeStats;
  }

  setVisibleLinkCount(count: number): void {
    this.runtimeStats.visibleLinks = Math.max(0, Math.floor(count));
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
    this.routeSnapshot.clear();
    this.topology.reset();
    this.rejectedCandidates.clear();
    this.exactCandidateEnemies.length = 0;
    this.exactCandidateScores.length = 0;
    this.guideState.reset();
    this.guidePoints.length = 0;
    this.guideCollisionEnemies.length = 0;
    this.guideTouchedEnemies.length = 0;
    this.enclosureAnalyzer.reset();
  }

  getVisualSnapshot(snapshot: TetherSnapshot): TetherSnapshot {
    if (snapshot.points.length < 2) return snapshot;
    this.refreshGuideContacts();
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
    this.runtimeStats.beginFrame();
    this.updateCandidateQuarantine(dt);
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
      this.routeSnapshot.clear();
      this.topology.reset();
      this.rejectedCandidates.clear();
      this.guideState.reset();
      this.guidePoints.length = 0;
      this.guideCollisionEnemies.length = 0;
      this.guideTouchedEnemies.length = 0;
      this.enclosureAnalyzer.reset();
      return;
    }

    const guideStart = snapshot.points[0];
    const guideEnd = snapshot.points[snapshot.points.length - 1];
    this.selectGuideCollisionEnemies(enemies);
    const guideUpdate = ChainGuideSolver.update(
      this.guideState,
      dt,
      guideStart,
      guideEnd,
      snapshot.maxLength,
      this.guideCollisionEnemies,
      ChainSnareSystem.CHAIN_CONTACT_PADDING,
    );
    ChainGuideSolver.copyPoints(this.guideState, this.guidePoints);
    this.guideTouchedEnemies.length = 0;
    for (const touched of this.guideState.touchedBodies) {
      this.guideTouchedEnemies.push(touched as EnemyState);
    }
    if (guideUpdate.substeps > 0) {
      this.enclosureAnalyzer.update(this.guidePoints, this.guideCollisionEnemies);
    }
    this.runtimeStats.guideNodes = this.guideState.nodeCount;
    this.runtimeStats.guideSubsteps = guideUpdate.substeps;
    this.runtimeStats.enclosedCandidates = this.enclosureAnalyzer.enclosed.length;

    const contactCountBeforeUpdate = this.contacts.length;
    this.contacts = this.contacts.filter(
      (contact) => this.updateContact(contact, player, playerMotion),
    );
    this.syncTopology();
    if (this.contacts.length !== contactCountBeforeUpdate) {
      this.recoverInvalidTopology(snapshot);
    }
    if (this.pendingAutoStun && this.contacts.indexOf(this.pendingAutoStun) === -1) {
      this.pendingAutoStun = null;
    }
    this.addNewContact(snapshot, player, enemies, playerMotion);
    this.recoverInvalidTopology(snapshot);

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
      const pullThroughReady = this.canPullThrough(contact);
      const routeGrowing = routeLength > previousRouteLength + 0.05;
      const crossedTensionLimit = previousPullForce < 1 && this.pullForce >= 1;
      if (pullThroughReady && this.pullForce >= 1 && (routeGrowing || crossedTensionLimit)) {
        this.pendingAutoStun = contact;
      }
      contact.wasWrapped = wrapped;
    }

    this.lastRoutedLength = routeLength;
    if (this.contacts.length > 0) {
      this.copyPointsInto(this.lastContactRoute, route);
    }
    this.updateWrapState();
    this.runtimeStats.activeContacts = this.contacts.length;
  }

  /**
   * Publishes exactly one render-facing path after manual input and length
   * constraints have settled for the frame.
   */
  finalizeFrame(
    snapshot: TetherSnapshot,
    player: PlayerState,
    anchorBody: MovableTetherBody | null = null,
  ): void {
    const current = this.snapshotAtBodies(snapshot, player, anchorBody);
    const data = this.buildActiveRouteData(current);
    const route = data.points;
    const ranges: RouteContactRange[] = data.ranges.map((range, order) => ({
      id: range.id,
      enemy: range.enemy,
      order,
      pointStart: range.pointStart,
      pointEnd: range.pointEnd,
      startLength: this.pathLengthTo(route, range.pointStart),
      endLength: range.endLength,
    }));
    this.routeSnapshot.publish(route, ranges, Math.max(this.pullForce, snapshot.tension));
    this.runtimeStats.publishedRoutes += 1;
    this.runtimeStats.routePoints = route.length;
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
      this.runtimeStats.constraintIterations += 1;
      let currentSnapshot = this.snapshotAtBodies(snapshot, player, anchorBody);
      let route = this.buildActiveRoute(currentSnapshot);
      let excess = ChainRouteSolver.pathLength(route) - snapshot.maxLength;
      if (excess <= 0.01 || route.length < 2) {
        this.lastRoutedLength = ChainRouteSolver.pathLength(route);
        break;
      }

      for (const ordinaryContact of this.contacts) {
        if (ordinaryContact.enemy.canInfluenceTether) continue;
        if (!this.constrainEnemyMovement(ordinaryContact, currentSnapshot)) continue;
        constrained = true;
        currentSnapshot = this.snapshotAtBodies(snapshot, player, anchorBody);
        route = this.buildActiveRoute(currentSnapshot);
        excess = ChainRouteSolver.pathLength(route) - snapshot.maxLength;
        if (excess <= 0.01) break;
      }
      if (excess <= 0.01) {
        this.lastRoutedLength = ChainRouteSolver.pathLength(route);
        break;
      }

      const playerDirection = Math2D.normalize(player.x - route[1].x, player.y - route[1].y);
      const anchorPoint = route[route.length - 2];
      const anchorDirection = anchorBody
        ? Math2D.normalize(anchorBody.x - anchorPoint.x, anchorBody.y - anchorPoint.y)
        : { x: 0, y: 0 };
      const influencer = this.contacts.find((item) => item.enemy.canInfluenceTether) || null;
      const playerShare = influencer && anchorBody ? 0.5 : 1;
      player.x -= playerDirection.x * excess * playerShare;
      player.y -= playerDirection.y * excess * playerShare;
      if (influencer && anchorBody) {
        anchorBody.x -= anchorDirection.x * excess * 0.5;
        anchorBody.y -= anchorDirection.y * excess * 0.5;
        player.applyFall(0.55);
      }
      constrained = true;
    }
    for (const activeContact of this.contacts) {
      activeContact.lastPlayerX = player.x;
      activeContact.lastPlayerY = player.y;
      activeContact.constraintEnemyX = activeContact.enemy.x;
      activeContact.constraintEnemyY = activeContact.enemy.y;
    }
    if (this.pendingAutoStun === contact) {
      const releaseSnapshot = this.snapshotAtBodies(snapshot, player, anchorBody);
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
    player: PlayerState,
    playerMotion: Point2D | null,
  ): boolean {
    const effectiveMotion = playerMotion || {
      x: player.x - contact.lastPlayerX,
      y: player.y - contact.lastPlayerY,
    };
    ChainContactSolver.advanceGuideWinding(
      contact.geometry,
      player,
      contact.enemy,
      effectiveMotion,
    );
    contact.lastPlayerX = player.x;
    contact.lastPlayerY = player.y;
    const stillEnclosed = this.enclosureAnalyzer.enclosed.some((record) => record.target === contact.enemy);
    const touching = ChainAnalyticContactRefiner.touchesBody(
      this.guidePoints,
      contact.enemy,
      ChainSnareSystem.CHAIN_CONTACT_PADDING,
      2,
    );
    const directTouching = ChainContactSolver.findPathIntersection(
      this.guidePoints.length >= 2 ? this.guidePoints : [],
      contact.enemy,
      ChainSnareSystem.CHAIN_CONTACT_PADDING,
    ) !== null;
    const projectedTouch = this.guideTouchedEnemies.indexOf(contact.enemy) >= 0;
    if (ChainContactSolver.windingArc(contact.geometry) <= 0.002
      && !directTouching
      && !projectedTouch
      && !stillEnclosed) return false;
    return touching || stillEnclosed || ChainContactSolver.windingArc(contact.geometry) > 0.002;
  }

  private addNewContact(
    snapshot: TetherSnapshot,
    player: PlayerState,
    enemies: EnemyState[],
    playerMotion: Point2D | null,
  ): void {
    if (this.contacts.length >= ChainSnareSystem.MAX_CONTACTS) return;
    const collisionData = this.buildActiveRouteData(snapshot);
    const collisionPath = this.guidePoints.length >= 2 ? this.guidePoints : collisionData.points;
    const detectionPath = this.guideTouchedEnemies.length > 0 ? snapshot.points : collisionPath;
    const bounds = this.pathBounds(detectionPath, ChainSnareSystem.CHAIN_CONTACT_PADDING);
    let selected: {
      enemy: EnemyState;
      fraction: number;
    } | null = null;
    this.exactCandidateEnemies.length = 0;
    this.exactCandidateScores.length = 0;
    const activeEnemyCount = Math.min(enemies.length, ChainPerformanceBudget.maxActiveEnemies);
    for (let enemyIndex = 0; enemyIndex < activeEnemyCount; enemyIndex += 1) {
      const enemy = enemies[enemyIndex];
      if (enemy.dead
        || enemy.snareTimer > 0
        || !enemy.collisionEnabled
        || enemy === this.releasePassThroughTarget
        || this.hasContact(enemy)) continue;
      const rejected = this.rejectedCandidates.get(enemy);
      if (rejected) {
        const moved = Math.hypot(enemy.x - rejected.x, enemy.y - rejected.y);
        if (rejected.remaining > 0 && moved < 4) continue;
        this.rejectedCandidates.delete(enemy);
      }
      if (!this.boundsContains(bounds, enemy)) continue;
      this.runtimeStats.broadPhaseCandidates += 1;
      this.insertExactCandidate(enemy, this.distanceSquaredToPath(enemy, detectionPath));
    }
    for (const enemy of this.exactCandidateEnemies) {
      const intersection = ChainContactSolver.findPathIntersection(
        detectionPath,
        enemy,
        ChainSnareSystem.CHAIN_CONTACT_PADDING,
      );
      this.runtimeStats.exactIntersectionTests += 1;
      if (intersection) {
        const fraction = ChainRouteSolver.pathFractionAt(
          detectionPath,
          intersection.segmentIndex,
          (intersection.entryT + intersection.exitT) * 0.5,
        );
        if (!selected || fraction < selected.fraction) {
          selected = { enemy, fraction };
        }
      }
    }
    if (!selected) {
      for (const enemy of this.guideTouchedEnemies) {
        if (enemy.dead
          || enemy.snareTimer > 0
          || !enemy.collisionEnabled
          || enemy === this.releasePassThroughTarget
          || this.hasContact(enemy)) continue;
        const wasDirectlyCrossed = ChainContactSolver.findPathIntersection(
          snapshot.points,
          enemy,
          ChainSnareSystem.CHAIN_CONTACT_PADDING,
        ) !== null;
        const enclosed = this.enclosureAnalyzer.enclosed.some((record) => record.target === enemy);
        if (!wasDirectlyCrossed && !enclosed) continue;
        selected = {
          enemy,
          fraction: ChainAnalyticContactRefiner.nearestPathFraction(collisionPath, enemy),
        };
        break;
      }
    }
    if (!selected) {
      for (const record of this.enclosureAnalyzer.enclosed) {
        const enemy = record.target;
        if (enemy.dead
          || enemy.snareTimer > 0
          || !enemy.collisionEnabled
          || enemy === this.releasePassThroughTarget
          || this.hasContact(enemy)) continue;
        if (!ChainAnalyticContactRefiner.touchesBody(
          collisionPath,
          enemy,
          ChainSnareSystem.CHAIN_CONTACT_PADDING,
          2,
        )) continue;
        selected = { enemy, fraction: record.pathFraction };
        break;
      }
    }
    if (!selected) return;
    const pathFraction = ChainAnalyticContactRefiner.nearestPathFraction(collisionPath, selected.enemy);
    const localEndpoints = selected.fraction !== pathFraction && detectionPath !== collisionPath
      ? this.localGuideEndpoints(detectionPath, selected.fraction)
      : this.localGuideEndpoints(collisionPath, pathFraction);
    const geometry = ChainContactSolver.create(
      localEndpoints.start,
      localEndpoints.end,
      selected.enemy,
      ChainSnareSystem.CHAIN_CONTACT_PADDING,
      playerMotion,
    );
    const fallbackGeometry = geometry || ChainContactSolver.create(
      detectionPath[0],
      detectionPath[detectionPath.length - 1],
      selected.enemy,
      ChainSnareSystem.CHAIN_CONTACT_PADDING,
      playerMotion,
    );
    if (!fallbackGeometry) return;
    const contact: BodyContact = {
      topologyId: this.topology.allocateId(),
      enemy: selected.enemy,
      geometry: fallbackGeometry,
      lastPlayerX: player.x,
      lastPlayerY: player.y,
      constraintEnemyX: selected.enemy.x,
      constraintEnemyY: selected.enemy.y,
      wasWrapped: false,
      pathFraction,
    };
    const insertionIndex = this.insertionIndexForFraction(collisionData, selected.fraction);
    this.contacts.splice(insertionIndex, 0, contact);
    this.syncTopology();
    const trial = this.buildContactRouteData(snapshot);
    if (!trial.valid || trial.totalLength > snapshot.maxLength + 0.5) {
      this.contacts.splice(this.contacts.indexOf(contact), 1);
      this.syncTopology();
      this.rejectedCandidates.set(selected.enemy, {
        x: selected.enemy.x,
        y: selected.enemy.y,
        remaining: 0.12,
      });
      return;
    }
    if (this.releaseTransition.collisionActive) {
      this.releaseTransition.beginContactHandoff(collisionPath, selected.fraction);
    } else {
      this.releaseTransition.reset();
    }
    this.releaseStartTension = 0;
    this.releasePassThroughTarget = null;
  }

  private insertionIndexForFraction(
    data: { ranges: Array<{ endLength: number }>; totalLength: number },
    fraction: number,
  ): number {
    if (data.totalLength <= 0 || data.ranges.length === 0) return this.contacts.length;
    const targetLength = data.totalLength * fraction;
    for (let index = 0; index < data.ranges.length; index += 1) {
      if (targetLength <= data.ranges[index].endLength + 0.001) return index;
    }
    return this.contacts.length;
  }

  /** Single authoritative path for rendering, collision, length and tension. */
  private buildActiveRoute(snapshot: TetherSnapshot): Point2D[] {
    this.runtimeStats.routeBuilds += 1;
    return this.buildActiveRouteData(snapshot, false).points;
  }

  private refreshGuideContacts(): void {
    if (this.contacts.length === 0 || this.guidePoints.length < 2) return;
    const collisionBodies: EnemyState[] = [];
    for (const contact of this.contacts) {
      if (!contact.enemy.dead && contact.enemy.collisionEnabled) collisionBodies.push(contact.enemy);
    }
    for (let iteration = 0; iteration < 2; iteration += 1) {
      ChainGuideCollision.solve(
        this.guideState,
        collisionBodies,
        ChainSnareSystem.CHAIN_CONTACT_PADDING,
      );
    }
    ChainGuideSolver.copyPoints(this.guideState, this.guidePoints);
  }

  private buildActiveRouteData(
    snapshot: TetherSnapshot,
    countBuild = true,
  ): ContactRouteData {
    if (countBuild) this.runtimeStats.routeBuilds += 1;
    const contactRoute = this.buildContactRouteData(snapshot);
    const points = this.releaseTransition.build(snapshot.points, contactRoute.points);
    if (this.releaseTransition.active) {
      return {
        valid: contactRoute.valid,
        points,
        ranges: [],
        totalLength: ChainRouteSolver.pathLength(points),
      };
    }
    return { ...contactRoute, points };
  }

  private buildContactRouteData(snapshot: TetherSnapshot): ContactRouteData {
    const source = this.guidePoints.length >= 2
      ? this.guidePoints
      : snapshot.points;
    if (this.contacts.length === 0) {
      const points = source as Point2D[];
      return {
        valid: true,
        points,
        ranges: [],
        totalLength: ChainRouteSolver.pathLength(points),
      };
    }
    const refined = ChainAnalyticContactRefiner.refine(
      source,
      this.contacts.map((contact) => ({
        id: contact.topologyId,
        target: contact.enemy,
        geometry: contact.geometry,
        pathFraction: contact.pathFraction,
      })),
      ChainSnareSystem.CHAIN_CONTACT_PADDING,
    );
    return {
      valid: true,
      points: refined.points,
      ranges: refined.ranges.map((range) => {
        const contact = this.contacts.find((item) => item.topologyId === range.id)!;
        return {
          id: range.id,
          enemy: contact.enemy,
          pointStart: range.pointStart,
          pointEnd: range.pointEnd,
          endLength: range.endLength,
        };
      }),
      totalLength: refined.totalLength,
    };
  }

  /**
   * Moving bodies may invalidate a previously accepted topology. Drop the
   * newest contact deterministically instead of rendering an unrelated stale
   * route until a later frame happens to become valid again.
   */
  private recoverInvalidTopology(snapshot: TetherSnapshot): void {
    let data = this.buildContactRouteData(snapshot);
    while (!data.valid && this.contacts.length > 1) {
      let newestIndex = 0;
      for (let index = 1; index < this.contacts.length; index += 1) {
        if (this.contacts[index].topologyId > this.contacts[newestIndex].topologyId) newestIndex = index;
      }
      const [removed] = this.contacts.splice(newestIndex, 1);
      this.rejectedCandidates.set(removed.enemy, {
        x: removed.enemy.x,
        y: removed.enemy.y,
        remaining: 0.12,
      });
      this.syncTopology();
      data = this.buildContactRouteData(snapshot);
    }
    if (data.valid) {
      this.copyPointsInto(this.lastContactRoute, data.points);
    }
  }

  private updateCandidateQuarantine(dt: number): void {
    for (const [enemy, rejected] of this.rejectedCandidates) {
      rejected.remaining -= dt;
      if (rejected.remaining <= 0) this.rejectedCandidates.delete(enemy);
    }
  }

  private syncTopology(): void {
    this.topology.replace(this.contacts);
  }

  private copyPointsInto(target: Point2D[], source: readonly Point2D[]): void {
    target.length = source.length;
    for (let index = 0; index < source.length; index += 1) {
      const point = source[index];
      const copy = target[index] || { x: 0, y: 0 };
      copy.x = point.x;
      copy.y = point.y;
      target[index] = copy;
    }
  }

  private pathLengthTo(points: readonly Point2D[], pointIndex: number): number {
    let length = 0;
    const end = Math.max(0, Math.min(pointIndex, points.length - 1));
    for (let index = 1; index <= end; index += 1) {
      length += Math.hypot(
        points[index].x - points[index - 1].x,
        points[index].y - points[index - 1].y,
      );
    }
    return length;
  }

  private pathBounds(points: readonly Point2D[], padding: number): { left: number; right: number; bottom: number; top: number } {
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.POSITIVE_INFINITY;
    let top = Number.NEGATIVE_INFINITY;
    for (const point of points) {
      left = Math.min(left, point.x - padding);
      right = Math.max(right, point.x + padding);
      bottom = Math.min(bottom, point.y - padding);
      top = Math.max(top, point.y + padding);
    }
    return { left, right, bottom, top };
  }

  private boundsContains(bounds: { left: number; right: number; bottom: number; top: number }, enemy: EnemyState): boolean {
    return enemy.x + enemy.radius >= bounds.left
      && enemy.x - enemy.radius <= bounds.right
      && enemy.y + enemy.radius >= bounds.bottom
      && enemy.y - enemy.radius <= bounds.top;
  }

  private insertExactCandidate(enemy: EnemyState, score: number): void {
    let index = 0;
    while (index < this.exactCandidateScores.length && this.exactCandidateScores[index] <= score) index += 1;
    if (index >= ChainSnareSystem.MAX_EXACT_CANDIDATES) return;
    this.exactCandidateEnemies.splice(index, 0, enemy);
    this.exactCandidateScores.splice(index, 0, score);
    if (this.exactCandidateEnemies.length > ChainSnareSystem.MAX_EXACT_CANDIDATES) {
      this.exactCandidateEnemies.length = ChainSnareSystem.MAX_EXACT_CANDIDATES;
      this.exactCandidateScores.length = ChainSnareSystem.MAX_EXACT_CANDIDATES;
    }
  }

  private distanceSquaredToPath(enemy: EnemyState, points: readonly Point2D[]): number {
    let best = Number.POSITIVE_INFINITY;
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared > 0
        ? Math2D.clamp(((enemy.x - start.x) * dx + (enemy.y - start.y) * dy) / lengthSquared, 0, 1)
        : 0;
      const offsetX = enemy.x - (start.x + dx * t);
      const offsetY = enemy.y - (start.y + dy * t);
      best = Math.min(best, offsetX * offsetX + offsetY * offsetY);
    }
    return best;
  }

  private selectGuideCollisionEnemies(enemies: readonly EnemyState[]): void {
    this.guideCollisionEnemies.length = 0;
    const limit = Math.min(enemies.length, ChainPerformanceBudget.maxActiveEnemies);
    for (let index = 0; index < limit; index += 1) {
      const enemy = enemies[index];
      if (enemy.dead || !enemy.collisionEnabled || enemy.snareTimer > 0) continue;
      this.guideCollisionEnemies.push(enemy);
      if (this.guideCollisionEnemies.length >= ChainPerformanceBudget.maxExactCandidates) break;
    }
  }

  private localGuideEndpoints(points: readonly Point2D[], fraction: number): { start: Point2D; end: Point2D } {
    const segment = Math.max(0, Math.min(
      points.length - 2,
      Math.floor(fraction * (points.length - 1)),
    ));
    const startIndex = Math.max(0, segment - 1);
    const endIndex = Math.min(points.length - 1, segment + 2);
    return { start: points[startIndex], end: points[endIndex] };
  }

  private cleanState(): void {
    const invalid = this.contacts.filter((contact) => contact.enemy.dead || !contact.enemy.collisionEnabled);
    for (const contact of invalid) this.detachContact(contact, false, this.lastContactRoute);
    this.contacts = this.contacts.filter((contact) => !contact.enemy.dead && contact.enemy.collisionEnabled);
    this.syncTopology();
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
    if (ChainRouteSolver.pathLength(this.buildActiveRoute(snapshot)) > snapshot.maxLength) {
      enemy.x = targetX;
      enemy.y = targetY;
      return false;
    }

    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const t = (low + high) * 0.5;
      enemy.x = contact.constraintEnemyX + moveX * t;
      enemy.y = contact.constraintEnemyY + moveY * t;
      if (ChainRouteSolver.pathLength(this.buildActiveRoute(snapshot)) <= snapshot.maxLength) low = t;
      else high = t;
    }
    enemy.x = contact.constraintEnemyX + moveX * low;
    enemy.y = contact.constraintEnemyY + moveY * low;
    return low < 0.999;
  }

  private detachContact(contact: BodyContact, stun: boolean, releaseRoute: Point2D[] | null = null): void {
    if (releaseRoute && releaseRoute.length > 2) {
      this.releaseTransition.begin(releaseRoute);
      this.releaseStartTension = this.pullForce;
      this.releasePassThroughTarget = contact.enemy;
    }
    const detached = [contact];
    if (stun) {
      for (const item of detached) {
        item.enemy.applySnare(ChainSnareSystem.SNARE_DURATION);
        this.stunnedTargets.add(item.enemy);
      }
    }
    const detachedSet = new Set(detached);
    this.contacts = this.contacts.filter((item) => !detachedSet.has(item));
    this.syncTopology();
    if (this.pendingAutoStun && detachedSet.has(this.pendingAutoStun)) this.pendingAutoStun = null;
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

  private canPullThrough(contact: BodyContact): boolean {
    return ChainContactSolver.contactArc(contact.geometry)
      >= ChainSnareSystem.PULL_THROUGH_THRESHOLD - 0.001
      && ChainContactSolver.playerOrbitArc(contact.geometry)
        >= ChainSnareSystem.PULL_THROUGH_THRESHOLD - 0.001;
  }
}
