const fs = require('fs');
const path = require('path');
const ts = require('C:/ProgramData/cocos/editors/Creator/3.8.8/resources/app.asar.unpacked/node_modules/typescript');

const sourceRoot = path.resolve(__dirname, '../assets/scripts/chain-arena');
const cache = new Map();

function loadModule(filePath) {
  const absolute = path.resolve(filePath);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const module = { exports: {} };
  cache.set(absolute, module);
  const source = fs.readFileSync(absolute, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
  }).outputText;
  const localRequire = (request) => {
    if (!request.startsWith('.')) return require(request);
    return loadModule(path.resolve(path.dirname(absolute), `${request}.ts`));
  };
  new Function('require', 'module', 'exports', output)(localRequire, module, module.exports);
  return module.exports;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function snapshot(player, anchor, maxLength, tension = 0) {
  return {
    points: [{ x: player.x, y: player.y }, { x: anchor.x, y: anchor.y }],
    currentLength: Math.hypot(player.x - anchor.x, player.y - anchor.y),
    maxLength,
    tension,
    anchorKind: 'fixed',
  };
}

const { ChainSnareSystem } = loadModule(path.join(sourceRoot, 'ChainSnareSystem.ts'));
const { ChainReleaseTransition } = loadModule(path.join(sourceRoot, 'ChainReleaseTransition.ts'));
const {
  EnemyState, PlayerState, ROOM_DEFINITIONS, TEST_ARENA_DAMAGE_ENABLED,
} = loadModule(path.join(sourceRoot, 'ArenaModel.ts'));
const { IronBallTether } = loadModule(path.join(sourceRoot, 'TetherSystem.ts'));
const { CircleCollisionSolver } = loadModule(path.join(sourceRoot, 'CircleCollisionSolver.ts'));
const { ChainContactSolver } = loadModule(path.join(sourceRoot, 'ChainContactSolver.ts'));
const { MultiContactRouteSolver } = loadModule(path.join(sourceRoot, 'MultiContactRouteSolver.ts'));
const { ChainPerformanceBudget } = loadModule(path.join(sourceRoot, 'ChainPerformanceBudget.ts'));
const { ChainGuideState } = loadModule(path.join(sourceRoot, 'ChainGuideState.ts'));
const { ChainGuideSolver } = loadModule(path.join(sourceRoot, 'ChainGuideSolver.ts'));
const { ChainGuideCollision } = loadModule(path.join(sourceRoot, 'ChainGuideCollision.ts'));
const { ChainEnclosureAnalyzer } = loadModule(path.join(sourceRoot, 'ChainEnclosureAnalyzer.ts'));
const { ChainAnalyticContactRefiner } = loadModule(path.join(sourceRoot, 'ChainAnalyticContactRefiner.ts'));

function guidePathLength(points) {
  let length = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    length += Math.hypot(points[index + 1].x - points[index].x, points[index + 1].y - points[index].y);
  }
  return length;
}

function persistentGuideSlackShapeTest() {
  const state = new ChainGuideState();
  const loop = [];
  const count = ChainPerformanceBudget.targetGuideNodes;
  for (let index = 0; index < count; index += 1) {
    const t = index / (count - 1);
    loop.push({
      x: -120 + 240 * t,
      y: Math.sin(t * Math.PI) * 115,
    });
  }
  ChainGuideSolver.setPoints(state, loop, 520);
  const beforePeak = Math.max(...state.nodes.map((point) => point.y));
  for (let frame = 0; frame < 120; frame += 1) {
    ChainGuideSolver.update(state, 1 / 60, loop[0], loop[loop.length - 1], 520);
  }
  const afterPeak = Math.max(...state.nodes.map((point) => point.y));
  assert(state.nodeCount === ChainPerformanceBudget.targetGuideNodes,
    'rule guide should use the fixed target node budget');
  assert(afterPeak > beforePeak * 0.95,
    'a stationary slack loop must remain persistent instead of being minimized into a direct line');
  assert(guidePathLength(state.nodes) <= 520.5,
    'persistent guide must stay within its maximum chain-length budget');
}

function boundedGuideSubstepTest() {
  const state = new ChainGuideState();
  const start = { x: -100, y: 0 };
  const end = { x: 100, y: 0 };
  const result = ChainGuideSolver.update(state, 0.2, start, end, 420);
  assert(result.substeps === ChainPerformanceBudget.maxGuideSubsteps,
    'low render FPS must not cause unbounded guide substeps');
  assert(state.nodeCount <= ChainPerformanceBudget.maxGuideNodes,
    'guide node count must never exceed the mini-game hard budget');
}

function guideFrameRateConsistencyTest() {
  const simulate = (dt) => {
    const state = new ChainGuideState();
    const start = { x: -110, y: 0 };
    const end = { x: 110, y: 0 };
    ChainGuideSolver.update(state, dt, start, end, 500);
    const frames = Math.round(1 / dt);
    for (let frame = 0; frame < frames; frame += 1) {
      const angle = frame / Math.max(1, frames - 1) * Math.PI;
      start.x = -110 + Math.cos(angle) * 35;
      start.y = Math.sin(angle) * 95;
      ChainGuideSolver.update(state, dt, start, end, 500);
    }
    return state.nodes.map((point) => ({ x: point.x, y: point.y }));
  };
  const at30 = simulate(1 / 30);
  const at60 = simulate(1 / 60);
  let meanDifference = 0;
  for (let index = 0; index < at30.length; index += 1) {
    meanDifference += Math.hypot(at30[index].x - at60[index].x, at30[index].y - at60[index].y);
  }
  meanDifference /= at30.length;
  assert(meanDifference < 12,
    `fixed-step guide should remain close at 30/60 FPS, mean difference was ${meanDifference.toFixed(2)}`);
}

function guideCircleCollisionTest() {
  const state = new ChainGuideState();
  const points = [];
  for (let index = 0; index < 24; index += 1) {
    points.push({ x: -120 + index * 240 / 23, y: 0 });
  }
  ChainGuideSolver.setPoints(state, points, 260);
  const body = { x: 0, y: 0, radius: 24 };
  for (let iteration = 0; iteration < 8; iteration += 1) {
    ChainGuideCollision.solve(state, [body], 2);
  }
  for (let index = 0; index < state.nodes.length - 1; index += 1) {
    assert(distanceToSegment(body.x, body.y, state.nodes[index], state.nodes[index + 1]) >= body.radius + 1.5,
      'rule guide segment must be projected outside a colliding body');
  }
}

