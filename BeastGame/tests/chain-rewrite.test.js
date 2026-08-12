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
  const output = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
  }).outputText;
  const localRequire = (request) => request.startsWith('.')
    ? loadModule(path.resolve(path.dirname(absolute), `${request}.ts`))
    : require(request);
  new Function('require', 'module', 'exports', output)(localRequire, module, module.exports);
  return module.exports;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function near(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`);
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
    : 0;
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}

const { ArenaMotionResolver } = loadModule(path.join(sourceRoot, 'ArenaMotionResolver.ts'));
const { ChainSimulation } = loadModule(path.join(sourceRoot, 'ChainSimulation.ts'));
const { ChainPerformanceBudget } = loadModule(path.join(sourceRoot, 'ChainPerformanceBudget.ts'));
const { EnemyState, PlayerState } = loadModule(path.join(sourceRoot, 'ArenaModel.ts'));
const { IronBallTether } = loadModule(path.join(sourceRoot, 'TetherSystem.ts'));

const bounds = { left: -500, right: 500, bottom: -300, top: 300 };

function playerMotionProposalDoesNotCommitTest() {
  const player = new PlayerState();
  const before = { x: player.x, y: player.y };
  const motion = player.prepareMotion(1 / 60, { x: 1, y: 0 }, { x: 1, y: 0 }, false);
  assert(motion.x > 0 && motion.y === 0, 'player must produce the requested motion proposal');
  near(player.x, before.x, 1e-9, 'prepareMotion must not commit x');
  near(player.y, before.y, 1e-9, 'prepareMotion must not commit y');
}

function ordinaryEnemyCannotSteerPlayerThroughChainTest() {
  const player = new PlayerState();
  player.x = 140;
  player.y = -80;
  const ball = new IronBallTether(player);
  ball.x = -140;
  ball.y = 0;
  ball.maxLength = 420;
  const enemy = new EnemyState({ x: 0, y: -40 });
  const resolver = new ArenaMotionResolver();
  const chain = new ChainSimulation();
  const proposal = { x: 0, y: 6 };
  const result = resolver.resolveIronBallFrame(player, ball, [enemy], bounds, proposal);
  const accepted = { x: player.x, y: player.y };
  chain.update(1 / 30, ball, player, [enemy], ball.maxLength);
  near(player.x, accepted.x, 1e-9, 'chain collision with an ordinary enemy must not rewrite player x');
  near(player.y, accepted.y, 1e-9, 'chain collision with an ordinary enemy must not rewrite player y');
  near(result.playerDelta.x, 0, 1e-9, 'unblocked proposal must not gain lateral x motion');
  near(result.playerDelta.y, proposal.y, 1e-9, 'unblocked proposal must preserve requested y motion');
}

function directLeashClipsOnceWithoutDirectionReversalTest() {
  const player = new PlayerState();
  player.x = 95;
  player.y = 0;
  const ball = new IronBallTether(player);
  ball.x = 0;
  ball.y = 0;
  ball.maxLength = 100;
  const result = new ArenaMotionResolver().resolveIronBallFrame(
    player,
    ball,
    [],
    bounds,
    { x: 10, y: 5 },
  );
  assert(result.leashClipped, 'movement beyond max length must be clipped');
  near(Math.hypot(player.x - ball.x, player.y - ball.y), 100, 1e-6, 'accepted endpoint must satisfy leash length');
  assert(result.playerDelta.y > 0, 'radial clipping must preserve the requested vertical direction');
  assert(result.playerDelta.x >= 0, 'radial clipping must not reverse requested horizontal movement');
}

function ballAndStunCollisionAuthorityTest() {
  const player = new PlayerState();
  player.x = 180;
  player.y = 0;
  const ball = new IronBallTether(player);
  ball.x = 0;
  ball.y = 0;
  ball.maxLength = 400;
  const enemy = new EnemyState({ x: 10, y: 0 });
  const resolver = new ArenaMotionResolver();
  resolver.resolveIronBallFrame(player, ball, [enemy], bounds, { x: 0, y: 0 });
  near(ball.x, 0, 1e-9, 'ordinary enemy collision must not push the iron ball');
  assert(enemy.x >= ball.radius + enemy.radius - 1e-6, 'iron ball must push an overlapping ordinary enemy clear');

  const stunned = new EnemyState({ x: 180, y: 40 });
  stunned.applySnare(1);
  const beforeY = player.y;
  resolver.resolveIronBallFrame(player, ball, [stunned], bounds, { x: 0, y: 40 });
  near(player.y, beforeY + 40, 1e-6, 'stunned enemy must not block player movement');
}

function taggedInfluenceIsTheOnlyChainDragExceptionTest() {
  const player = new PlayerState();
  player.x = 100;
  player.y = 0;
  const ball = new IronBallTether(player);
  ball.x = -100;
  ball.y = 0;
  const resolver = new ArenaMotionResolver();
  const ordinary = new EnemyState({ x: 0, y: 0 });
  assert(!resolver.applyTaggedTetherInfluence(player, ball, ordinary, { x: 8, y: 0 }, bounds),
    'ordinary enemies must be rejected by the explicit influence gate');
  near(player.x, 100, 1e-9, 'rejected influence must not move the player');
  near(ball.x, -100, 1e-9, 'rejected influence must not move the iron ball');

  const tagged = new EnemyState({ x: 0, y: 0, tetherInfluence: true });
  assert(resolver.applyTaggedTetherInfluence(player, ball, tagged, { x: 8, y: 0 }, bounds),
    'tagged enemy displacement must pass the explicit influence gate');
  near(player.x, 108, 1e-9, 'tagged influence must translate the player once');
  near(ball.x, -92, 1e-9, 'tagged influence must translate the iron ball once');
  assert(player.fallTimer > 0, 'tagged tether influence must trip the player');
}

function authoritativeRouteAndManualPullTest() {
  const chain = new ChainSimulation();
  const ball = { x: -160, y: 0 };
  const player = { x: 160, y: 0 };
  const enemy = new EnemyState({ x: 0, y: 0 });
  for (let frame = 0; frame < 20; frame += 1) chain.update(1 / 60, ball, player, [enemy], 420);
  const snapshot = chain.getRouteSnapshot();
  const minimumNodeDistance = Math.min(...snapshot.points.map((point) => Math.hypot(point.x - enemy.x, point.y - enemy.y)));
  assert(snapshot.points.length === ChainPerformanceBudget.targetGuideNodes,
    'render route must use the fixed authoritative node budget');
  near(snapshot.points[0].x, ball.x, 1e-9, 'route start must be the iron ball');
  near(snapshot.points[snapshot.points.length - 1].x, player.x, 1e-9, 'route end must be the player');
  assert(chain.contactCount === 1,
    `body on the chain must produce exactly one contact range; got ${chain.contactCount}, stun ${enemy.snareTimer}, tension ${snapshot.tension}, nearest ${minimumNodeDistance}`);
  assert(snapshot.contacts.length === 1, 'published contacts must match gameplay contacts');
  assert(snapshot.contacts[0].startLength < snapshot.contacts[0].endLength,
    'published contact range must contain real cumulative lengths');
  const revision = snapshot.revision;
  const pointReferences = snapshot.points.slice();
  assert(chain.getRouteSnapshot() === snapshot, 'snapshot reads must reuse the same bounded object');
  assert(snapshot.revision === revision, 'reading a snapshot must not mutate simulation state');

  assert(chain.triggerManualPull(), 'C must always start a same-chain pull transition');
  assert(enemy.snareTimer > 0, 'C must stun the currently contacted enemy without a wrap threshold');
  chain.update(1 / 60, ball, player, [enemy], 420);
  assert(chain.getRouteSnapshot().points.length === ChainPerformanceBudget.targetGuideNodes,
    'manual pull must preserve node identity instead of replacing the route');
  assert(chain.getRouteSnapshot().points.every((point, index) => point === pointReferences[index]),
    'manual pull must reuse the same published point objects instead of allocating a replacement chain');
}

function noContactManualPullStraightensSameNodesTest() {
  const chain = new ChainSimulation();
  const ball = { x: -160, y: 0 };
  const player = { x: 160, y: 0 };
  const obstacle = new EnemyState({ x: 0, y: 0 });
  for (let frame = 0; frame < 30; frame += 1) chain.update(1 / 60, ball, player, [obstacle], 420);
  obstacle.dead = true;
  chain.update(1 / 60, ball, player, [obstacle], 420);
  const before = chain.getRouteSnapshot().points.map((point) => ({ x: point.x, y: point.y }));
  const beforeDeviation = Math.max(...before.map((point) => Math.abs(point.y)));
  assert(beforeDeviation > 5, 'fixture must begin with a visibly bent chain');
  assert(chain.contactCount === 0, 'fixture must have no live contact before C');
  assert(chain.triggerManualPull(), 'C without contact must still start a pull transition');
  for (let frame = 0; frame < 8; frame += 1) chain.update(1 / 60, ball, player, [obstacle], 420);
  const after = chain.getRouteSnapshot().points;
  const afterDeviation = Math.max(...after.map((point) => Math.abs(point.y)));
  assert(after.length === before.length, 'straightening must keep the same node topology');
  assert(afterDeviation < beforeDeviation * 0.6, 'same-chain C transition must visibly move the bent route toward straight');
}

function orderedBoundedMultiContactTest() {
  const chain = new ChainSimulation();
  const ball = { x: -240, y: 0 };
  const player = { x: 240, y: 0 };
  const enemies = [-120, 0, 120].map((x) => new EnemyState({ x, y: 0 }));
  for (let frame = 0; frame < 30; frame += 1) chain.update(1 / 60, ball, player, enemies, 620);
  const contacts = chain.getRouteSnapshot().contacts;
  assert(contacts.length >= 2, 'one physical route must support simultaneous ordered contacts');
  assert(contacts.length <= ChainPerformanceBudget.maxContacts, 'contact count must respect mini-game budget');
  for (let index = 1; index < contacts.length; index += 1) {
    assert(contacts[index - 1].pointStart <= contacts[index].pointStart,
      'contacts must be published in chain order');
  }
}

function manualPullTargetsOnlyTheFirstContactTest() {
  const chain = new ChainSimulation();
  const ball = { x: -220, y: 0 };
  const player = { x: 220, y: 0 };
  const first = new EnemyState({ x: -80, y: 0 });
  const second = new EnemyState({ x: 80, y: 0 });
  for (let frame = 0; frame < 20; frame += 1) chain.update(1 / 60, ball, player, [first, second], 580);
  const contacts = chain.getRouteSnapshot().contacts;
  assert(contacts.length === 2, `fixture must establish two contacts; got ${contacts.length}`);
  const expectedTarget = contacts[0].enemy;
  const expectedSurvivor = contacts[1].enemy;
  chain.triggerManualPull();
  assert(expectedTarget.snareTimer > 0, 'C must stun the player-end first contact');
  assert(expectedSurvivor.snareTimer === 0, 'C must not bulk-stun later contacts');
}

function stableContactSideTest() {
  const chain = new ChainSimulation();
  const ball = { x: -160, y: 0 };
  const player = { x: 160, y: 0 };
  const enemy = new EnemyState({ x: 0, y: 0 });
  let establishedSign = 0;
  for (let frame = 0; frame < 120; frame += 1) {
    chain.update(1 / 60, ball, player, [enemy], 420);
    const points = chain.getRouteSnapshot().points;
    const middleY = points[Math.floor(points.length / 2)].y;
    if (Math.abs(middleY) <= 0.5) continue;
    const sign = Math.sign(middleY);
    if (establishedSign === 0) establishedSign = sign;
    assert(sign === establishedSign, 'stationary symmetric contact must not flip to the opposite side');
  }
  assert(establishedSign !== 0, 'fixture must establish a collision side');
}

function automaticWrapAndTensionStunTest() {
  const chain = new ChainSimulation();
  const ball = { x: -190, y: 0 };
  const player = { x: 190, y: 0 };
  const enemy = new EnemyState({ x: 0, y: 0 });
  let maximumAngle = 0;
  let maximumTension = 0;
  for (let frame = 0; frame < 150 && enemy.snareTimer <= 0; frame += 1) {
    const angle = Math.min(Math.PI * 0.82, frame / 90 * Math.PI * 0.82);
    player.x = Math.cos(angle) * 190;
    player.y = Math.sin(angle) * 190;
    chain.update(1 / 60, ball, player, [enemy], 390);
    maximumAngle = Math.max(maximumAngle, chain.totalContactAngle);
    maximumTension = Math.max(maximumTension, chain.lastPullForce);
  }
  assert(maximumAngle >= Math.PI * 0.25,
    `fixture must exceed the 45-degree wrap threshold; reached ${maximumAngle * 180 / Math.PI} degrees`);
  assert(maximumTension >= 0.98,
    `fixture must reach full tension; reached ${maximumTension}`);
  assert(enemy.snareTimer > 0, '45-degree local wrap plus full tension must automatically stun the enemy');
  const beforePoints = chain.getRouteSnapshot().points;
  const beforeDeviation = Math.max(...beforePoints.map((point) => distanceToSegment(point, ball, player)));
  for (let frame = 0; frame < 8; frame += 1) chain.update(1 / 60, ball, player, [enemy], 390);
  const afterDeviation = Math.max(...chain.getRouteSnapshot().points.map(
    (point) => distanceToSegment(point, ball, player),
  ));
  assert(afterDeviation < beforeDeviation * 0.7,
    'automatic stun must straighten the existing node chain instead of leaving the wrap frozen');
}

function localSegmentOverrunCannotFakeFullTensionTest() {
  const chain = new ChainSimulation();
  chain.update(0, { x: 0, y: 0 }, { x: 230, y: 0 }, [], 400);
  // White-box numerical fixture: 22 slack ten-unit segments plus one local
  // 280-unit solver overrun. The raw polyline is longer than the whole rope,
  // but only one physical segment is loaded; it cannot transmit full tension.
  for (let index = 0; index < chain.nodes.length; index += 1) {
    chain.nodes[index].x = index * 10;
    chain.nodes[index].y = 0;
  }
  chain.nodes[chain.nodes.length - 1].x = 500;
  chain.measureTension();
  assert(chain.lastPullForce < 0.01,
    `one local segment overrun must not report whole-chain tension; got ${chain.lastPullForce}`);
}

function twelveEnemyBudgetTest() {
  const chain = new ChainSimulation();
  const ball = { x: -260, y: -80 };
  const player = { x: 260, y: 80 };
  const enemies = [];
  for (let index = 0; index < ChainPerformanceBudget.maxActiveEnemies; index += 1) {
    enemies.push(new EnemyState({
      x: -180 + index % 6 * 72,
      y: -60 + Math.floor(index / 6) * 120,
    }));
  }
  const started = Date.now();
  for (let frame = 0; frame < 120; frame += 1) chain.update(1 / 60, ball, player, enemies, 720);
  const elapsed = Date.now() - started;
  const snapshot = chain.getRouteSnapshot();
  assert(snapshot.points.length === ChainPerformanceBudget.targetGuideNodes,
    '12 enemies must not increase the fixed chain node count');
  assert(snapshot.contacts.length <= ChainPerformanceBudget.maxContacts,
    '12 enemies must not exceed the four-contact gameplay budget');
  assert(elapsed < 1000, `12-enemy simulation smoke budget exceeded: ${elapsed} ms for 120 frames`);
}

function controllerUsesOnlyTheRewritePathTest() {
  const controller = fs.readFileSync(path.join(sourceRoot, 'ChainArenaController.ts'), 'utf8');
  assert(!controller.includes("from './ChainSnareSystem'"),
    'runtime controller must not import the retired chain authority');
  assert(!controller.includes('enforceRoutedLength('),
    'runtime controller must not apply the retired second position constraint');
  assert(!controller.includes('finalizeFrame('),
    'runtime controller must not publish a second chain route');
  assert(!controller.includes('resolveSolidBodyCollisions('),
    'runtime controller must not invoke the old coupled body/leash solver');
  assert(controller.includes('resolveIronBallFrame('),
    'runtime controller must commit iron-ball-room player motion through ArenaMotionResolver');
  assert(controller.includes('this.chain.update('),
    'runtime controller must publish ChainSimulation as the gameplay/render route');
}

playerMotionProposalDoesNotCommitTest();
ordinaryEnemyCannotSteerPlayerThroughChainTest();
directLeashClipsOnceWithoutDirectionReversalTest();
ballAndStunCollisionAuthorityTest();
taggedInfluenceIsTheOnlyChainDragExceptionTest();
authoritativeRouteAndManualPullTest();
noContactManualPullStraightensSameNodesTest();
orderedBoundedMultiContactTest();
manualPullTargetsOnlyTheFirstContactTest();
stableContactSideTest();
automaticWrapAndTensionStunTest();
localSegmentOverrunCannotFakeFullTensionTest();
twelveEnemyBudgetTest();
controllerUsesOnlyTheRewritePathTest();
console.log('chain rewrite tests passed');
