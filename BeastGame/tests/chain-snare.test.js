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

function testArenaConfigurationTest() {
  assert(ROOM_DEFINITIONS.length === 1, 'test build should expose one room only');
  const room = ROOM_DEFINITIONS[0];
  assert(room.mechanic === 'iron-ball', 'test room should use the iron-ball tether');
  assert(room.enemies.length === 2, 'test room should contain a release-handoff target');
  assert(Math.abs(room.enemies[1].y - room.enemies[0].y) > 18,
    'second enemy should start outside the initial straight-chain collision radius');
  assert(room.barrels.length === 0, 'test room should not contain barrels');
  const enemy = new EnemyState(room.enemies[0]);
  assert(Math.abs(enemy.speed - 100 * 2 / 3) < 1e-6, 'enemy speed should be two thirds of baseline');
  const player = new PlayerState();
  player.update(0.016, { x: 1, y: 0 }, { x: 1, y: 0 }, false, {
    left: -1000, right: 1000, bottom: -1000, top: 1000,
  });
  assert(Math.abs(player.vx - 238 * 2 / 3) < 1e-6, 'player speed should be two thirds of baseline');
  assert(new IronBallTether(player).maxLength === 296, 'test tether should use doubled chain length');
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
  assert(Math.abs(angleAfter - angleBefore) < 1e-6, 'body-local contact angle drifted');
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
  assert(Math.sign(beforeCross) === Math.sign(afterCross), 'contact arc flipped to the other body side');
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
  assert(maximumStep < 8, 'route length should not jump by a full body circumference at the threshold');
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
  assert(maximumStep < 8, 'crossing the angle branch or full turn must not jump route length');

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
  assert(system.contactCount === 0, 'an empty contact should release after the chain slides clear');
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
  assert(system.enforceRoutedLength(snapshot(player, anchor, 200), player), 'expected routed path to constrain player');
  const constrained = system.getVisualSnapshot(snapshot(player, anchor, 200));
  assert(constrained.currentLength <= 200.5, 'player remained outside routed chain length');
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
  assert(normalSystem.enforceRoutedLength(snapshot(normalPlayer, anchor, 200), normalPlayer, anchor), 'normal enemy movement should be constrained by chain');
  assert(Math.abs(normalPlayer.x - normalPlayerBefore.x) < 1e-6 && Math.abs(normalPlayer.y - normalPlayerBefore.y) < 1e-6,
    'unmarked enemy must not drag the player');
  assert(normalEnemy.y < 100, 'unmarked enemy should be pulled back instead of moving tether endpoints');

  const markedSystem = new ChainSnareSystem();
  const markedPlayer = new PlayerState();
  markedPlayer.x = -80;
  markedPlayer.y = 0;
  const markedAnchor = { x: 80, y: 0 };
  const markedEnemy = new EnemyState({ x: 0, y: 0, tetherInfluence: true });
  markedSystem.update(0.016, snapshot(markedPlayer, markedAnchor, 200), markedPlayer, [markedEnemy]);
  markedEnemy.y = 100;
  assert(markedSystem.enforceRoutedLength(snapshot(markedPlayer, markedAnchor, 200), markedPlayer, markedAnchor), 'marked enemy should move tether endpoints');
  assert(markedEnemy.y === 100, 'marked enemy should not be pulled back by ordinary tether rules');
  assert(markedPlayer.fallTimer > 0, 'marked tether influence should trip the player');
  assert(markedPlayer.x !== -80 || markedPlayer.y !== 0 || markedAnchor.x !== 80 || markedAnchor.y !== 0,
    'marked enemy should drag player or anchor');
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
  assert(releaseEnd.points.length === directSnapshot.points.length,
    'completed release should hand back to the ordinary straight tether');
  assert(Math.abs(releaseEnd.currentLength - directSnapshot.currentLength) < 1e-6,
    'completed release route should exactly match the live straight tether');
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
  assert(system.contactCount === 1 && system.candidateTarget === nextEnemy,
    'active release route should transfer contact to the new enemy it actually intersects');
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
  assert(system.progress > 0,
    'the transferred contact should immediately continue through the ordinary winding calculation');
}

testArenaConfigurationTest();
liveIronBallTestArenaContactTest();
ironBallSolidCollisionTest();
enemyPeerCollisionTest();
enemyAttackAndCollisionSwitchTest();
stableBodyContactTest();
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
tetherInfluenceTagTest();
pullThroughTripTest();
manualWrappedPullTest();
releasePathTransfersIntoNewContactTest();
console.log('chain-snare tests passed');