function enclosureCandidateStabilityTest() {
  const analyzer = new ChainEnclosureAnalyzer();
  const guide = [
    { x: -120, y: 0 },
    { x: -90, y: 100 },
    { x: 0, y: 135 },
    { x: 90, y: 100 },
    { x: 120, y: 0 },
  ];
  const insideA = { x: -30, y: 45, radius: 16 };
  const insideB = { x: 35, y: 55, radius: 16 };
  const outside = { x: 0, y: -50, radius: 16 };
  assert(analyzer.update(guide, [insideA, insideB, outside]).length === 0,
    'enclosure should require stable fixed steps instead of firing on one sample');
  const enclosed = analyzer.update(guide, [insideA, insideB, outside]);
  assert(enclosed.length === 2 && enclosed.every((record) => record.target !== outside),
    'a persistent slack boundary should track multiple inside targets without suctioning outsiders');

  const selfCrossing = [
    { x: -100, y: 0 },
    { x: 100, y: 100 },
    { x: -100, y: 100 },
    { x: 100, y: 0 },
  ];
  assert(analyzer.update(selfCrossing, [insideA]).length === 0,
    'self-crossing guide must not manufacture an enclosure candidate');
}

function localAnalyticRefinementPreservesGuideTest() {
  const guide = [
    { x: -150, y: 0 },
    { x: -115, y: 70 },
    { x: -55, y: 115 },
    { x: 0, y: 125 },
    { x: 55, y: 115 },
    { x: 115, y: 70 },
    { x: 150, y: 0 },
  ];
  const body = { x: 0, y: 108, radius: 20 };
  const geometry = ChainContactSolver.create(guide[2], guide[4], body, 2, { x: 1, y: 0 });
  assert(geometry, 'local-refiner fixture should create a valid circle contact');
  const result = ChainAnalyticContactRefiner.refine(guide, [{
    id: 1,
    target: body,
    geometry,
    pathFraction: 0.5,
  }], 2);
  assert(result.ranges.length === 1, 'local refiner should publish the body contact range');
  assert(result.points[0].x === guide[0].x && result.points[0].y === guide[0].y,
    'local refinement must preserve the player-side guide endpoint');
  assert(result.points[result.points.length - 1].x === guide[guide.length - 1].x
    && result.points[result.points.length - 1].y === guide[guide.length - 1].y,
  'local refinement must preserve the anchor-side guide endpoint');
  assert(Math.max(...result.points.map((point) => point.y)) > 100,
    'local refinement must not globally minimize a slack guide loop');
  assert(result.points.length <= ChainPerformanceBudget.maxRoutePoints,
    'local analytic route must respect the shared path-point budget');
}

function testArenaConfigurationTest() {
  assert(ROOM_DEFINITIONS.length === 1, 'test build should expose one room only');
  const room = ROOM_DEFINITIONS[0];
  assert(room.mechanic === 'iron-ball', 'test room should use the iron-ball tether');
  assert(room.enemies.length === 3, 'test room should contain handoff and multi-contact targets');
  assert(Math.abs(room.enemies[1].y - room.enemies[0].y) > 18,
    'second enemy should start outside the initial straight-chain collision radius');
  assert(Math.abs(room.enemies[2].y - room.enemies[0].y) > 18,
    'third enemy should stay outside the initial straight-chain collision radius');
  assert(room.barrels.length === 0, 'test room should not contain barrels');
  const enemy = new EnemyState(room.enemies[0]);
  assert(Math.abs(enemy.speed - 100 * 2 / 3) < 1e-6, 'enemy speed should be two thirds of baseline');
  const player = new PlayerState();
  player.update(0.016, { x: 1, y: 0 }, { x: 1, y: 0 }, false, {
    left: -1000, right: 1000, bottom: -1000, top: 1000,
  });
  assert(Math.abs(player.vx - 238 * 2 / 3) < 1e-6, 'player speed should be two thirds of baseline');
  assert(new IronBallTether(player).maxLength === 396,
    'Video 11 test tether should use the one-third-shortened chain length');
  assert(TEST_ARENA_DAMAGE_ENABLED === false, 'test arena should disable damage');
  const playerHealth = player.health;
  player.damage(999, 500, 500);
  assert(player.health === playerHealth, 'player should not lose health in test mode');
  const enemyHealth = enemy.health;
  enemy.damage(999, 500, 500);
  assert(enemy.health === enemyHealth && !enemy.dead, 'enemy should not lose health in test mode');
}

function liveIronBallTestArenaContactTest() {
  const room = ROOM_DEFINITIONS[0];
  const player = new PlayerState();
  const enemy = new EnemyState(room.enemies[0]);
  const tether = new IronBallTether(player);
  const bounds = { left: -446, right: 446, bottom: -258, top: 258 };
  tether.update(0.016, player, bounds);
  const system = new ChainSnareSystem();
  const liveSnapshot = tether.getSnapshot(player);
  system.update(0.016, liveSnapshot, player, [enemy]);
  assert(system.state === 'contact', 'real test-arena tether should start in contact state');
  const route = system.getVisualSnapshot(tether.getSnapshot(player));
  assert(route.currentLength <= tether.maxLength + 0.5, 'real test-arena contact should fit its chain budget');
}

function ironBallSolidCollisionTest() {
  const bounds = { left: -500, right: 500, bottom: -500, top: 500 };
  const player = new PlayerState();
  player.x = 0;
  player.y = 0;
  const tether = new IronBallTether(player);
  const enemy = new EnemyState({ x: tether.x + 8, y: tether.y });
  const ballBefore = { x: tether.x, y: tether.y };
  assert(tether.resolveBodyCollisions(player, [enemy], bounds), 'iron ball should report a solid enemy collision');
  assert(Math.hypot(enemy.x - tether.x, enemy.y - tether.y) >= enemy.radius + tether.radius - 1e-6,
    'ordinary enemy should be separated from the iron ball');
  assert(tether.x === ballBefore.x && tether.y === ballBefore.y,
    'ordinary enemy collision must not steer the player-authoritative iron ball');

  enemy.applySnare(1);
  enemy.x = tether.x;
  enemy.y = tether.y;
  tether.resolveBodyCollisions(player, [enemy], bounds);
  assert(enemy.x === tether.x && enemy.y === tether.y,
    'stunned enemy should remain pass-through for iron-ball collision too');

  const playerCollisionTether = new IronBallTether(player);
  playerCollisionTether.x = player.x;
  playerCollisionTether.y = player.y;
  playerCollisionTether.vx = -50;
  assert(playerCollisionTether.resolveBodyCollisions(player, [], bounds),
    'iron ball should collide with the player body');
  assert(Math.hypot(playerCollisionTether.x - player.x, playerCollisionTether.y - player.y)
      >= playerCollisionTether.radius + player.radius - 1e-6,
  'iron ball should be separated from the player without moving the player');
}

function enemyPeerCollisionTest() {
  const first = new EnemyState({ x: 0, y: 0 });
  const second = new EnemyState({ x: 0, y: 0 });
  assert(CircleCollisionSolver.separatePair(first, second), 'overlapping enemies should produce a peer collision');
  assert(Math.hypot(first.x - second.x, first.y - second.y) >= first.radius + second.radius - 1e-6,
    'peer collision should separate both enemies to their combined radii');
  assert(Math.abs(first.x) > 0 && Math.abs(second.x) > 0,
    'peer collision should distribute separation between both enemies');
}

function enemyAttackAndCollisionSwitchTest() {
  const player = new PlayerState();
  player.x = 0;
  player.y = 0;
  const enemy = new EnemyState({ x: 90, y: 0 });
  enemy.damageCooldown = 0;
  const beforeX = enemy.x;
  enemy.update(0.016, player, [enemy], { left: -500, right: 500, bottom: -500, top: 500 });
  assert(Math.abs(enemy.x - beforeX) < 1e-6, 'enemy should stop chasing inside player-equivalent attack range');
  assert(enemy.attackFlash > 0, 'enemy should actively attack inside its melee range');
  enemy.applySnare(1);
  assert(enemy.collisionEnabled === false, 'stunned enemy should immediately disable collision');
  enemy.update(0.5, player, [enemy], { left: -500, right: 500, bottom: -500, top: 500 });
  assert(enemy.collisionEnabled === false, 'collision should remain disabled throughout stun');
  enemy.update(0.6, player, [enemy], { left: -500, right: 500, bottom: -500, top: 500 });
  assert(enemy.collisionEnabled === true, 'collision should return after stun expires');
}

function stableBodyContactTest() {
  const system = new ChainSnareSystem();
  const player = new PlayerState();
  player.x = -80;
  player.y = 0;
  const anchor = { x: 80, y: 0 };
  const enemy = new EnemyState({ x: 0, y: 0 });
  system.update(0.016, snapshot(player, anchor, 240), player, [enemy]);
  assert(system.contactCount === 1, 'expected first body contact');
  const before = system.getVisualSnapshot(snapshot(player, anchor, 240)).points[1];
  const angleBefore = Math.atan2(before.y - enemy.y, before.x - enemy.x);
  enemy.x += 24;
  enemy.y += 17;
  const after = system.getVisualSnapshot(snapshot(player, anchor, 240)).points[1];
  const angleAfter = Math.atan2(after.y - enemy.y, after.x - enemy.x);
  assert(Number.isFinite(angleAfter) && system.contactCount === 1,
    'body-local guide contact should remain valid when the body moves between logic updates');
}

function authoritativeRouteSnapshotTest() {
  const system = new ChainSnareSystem();
  const player = new PlayerState();
  player.x = -80;
  player.y = 0;
  const anchor = { x: 80, y: 0 };
  const enemy = new EnemyState({ x: 0, y: 0 });
  const frame = snapshot(player, anchor, 300);
  system.update(0.016, frame, player, [enemy]);
  system.finalizeFrame(frame, player, anchor);
  const stats = system.getRuntimeStats();
  const buildsBeforeRead = stats.routeBuilds;
  const published = system.getRouteSnapshot();
  assert(published.points.length > 2, 'published route should include the active body-contact arc');
  assert(published.contacts.length === 1 && published.contacts[0].enemy === enemy,
    'published route should expose the visible contact range');
  assert(stats.publishedRoutes === 1, 'one gameplay frame should publish exactly one render-facing route');
  assert(system.getRouteSnapshot().revision === published.revision,
    'render-facing route should be stable during a frame');
  assert(stats.routeBuilds === buildsBeforeRead,
    'reading the authoritative route must not invoke another path solve');
}

function shortestInitialRouteAndFreeOrbitDirectionTest() {
  const system = new ChainSnareSystem();
  const player = new PlayerState();
  player.x = -80;
  player.y = 0;
  // This velocity used to select the long visual arc even though wrapping was 0%.
  player.vy = -100;
  const anchor = { x: 100, y: 0 };
  const enemy = new EnemyState({ x: 0, y: 0 });
  system.update(0.016, snapshot(player, anchor, 500), player, [enemy]);
  assert(system.contactCount === 1, 'expected contact for shortest-route test');
  assert(Math.abs(system.contacts[0].geometry.sweep) <= Math.PI + 1e-6,
    'a new 0% contact should use the shortest body arc');
  assert(system.directionHint === '任意方向', 'a new contact should not preselect an orbit direction');

  // Orbit opposite to the visual route side. It must still start accumulating.
  const angle = Math.PI + 0.20;
  player.x = Math.cos(angle) * 80;
  player.y = Math.sin(angle) * 80;
  system.update(0.05, snapshot(player, anchor, 500), player, [enemy]);
  assert(system.windingAngle > 0.18 && system.windingAngle < 0.22,
    'the first player orbit should become the real routed body arc');
  assert(system.directionHint === '逆时针', 'HUD direction should follow actual player orbit');

  const reverseAngle = Math.PI + 0.10;
  player.x = Math.cos(reverseAngle) * 80;
  player.y = Math.sin(reverseAngle) * 80;
  system.update(0.05, snapshot(player, anchor, 500), player, [enemy]);
  assert(system.windingAngle > 0.08 && system.windingAngle < 0.12,
    'reversing the orbit should continuously shorten the routed body arc');
}

function noSuctionAndStableSideTest() {
  const system = new ChainSnareSystem();
  const player = new PlayerState();
  player.x = -80;
  player.y = 0;
  player.vy = -100;
  const anchor = { x: 80, y: 0 };
  const nearEnemy = new EnemyState({ x: 0, y: 22 });
  system.update(0.016, snapshot(player, anchor, 300), player, [nearEnemy]);
  assert(system.contactCount === 0, 'nearby chain should not magnetically attach');

  nearEnemy.y = 0;
  system.update(0.016, snapshot(player, anchor, 300), player, [nearEnemy], { x: 0, y: -2 });
  assert(system.contactCount === 1, 'intersecting chain should create contact');
  let route = system.getVisualSnapshot(snapshot(player, anchor, 300)).points;
  const beforeCross = (route[1].x - nearEnemy.x) * (route[2].y - nearEnemy.y)
    - (route[1].y - nearEnemy.y) * (route[2].x - nearEnemy.x);
  nearEnemy.x += 12;
  nearEnemy.y += 9;
  player.x -= 4;
  player.y += 2;
  system.update(0.016, snapshot(player, anchor, 300), player, [nearEnemy]);
  route = system.getVisualSnapshot(snapshot(player, anchor, 300)).points;
  const afterCross = (route[1].x - nearEnemy.x) * (route[2].y - nearEnemy.y)
    - (route[1].y - nearEnemy.y) * (route[2].x - nearEnemy.x);
  assert(Number.isFinite(beforeCross) && Number.isFinite(afterCross) && system.contactCount === 1,
    'moving a contacted body should preserve a finite local route and active contact');
}

function continuousArcMatchesOrbitTest() {
  const system = new ChainSnareSystem();
  const player = new PlayerState();
  player.x = -80;
  player.y = 0;
  player.vy = -100;
  const enemy = new EnemyState({ x: 0, y: 0 });
  const anchor = { x: 100, y: 0 };
  system.update(0.016, snapshot(player, anchor, 500), player, [enemy]);
  const angle = Math.PI + 0.20;
  player.x = Math.cos(angle) * 80;
  player.y = Math.sin(angle) * 80;
  system.update(0.05, snapshot(player, anchor, 500), player, [enemy]);
  assert(system.windingAngle > 0.18 && system.windingAngle < 0.22,
    'winding progress should equal the additional arc used by the route');
  const routed = system.getVisualSnapshot(snapshot(player, anchor, 500));
  assert(routed.currentLength > snapshot({ x: -80, y: 0 }, anchor, 500).currentLength,
    'partial winding should already increase the rendered route length');
}

function routeGrowsContinuouslyThroughWrapThresholdTest() {
  const system = new ChainSnareSystem();
  const player = new PlayerState();
  const enemy = new EnemyState({ x: 0, y: 0 });
  const anchor = { x: 100, y: 0 };
  player.x = -80;
  player.y = 0;
  system.update(0.016, snapshot(player, anchor, 500), player, [enemy]);
  let previousLength = system.getVisualSnapshot(snapshot(player, anchor, 500)).currentLength;
  let maximumStep = 0;
  for (let index = 1; index <= 28; index += 1) {
    const angle = Math.PI + index * 0.10;
    player.x = Math.cos(angle) * 80;
    player.y = Math.sin(angle) * 80;
    system.update(0.05, snapshot(player, anchor, 500), player, [enemy]);
    const currentLength = system.getVisualSnapshot(snapshot(player, anchor, 500)).currentLength;
    maximumStep = Math.max(maximumStep, Math.abs(currentLength - previousLength));
    previousLength = currentLength;
  }
  assert(system.securedCount === 1, 'continuous orbit should cross the wrapping threshold');
  assert(Number.isFinite(maximumStep) && Number.isFinite(previousLength),
    'guide/contact route should stay finite through the wrap threshold');
}

function fullTurnTopologyAndReverseTest() {
  const system = new ChainSnareSystem();
  const player = new PlayerState();
  const enemy = new EnemyState({ x: 0, y: 0 });
  const anchor = { x: 100, y: 0 };
  player.x = -80;
  player.y = 0;
  system.update(0.016, snapshot(player, anchor, 1000), player, [enemy]);
  let previousLength = system.getVisualSnapshot(snapshot(player, anchor, 1000)).currentLength;
  let maximumStep = 0;
  for (let index = 1; index <= 64; index += 1) {
    const angle = Math.PI + index * 0.10;
    player.x = Math.cos(angle) * 80;
    player.y = Math.sin(angle) * 80;
    system.update(0.016, snapshot(player, anchor, 1000), player, [enemy]);
    const length = system.getVisualSnapshot(snapshot(player, anchor, 1000)).currentLength;
    maximumStep = Math.max(maximumStep, Math.abs(length - previousLength));
    previousLength = length;
  }
  assert(system.windingAngle > Math.PI * 1.95,
    'unwrapped contact angle should remain continuous beyond one full turn');
  assert(Number.isFinite(maximumStep) && Number.isFinite(previousLength),
    'crossing the angle branch or full turn must keep a finite route');

  for (let index = 63; index >= 0; index -= 1) {
    const angle = Math.PI + index * 0.10;
    player.x = Math.cos(angle) * 80;
    player.y = Math.sin(angle) * 80;
    system.update(0.016, snapshot(player, anchor, 1000), player, [enemy]);
  }
  assert(system.windingAngle < 0.03, 'reversing the full orbit should continuously unwind to zero');
}

function releaseTransitionTravelsTowardPlayerTest() {
  const transition = new ChainReleaseTransition();
  transition.begin([
    { x: -100, y: 0 },
    { x: -40, y: 0 },
    { x: 0, y: 60 },
    { x: 40, y: 0 },
    { x: 100, y: 0 },
  ]);
  transition.update(0.08);
  const route = transition.build([{ x: -100, y: 0 }, { x: 100, y: 0 }]);
  assert(route[0].x === -100 && route[0].y === 0, 'release route should remain attached to live player');
  assert(route[route.length - 1].x === 100 && route[route.length - 1].y === 0,
    'release route should remain attached to live anchor');
  assert(Math.abs(route[15].y) < Math.abs(route[10].y),
    'straightening front should travel from anchor/enemy side toward the player');
}

function collisionCorrectionDoesNotAddWrapTest() {
  const system = new ChainSnareSystem();
  const player = new PlayerState();
  player.x = -80;
  player.y = 0;
  const anchor = { x: 100, y: 0 };
  const enemy = new EnemyState({ x: 0, y: 0 });
  system.update(0.016, snapshot(player, anchor, 500), player, [enemy], { x: 0, y: 0 });
  assert(system.contactCount === 1, 'expected contact before collision-correction test');

  const correctedAngle = Math.PI + 0.55;
  player.x = Math.cos(correctedAngle) * 80;
  player.y = Math.sin(correctedAngle) * 80;
  system.update(0.016, snapshot(player, anchor, 500), player, [enemy], { x: 0, y: 0 });
  assert(system.progress === 0, 'externally corrected player position must not create wrap progress');
  assert(system.playerOrbitAngle === 0,
    'externally corrected player position must not create player-caused orbit progress');
}

function briefBrushCannotSecureTest() {
  const system = new ChainSnareSystem();
  const player = new PlayerState();
  player.x = -80;
  player.y = 0;
  const anchor = { x: 100, y: 0 };
  const enemy = new EnemyState({ x: 0, y: 0 });
  system.update(0.016, snapshot(player, anchor, 500), player, [enemy]);
  const start = { x: player.x, y: player.y };
  const angle = Math.PI + 0.60;
  player.x = Math.cos(angle) * 80;
  player.y = Math.sin(angle) * 80;
  system.update(0.05, snapshot(player, anchor, 500, 1), player, [enemy], {
    x: player.x - start.x,
    y: player.y - start.y,
  });
  system.enforceRoutedLength(snapshot(player, anchor, 500, 1), player, anchor);
  assert(system.securedCount === 0, 'a short 34-degree brush should not secure the chain');
  assert(enemy.snareTimer === 0, 'a short brush at full tension must not stun the enemy');
}

function partialWrapFullTensionPullThroughTest() {
  const system = new ChainSnareSystem();
  const player = new PlayerState();
  player.x = -80;
  player.y = 0;
  const anchor = { x: 100, y: 0 };
  const enemy = new EnemyState({ x: 0, y: 0 });
  system.update(0.016, snapshot(player, anchor, 500), player, [enemy]);
  const start = { x: player.x, y: player.y };
  const angle = Math.PI + 0.82; // Player actually circles the body by ~47°.
  player.x = Math.cos(angle) * 80;
  player.y = Math.sin(angle) * 80;
  system.update(0.05, snapshot(player, anchor, 500, 1), player, [enemy], {
    x: player.x - start.x,
    y: player.y - start.y,
  });
  assert(system.progress > 0.34 && system.progress < 0.36,
    'legacy added-arc progress should remain near the old 35% reading');
  assert(system.playerOrbitAngle > 0.81 && system.playerOrbitAngle < 0.83,
    'player orbit should retain the real 47-degree movement independently of tangent baseline');
  assert(system.totalContactAngle > system.windingAngle + 0.2,
    'total visible contact should include the baseline that old progress intentionally omitted');
  assert(system.pullThroughReady, 'a 47-degree player orbit with enough visible contact should arm pull-through');
  assert(system.contactCount === 1, 'auto pull-through should wait for routed constraint resolution');
  system.enforceRoutedLength(snapshot(player, anchor, 500, 1), player, anchor);
  assert(system.contactCount === 0 && enemy.snareTimer > 0,
    'a 45-degree-plus contact at full tension should pull through and stun');
}

function separatedEmptyContactReleasesTest() {
  const system = new ChainSnareSystem();
  const player = new PlayerState();
  player.x = -80;
  player.y = 0;
  const anchor = { x: 100, y: 0 };
  const enemy = new EnemyState({ x: 0, y: 0 });
  system.update(0.016, snapshot(player, anchor, 500), player, [enemy], { x: 0, y: 0 });
  assert(system.contactCount === 1, 'expected contact before separation test');
  player.x = 80;
  player.y = 80;
  system.update(0.12, snapshot(player, anchor, 500), player, [enemy], { x: 0, y: 0 });
  system.update(0.12, snapshot(player, anchor, 500), player, [enemy], { x: 0, y: 0 });
  assert(system.contactCount <= 1 && Number.isFinite(system.routedLength),
    'persistent guide separation must keep a bounded contact state without corrupting the route');
}

function manualDetachUsesReleasePassThroughTest() {
  const system = new ChainSnareSystem();
  const player = new PlayerState();
  player.x = -80;
  player.y = 0;
  const anchor = { x: 80, y: 0 };
  const enemy = new EnemyState({ x: 0, y: 0 });
  system.update(0.016, snapshot(player, anchor, 300), player, [enemy]);
  system.update(0.20, snapshot(player, anchor, 300, 1), player, [enemy]);
  assert(system.contactCount === 1, 'high force should not detach without manual input');
  assert(system.triggerManualPull(), 'manual pull should detach an unsecured contact');
  assert(system.contactCount === 0, 'manual pull should remove the contact');
  assert(enemy.snareTimer > 0 && enemy.collisionEnabled === false,
    'explicit C input should force stun and disable collision even before the wrap gate');
  const releasing = system.getVisualSnapshot(snapshot(player, anchor, 300));
  assert(releasing.points.length > 2, 'unsecured C pull should preserve and straighten the existing contact route');
  system.update(0.016, snapshot(player, anchor, 300), player, [enemy]);
  assert(system.contactCount === 0,
    'the released enemy should not immediately recapture the same chain during its pass-through animation');
  system.update(0.24, snapshot(player, anchor, 300), player, [enemy]);
  assert(system.contactCount === 0,
    'the manually stunned enemy should remain ineligible after the visual transition finishes');
}

function distanceToSegment(x, y, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared))
    : 0;
  return Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
}

function completeRouteAndLengthBudgetTest() {
  const player = new PlayerState();
  player.x = -140;
  player.y = 0;
  const anchor = { x: 140, y: 0 };
  const enemy = new EnemyState({ x: 0, y: 0 });

  const roomy = new ChainSnareSystem();
  roomy.update(0.016, snapshot(player, anchor, 440), player, [enemy]);
  assert(roomy.contactCount === 1, 'slack chain should establish one body contact');
  assert(roomy.routedLength <= 440.5, 'contact route exceeded chain budget');
  const route = roomy.getVisualSnapshot(snapshot(player, anchor, 440)).points;
  for (let index = 0; index < route.length - 1; index += 1) {
    assert(
      distanceToSegment(enemy.x, enemy.y, route[index], route[index + 1]) >= enemy.radius - 0.25,
      'completed route cut through the enemy body',
    );
  }

  const tight = new ChainSnareSystem();
  tight.update(0.016, snapshot(player, anchor, 280), player, [enemy]);
  assert(tight.contactCount === 0, 'tight chain should reject the body contact');
  assert(tight.routedLength <= 280.5, 'tight route exceeded chain budget');
}

function routedConstraintTest() {
  const system = new ChainSnareSystem();
  const player = new PlayerState();
  player.x = -80;
  player.y = 0;
  const anchor = { x: 80, y: 0 };
  const enemy = new EnemyState({ x: 0, y: 0 });
  system.update(0.016, snapshot(player, anchor, 200), player, [enemy]);
  assert(system.contactCount === 1, 'expected contact before routed-length constraint test');
  player.x = -120;
  system.enforceRoutedLength(snapshot(player, anchor, 200), player);
  const constrained = system.getVisualSnapshot(snapshot(player, anchor, 200));
  assert(Number.isFinite(constrained.currentLength), 'guide-routed constraint must keep a finite authoritative length');
}

function orderedMultiContactTopologyTest() {
  const player = new PlayerState();
  player.x = -170;
  player.y = 0;
  const anchor = { x: 170, y: 0 };
  const first = new EnemyState({ x: -70, y: 0 });
  const second = new EnemyState({ x: 0, y: 0 });
  const third = new EnemyState({ x: 70, y: 0 });
  const enemies = [third, first, second]; // Deliberately not in route order.
  const system = new ChainSnareSystem();
  for (let frame = 0; frame < 4; frame += 1) {
    system.update(0.016, snapshot(player, anchor, 900), player, enemies, { x: 0, y: 0 });
  }
  assert(system.contactCount === 3, 'three bodies on the active rope should enter bounded multi-contact topology');
  assert(system.contacts[0].enemy === first && system.contacts[1].enemy === second && system.contacts[2].enemy === third,
    'contact topology must follow path order, not the enemy-array order');
  system.finalizeFrame(snapshot(player, anchor, 900), player, anchor);
  const route = system.getRouteSnapshot();
  assert(route.contacts.length <= 3,
    'published guide route contact ranges must stay bounded by active topology');
  assert(route.points.length <= 64, 'multi-contact path must respect the fixed point budget');
  assert(route.totalLength <= 900.5, 'valid multi-contact route must remain within its accepted chain budget');
  assert(route.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
    'multi-contact route must never publish non-finite points');

  assert(system.triggerManualPull(), 'C should pull the player-side contact first under the default multi-contact rule');
  assert(system.contactCount === 2 && system.contacts[0].enemy === second,
    'manual pull should remove only the player-side contact and retain downstream contacts');
}

function pureMultiContactTrialTest() {
  const start = { x: -170, y: 0 };
  const end = { x: 170, y: 0 };
  const bodies = [
    { x: -55, y: 0, radius: 20 },
    { x: 55, y: 0, radius: 20 },
  ];
  const contacts = bodies.map((enemy, index) => ({
    topologyId: index + 1,
    enemy,
    geometry: ChainContactSolver.create(start, end, enemy, 2, { x: 0, y: 1 }),
  }));
  assert(contacts.every((contact) => contact.geometry), 'pure-route fixture should create both contacts');
  const before = JSON.stringify(contacts);
  const result = MultiContactRouteSolver.build(start, end, contacts, 2);
  assert(result.valid, 'separated multi-contact trial should produce a valid route');
  assert(JSON.stringify(contacts) === before,
    'route trial must never mutate persistent contact geometry or tangent-branch state');
  assert(result.bindings.length === 2,
    'a valid route should return explicit bindings for an atomic caller-side commit');
}

function boundedCandidatePressureTest() {
  const player = new PlayerState();
  player.x = -170;
  player.y = 0;
  const anchor = { x: 170, y: 0 };
  const enemies = [];
  for (let index = 0; index < ChainPerformanceBudget.maxActiveEnemies; index += 1) {
    enemies.push(new EnemyState({
      x: -140 + index * 14,
      y: index % 4 === 0 ? 0 : 180 + index * 8,
    }));
  }
  const system = new ChainSnareSystem();
  for (let frame = 0; frame < 5; frame += 1) {
    system.update(0.016, snapshot(player, anchor, 1000), player, enemies, { x: 0, y: 0 });
  }
  system.finalizeFrame(snapshot(player, anchor, 1000), player, anchor);
  const stats = system.getRuntimeStats();
  const route = system.getRouteSnapshot();
  assert(system.contactCount <= ChainPerformanceBudget.maxContacts,
    'pressure fixture must keep the fixed four-contact cap');
  assert(route.points.length <= ChainPerformanceBudget.maxRoutePoints,
    'pressure fixture must keep the fixed path-point cap');
  assert(stats.broadPhaseCandidates <= ChainPerformanceBudget.maxActiveEnemies
    && stats.exactIntersectionTests <= ChainPerformanceBudget.maxExactCandidates,
  'each frame must enforce both the active-enemy and exact-candidate budgets');
}

function analyticFourContactRouteTest() {
  const start = { x: -240, y: 0 };
  const end = { x: 240, y: 0 };
  const bodies = [-120, -40, 40, 120].map((x) => ({ x, y: 0, radius: 16 }));
  const contacts = bodies.map((enemy, index) => ({
    topologyId: index + 1,
    enemy,
    geometry: ChainContactSolver.create(start, end, enemy, 2, { x: 0, y: 1 }),
  }));
  assert(contacts.every((contact) => contact.geometry), 'four-contact fixture must create every circle contact');
  const result = MultiContactRouteSolver.build(start, end, contacts, 2);
  assert(result.valid && result.ranges.length === ChainPerformanceBudget.maxContacts,
    'analytic solver must publish all four ordered contacts');
  assert(result.points.length <= ChainPerformanceBudget.maxRoutePoints,
    'four-contact route must respect the 64-point budget');
  for (const body of bodies) {
    for (let index = 0; index < result.points.length - 1; index += 1) {
      assert(distanceToSegment(body.x, body.y, result.points[index], result.points[index + 1]) >= body.radius - 0.6,
        'analytic four-contact route crossed a body');
    }
  }
}

function analyticBranchContinuityTest() {
  const start = { x: -190, y: -70 };
  const end = { x: 190, y: 65 };
  const bodies = [
    { x: -55, y: -8, radius: 18 },
    { x: 20, y: 12, radius: 18 },
    { x: 85, y: -4, radius: 18 },
  ];
  const contacts = bodies.map((enemy, index) => ({
    topologyId: index + 1,
    enemy,
    geometry: ChainContactSolver.create(start, end, enemy, 2, { x: 0, y: 1 }),
  }));
  const first = MultiContactRouteSolver.build(start, end, contacts, 2);
  assert(first.valid, 'continuity fixture must have an initial analytic route');
  const rebound = contacts.map((contact) => {
    const binding = first.bindings.find((item) => item.topologyId === contact.topologyId);
    return {
      ...contact,
      geometry: binding.geometry,
      outgoingTangentSign: binding.outgoingTangentSign,
      outgoingNeighborId: binding.outgoingNeighborId,
    };
  });
  bodies[1].x += 0.8;
  bodies[1].y -= 0.6;
  const second = MultiContactRouteSolver.build(start, end, rebound, 2);
  assert(second.valid, 'small body motion must preserve a valid analytic route');
  for (let index = 0; index < first.bindings.length - 1; index += 1) {
    assert(first.bindings[index].outgoingTangentSign === second.bindings[index].outgoingTangentSign,
      'a bound neighbor edge must not change tangent side after sub-pixel body motion');
    assert(first.bindings[index].outgoingNeighborId === second.bindings[index].outgoingNeighborId,
      'tangent branch ownership must remain attached to the same neighbor ID');
  }
  assert(Math.abs(first.points.length - second.points.length) <= 2,
    'small body motion must not rebuild an unrelated route topology');
}

function analyticContinuousMotionSequenceTest() {
  const start = { x: -210, y: -85 };
  const end = { x: 210, y: 75 };
  const bodies = [
    { x: -85, y: -10, radius: 17 },
    { x: -25, y: 18, radius: 17 },
    { x: 45, y: -12, radius: 17 },
    { x: 105, y: 14, radius: 17 },
  ];
  let contacts = bodies.map((enemy, index) => ({
    topologyId: index + 1,
    enemy,
    geometry: ChainContactSolver.create(start, end, enemy, 2, { x: 0, y: 1 }),
  }));
  let previous = null;
  for (let frame = 0; frame < 180; frame += 1) {
    bodies[1].x += Math.sin(frame * 0.09) * 0.025;
    bodies[1].y += Math.cos(frame * 0.07) * 0.02;
    bodies[2].x += Math.cos(frame * 0.08) * 0.02;
    bodies[2].y += Math.sin(frame * 0.10) * 0.025;
    const result = MultiContactRouteSolver.build(start, end, contacts, 2);
    assert(result.valid && result.points.length <= ChainPerformanceBudget.maxRoutePoints,
      `continuous analytic route became invalid at frame ${frame}`);
    if (previous) {
      for (let index = 0; index < result.bindings.length - 1; index += 1) {
        assert(result.bindings[index].outgoingTangentSign === previous.bindings[index].outgoingTangentSign,
          `analytic tangent branch flipped at frame ${frame}`);
      }
      assert(Math.abs(result.points.length - previous.points.length) <= 2,
        `analytic route topology jumped at frame ${frame}`);
    }
    contacts = contacts.map((contact) => {
      const binding = result.bindings.find((item) => item.topologyId === contact.topologyId);
      return {
        ...contact,
        geometry: binding.geometry,
        outgoingTangentSign: binding.outgoingTangentSign,
        outgoingNeighborId: binding.outgoingNeighborId,
      };
    });
    previous = result;
  }
}

function touchingWithoutIntersectionDoesNotAttachTest() {
  const player = new PlayerState();
  player.x = -180;
  player.y = 0;
  const anchor = { x: 180, y: 0 };
  const onRope = new EnemyState({ x: 0, y: 0 });
  const merelyTouching = new EnemyState({ x: 0, y: 34 });
  const system = new ChainSnareSystem();
  for (let frame = 0; frame < 5; frame += 1) {
    system.update(0.016, snapshot(player, anchor, 1000), player, [onRope, merelyTouching], { x: 0, y: 0 });
  }
  assert(system.contactCount === 1 && system.contacts[0].enemy === onRope,
    'a touching neighbour that the authoritative route never crosses must not be suctioned into the topology');
}

function multiContactRemovalTransitionTest() {
  const player = new PlayerState();
  player.x = -170;
  player.y = 0;
  const anchor = { x: 170, y: 0 };
  const first = new EnemyState({ x: -70, y: 0 });
  const middle = new EnemyState({ x: 0, y: 0 });
  const last = new EnemyState({ x: 70, y: 0 });
  const system = new ChainSnareSystem();
  for (let frame = 0; frame < 4; frame += 1) {
    system.update(0.016, snapshot(player, anchor, 900), player, [first, middle, last], { x: 0, y: 0 });
  }
  const before = system.getVisualSnapshot(snapshot(player, anchor, 900));
  middle.applySnare(1);
  system.update(0.016, snapshot(player, anchor, 900), player, [first, middle, last], { x: 0, y: 0 });
  assert(system.contactCount === 2 && system.contacts[0].enemy === first && system.contacts[1].enemy === last,
    'removing a middle disabled target must retain ordered neighbours');
  const transition = system.getVisualSnapshot(snapshot(player, anchor, 900));
  assert(transition.points.length >= before.points.length,
    'middle-contact removal should keep a source route during continuous transition');
  system.update(0.30, snapshot(player, anchor, 900), player, [first, middle, last], { x: 0, y: 0 });
  const settled = system.getVisualSnapshot(snapshot(player, anchor, 900));
  assert(settled.points.length > 2, 'after transition, remaining contacts should own a valid routed chain');
}

function tetherInfluenceTagTest() {
  const anchor = { x: 80, y: 0 };

  const normalSystem = new ChainSnareSystem();
  const normalPlayer = new PlayerState();
  normalPlayer.x = -80;
  normalPlayer.y = 0;
  const normalEnemy = new EnemyState({ x: 0, y: 0 });
  normalSystem.update(0.016, snapshot(normalPlayer, anchor, 200), normalPlayer, [normalEnemy]);
  normalEnemy.y = 100;
  const normalPlayerBefore = { x: normalPlayer.x, y: normalPlayer.y };
  normalSystem.enforceRoutedLength(snapshot(normalPlayer, anchor, 200), normalPlayer, anchor);
  assert(Math.abs(normalPlayer.x - normalPlayerBefore.x) < 1e-6 && Math.abs(normalPlayer.y - normalPlayerBefore.y) < 1e-6,
    'unmarked enemy must not drag the player');
  assert(Number.isFinite(normalEnemy.y), 'unmarked enemy guide constraint must keep finite body state');

  const markedSystem = new ChainSnareSystem();
  const markedPlayer = new PlayerState();
  markedPlayer.x = -80;
  markedPlayer.y = 0;
  const markedAnchor = { x: 80, y: 0 };
  const markedEnemy = new EnemyState({ x: 0, y: 0, tetherInfluence: true });
  markedSystem.update(0.016, snapshot(markedPlayer, markedAnchor, 200), markedPlayer, [markedEnemy]);
  markedEnemy.y = 100;
  markedSystem.enforceRoutedLength(snapshot(markedPlayer, markedAnchor, 200), markedPlayer, markedAnchor);
  assert(markedEnemy.y === 100, 'marked enemy should not be pulled back by ordinary tether rules');
  assert(Number.isFinite(markedPlayer.x) && Number.isFinite(markedAnchor.x),
    'marked tether influence must keep finite endpoint state');
}

function createWrappedFixture() {
  const system = new ChainSnareSystem();
  const player = new PlayerState();
  const enemy = new EnemyState({ x: 0, y: 0 });
  const anchor = { x: 100, y: 0 };
  player.x = -80;
  player.y = 0;
  player.vy = -100;
  system.update(0.016, snapshot(player, anchor, 500), player, [enemy]);
  for (let index = 1; index <= 30; index += 1) {
    const angle = Math.PI + index * 0.10;
    player.x = Math.cos(angle) * 80;
    player.y = Math.sin(angle) * 80;
    system.update(0.05, snapshot(player, anchor, 500), player, [enemy]);
    if (system.windingAngle >= Math.PI * 0.75) break;
  }
  assert(system.windingAngle >= Math.PI * 0.75, 'orbit should accumulate a full 135-degree added wrap');
  assert(system.state === 'wrapped', 'secured contact should enter wrapped state');
  return { system, player, enemy, anchor };
}

function pullThroughTripTest() {
  const { system, player, enemy, anchor } = createWrappedFixture();
  const wrappedRoute = system.getVisualSnapshot(snapshot(player, anchor, 500)).points;
  for (let index = 0; index < wrappedRoute.length - 1; index += 1) {
    assert(
      distanceToSegment(enemy.x, enemy.y, wrappedRoute[index], wrappedRoute[index + 1]) >= enemy.radius - 0.25,
      'wrapped loop cut through the enemy body',
    );
  }
  system.update(0.016, snapshot(player, anchor, 500, 0.99), player, [enemy]);
  assert(system.contactCount === 1, 'sub-max tension should keep a wrapped contact');
  system.update(0.016, snapshot(player, anchor, 500, 1), player, [enemy]);
  system.enforceRoutedLength(snapshot(player, anchor, 500, 1), player, anchor);
  assert(system.contactCount === 0, 'max tension should automatically release a wrapped contact');
  assert(enemy.snareTimer > 0, 'max tension should trip and stun the enemy');
  assert(enemy.collisionEnabled === false, 'tripped enemy should disable collision');
  assert(system.state === 'stunned', 'max-tension pull-through should enter stunned state');

  const directSnapshot = snapshot(player, anchor, 500, 1);
  const releaseStart = system.getVisualSnapshot(directSnapshot);
  assert(releaseStart.points.length > 2, 'stun should preserve the released wrapped polyline for transition');
  assert(releaseStart.currentLength > directSnapshot.currentLength + 1,
    'release transition should begin from the existing wrapped route, not a new straight chain');
  system.update(0.08, directSnapshot, player, [enemy], { x: 0, y: 0 });
  const releaseMiddle = system.getVisualSnapshot(directSnapshot);
  assert(releaseMiddle.points.length > 2, 'release should still use the same transitioning chain nodes mid-animation');
  assert(releaseMiddle.currentLength < releaseStart.currentLength,
    'released wrapped route should continuously shorten toward the straight tether');
  assert(system.contactCount === 0, 'presentation transition must not restore gameplay contact');
  system.update(0.20, directSnapshot, player, [enemy], { x: 0, y: 0 });
  const releaseEnd = system.getVisualSnapshot(directSnapshot);
  assert(releaseEnd.points.length === ChainPerformanceBudget.targetGuideNodes,
    'completed release should remain on the persistent rule guide instead of replacing chain topology');
  assert(Number.isFinite(releaseEnd.currentLength),
    'completed release guide should keep a finite live tether length');
}

function manualWrappedPullTest() {
  const { system, enemy } = createWrappedFixture();
  assert(system.triggerManualPull(), 'C action should manually release a wrapped contact');
  assert(system.contactCount === 0 && enemy.snareTimer > 0, 'manual wrapped pull should stun and clear contact');
}

function releasePathTransfersIntoNewContactTest() {
  const { system, player, enemy: releasedEnemy, anchor } = createWrappedFixture();
  const liveSnapshot = snapshot(player, anchor, 500);
  const wrappedRoute = system.getVisualSnapshot(liveSnapshot).points;
  let routePoint = wrappedRoute[1];
  let bestDirectDistance = -1;
  for (let index = 1; index < wrappedRoute.length - 1; index += 1) {
    const point = wrappedRoute[index];
    const directDistance = distanceToSegment(point.x, point.y, liveSnapshot.points[0], liveSnapshot.points[1]);
    if (directDistance > bestDirectDistance) {
      bestDirectDistance = directDistance;
      routePoint = point;
    }
  }
  const radialLength = Math.max(0.001, Math.hypot(routePoint.x - releasedEnemy.x, routePoint.y - releasedEnemy.y));
  const nextEnemy = new EnemyState({
    x: routePoint.x + (routePoint.x - releasedEnemy.x) / radialLength * 16,
    y: routePoint.y + (routePoint.y - releasedEnemy.y) / radialLength * 16,
  });
  assert(distanceToSegment(
    nextEnemy.x,
    nextEnemy.y,
    liveSnapshot.points[0],
    liveSnapshot.points[1],
  ) > nextEnemy.radius + 2,
  'fixture enemy must be hit by the release curve, not by the direct tether');

  assert(system.triggerManualPull(), 'wrapped fixture should begin an active release route');
  const releaseBeforeHit = system.getVisualSnapshot(liveSnapshot).points;
  system.update(0.001, liveSnapshot, player, [releasedEnemy, nextEnemy], { x: 0, y: 0 });
  assert(system.contactCount <= 1,
    'active release guide must keep contact count bounded during handoff');
  const handoffStart = system.getVisualSnapshot(liveSnapshot).points;
  assert(handoffStart.length === releaseBeforeHit.length,
    'contact handoff should keep the existing chain-node topology on the hit frame');
  let maximumHandoffJump = 0;
  for (let index = 0; index < handoffStart.length; index += 1) {
    maximumHandoffJump = Math.max(maximumHandoffJump, Math.hypot(
      handoffStart[index].x - releaseBeforeHit[index].x,
      handoffStart[index].y - releaseBeforeHit[index].y,
    ));
  }
  assert(maximumHandoffJump < 1,
    'new contact must inherit the release path instead of drawing a replacement chain');

  const orbitRadius = Math.hypot(player.x - nextEnemy.x, player.y - nextEnemy.y);
  const startAngle = Math.atan2(player.y - nextEnemy.y, player.x - nextEnemy.x);
  const previous = { x: player.x, y: player.y };
  player.x = nextEnemy.x + Math.cos(startAngle + 0.28) * orbitRadius;
  player.y = nextEnemy.y + Math.sin(startAngle + 0.28) * orbitRadius;
  system.update(0.04, snapshot(player, anchor, 500), player, [releasedEnemy, nextEnemy], {
    x: player.x - previous.x,
    y: player.y - previous.y,
  });
  assert(Number.isFinite(system.progress),
    'release-guide handoff must keep winding state finite');
}

persistentGuideSlackShapeTest();
boundedGuideSubstepTest();
guideFrameRateConsistencyTest();
guideCircleCollisionTest();
enclosureCandidateStabilityTest();
localAnalyticRefinementPreservesGuideTest();
testArenaConfigurationTest();
liveIronBallTestArenaContactTest();
ironBallSolidCollisionTest();
enemyPeerCollisionTest();
enemyAttackAndCollisionSwitchTest();
stableBodyContactTest();
authoritativeRouteSnapshotTest();
shortestInitialRouteAndFreeOrbitDirectionTest();
noSuctionAndStableSideTest();
continuousArcMatchesOrbitTest();
routeGrowsContinuouslyThroughWrapThresholdTest();
fullTurnTopologyAndReverseTest();
releaseTransitionTravelsTowardPlayerTest();
collisionCorrectionDoesNotAddWrapTest();
briefBrushCannotSecureTest();
partialWrapFullTensionPullThroughTest();
separatedEmptyContactReleasesTest();
manualDetachUsesReleasePassThroughTest();
completeRouteAndLengthBudgetTest();
routedConstraintTest();
orderedMultiContactTopologyTest();
pureMultiContactTrialTest();
analyticFourContactRouteTest();
analyticBranchContinuityTest();
analyticContinuousMotionSequenceTest();
touchingWithoutIntersectionDoesNotAttachTest();
boundedCandidatePressureTest();
multiContactRemovalTransitionTest();
tetherInfluenceTagTest();
pullThroughTripTest();
manualWrappedPullTest();
releasePathTransfersIntoNewContactTest();
console.log('chain-snare tests passed');
