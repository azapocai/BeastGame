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

function sampleRoute(snapshot, distance) {
  let segment = 0;
  while (segment < snapshot.cumulativeLengths.length - 2
    && snapshot.cumulativeLengths[segment + 1] < distance) segment += 1;
  const start = snapshot.points[segment];
  const end = snapshot.points[segment + 1];
  const segmentLength = Math.max(0.0001,
    snapshot.cumulativeLengths[segment + 1] - snapshot.cumulativeLengths[segment]);
  const t = Math.max(0, Math.min(1, (distance - snapshot.cumulativeLengths[segment]) / segmentLength));
  return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
}

function bruteSweepHit(previous, current, circle, padding = 0) {
  const radius = circle.radius + padding;
  const radiusSquared = radius * radius;
  const cross = (point, start, end) => (point.x - end.x) * (start.y - end.y)
    - (start.x - end.x) * (point.y - end.y);
  const insideTriangle = (point, a, b, c) => {
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(area) <= 0.0001) return false;
    const values = [cross(point, a, b), cross(point, b, c), cross(point, c, a)];
    return !(values.some((value) => value < -0.0001) && values.some((value) => value > 0.0001));
  };
  const segmentCount = Math.min(previous.length, current.length) - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const oldStart = previous[index];
    const oldEnd = previous[index + 1];
    const newStart = current[index];
    const newEnd = current[index + 1];
    if (insideTriangle(circle, oldStart, oldEnd, newEnd)
      || insideTriangle(circle, oldStart, newEnd, newStart)
      || distanceToSegment(circle, oldStart, oldEnd) ** 2 <= radiusSquared
      || distanceToSegment(circle, oldEnd, newEnd) ** 2 <= radiusSquared
      || distanceToSegment(circle, newEnd, newStart) ** 2 <= radiusSquared
      || distanceToSegment(circle, newStart, oldStart) ** 2 <= radiusSquared) return true;
  }
  return false;
}

const { ArenaMotionResolver } = loadModule(path.join(sourceRoot, 'ArenaMotionResolver.ts'));
const { ChainSimulation } = loadModule(path.join(sourceRoot, 'ChainSimulation.ts'));
const { ChainContactIntentTracker } = loadModule(path.join(sourceRoot, 'ChainContactIntentTracker.ts'));
const { ChainVisualDynamics } = loadModule(path.join(sourceRoot, 'ChainVisualDynamics.ts'));
const { ChainRouteSnapshot } = loadModule(path.join(sourceRoot, 'ChainRouteSnapshot.ts'));
const { ChainSweepHitDetector } = loadModule(path.join(sourceRoot, 'ChainSweepHitDetector.ts'));
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

function collisionCorrectionIsNotPlayerWrapIntentTest() {
  const player = new PlayerState();
  player.x = 0;
  player.y = 0;
  const ball = new IronBallTether(player);
  ball.x = -200;
  ball.y = 0;
  ball.maxLength = 396;
  const enemy = new EnemyState({ x: 0, y: 0 });
  const result = new ArenaMotionResolver().resolveIronBallFrame(
    player,
    ball,
    [enemy],
    bounds,
    { x: 0, y: 0 },
  );
  assert(Math.hypot(result.playerDelta.x, result.playerDelta.y) > 0,
    'fixture must physically separate an overlapping player');
  near(result.playerDrivenDelta.x, 0, 1e-9,
    'enemy collision correction must not create player-driven wrap x');
  near(result.playerDrivenDelta.y, 0, 1e-9,
    'enemy collision correction must not create player-driven wrap y');
}

function sameDirectionTranslationIsNotPlayerWrapIntentTest() {
  const tracker = new ChainContactIntentTracker();
  const enemy = new EnemyState({ x: 0, y: 0 });
  const player = { x: 100, y: 20 };
  tracker.beginFrame();
  tracker.observe(enemy, player, { x: 0, y: 0 }, -0.2);
  tracker.endFrame();
  for (let frame = 0; frame < 60; frame += 1) {
    enemy.x += 2;
    player.x += 2;
    tracker.beginFrame();
    tracker.observe(enemy, player, { x: 2, y: 0 }, -0.2);
    tracker.endFrame();
  }
  assert(!tracker.hasPlayerWrapIntent(enemy),
    'equal same-direction player/enemy translation must not accumulate relative wrap intent');
}

function relativeAngleWithoutDeeperWrapIsNotIntentTest() {
  const tracker = new ChainContactIntentTracker();
  const enemy = new EnemyState({ x: 0, y: 0 });
  const player = { x: 100, y: 0 };
  tracker.beginFrame();
  tracker.observe(enemy, player, { x: 0, y: 0 }, Math.PI * 0.45);
  tracker.endFrame();
  for (let frame = 1; frame <= 30; frame += 1) {
    const previousX = player.x;
    const previousY = player.y;
    const angle = frame * Math.PI / 180;
    player.x = Math.cos(angle) * 100;
    player.y = Math.sin(angle) * 100;
    tracker.beginFrame();
    tracker.observe(
      enemy,
      player,
      { x: player.x - previousX, y: player.y - previousY },
      Math.PI * 0.45,
    );
    tracker.endFrame();
  }
  assert(!tracker.hasPlayerWrapIntent(enemy),
    'relative player angle without a simultaneously deepening real body wrap must not create release intent');
}

function straightPassWithDeepeningWrapIsNotIntentTest() {
  const tracker = new ChainContactIntentTracker();
  const enemy = new EnemyState({ x: 0, y: 0 });
  const player = { x: 5, y: 30 };
  tracker.beginFrame();
  tracker.observe(enemy, player, { x: 2, y: 0 }, Math.PI * 0.25);
  tracker.endFrame();
  for (let frame = 1; frame <= 40; frame += 1) {
    player.x += 2;
    tracker.beginFrame();
    tracker.observe(enemy, player, { x: 2, y: 0 }, Math.PI * (0.25 + frame * 0.01));
    tracker.endFrame();
  }
  assert(!tracker.hasPlayerWrapIntent(enemy),
    'a straight pass near an enemy must not count as orbit even when polar angle and body bend both increase');
}

function enemyDeepeningWrapWithoutPlayerOrbitIsNotIntentTest() {
  const tracker = new ChainContactIntentTracker();
  const enemy = new EnemyState({ x: 0, y: 0 });
  const player = { x: 100, y: 0 };
  tracker.beginFrame();
  tracker.observe(enemy, player, { x: 0, y: 0 }, Math.PI * 0.2);
  tracker.endFrame();
  for (let frame = 1; frame <= 30; frame += 1) {
    tracker.beginFrame();
    tracker.observe(enemy, player, { x: 0, y: 0 }, Math.PI * (0.2 + frame * 0.01));
    tracker.endFrame();
  }
  assert(!tracker.hasPlayerWrapIntent(enemy),
    'a deepening PBD/enemy-driven bend without player orbit must not create release intent');
}

function openingWrapCancelsStoredPlayerIntentTest() {
  const chain = new ChainSimulation();
  const tracker = chain.contactIntentTracker;
  const enemy = new EnemyState({ x: 0, y: 0 });
  const player = { x: 100, y: 0 };
  tracker.beginFrame();
  tracker.observe(enemy, player, { x: 0, y: 0 }, Math.PI * 0.6);
  tracker.endFrame();

  for (let degree = 1; degree <= 18; degree += 1) {
    const previousX = player.x;
    const previousY = player.y;
    const orbit = Math.PI * (degree / 180);
    player.x = Math.cos(orbit) * 100;
    player.y = Math.sin(orbit) * 100;
    tracker.beginFrame();
    tracker.observe(
      enemy,
      player,
      { x: player.x - previousX, y: player.y - previousY },
      Math.PI * (0.6 + degree / 180),
    );
    tracker.endFrame();
  }
  assert(tracker.hasPlayerWrapIntent(enemy), 'fixture must first accumulate valid player wrap intent');

  for (let frame = 0; frame < 12; frame += 1) {
    enemy.x += 2;
    player.x += 2;
    tracker.beginFrame();
    tracker.observe(enemy, player, { x: 2, y: 0 }, Math.PI * (0.6 - (frame + 1) * 0.025));
    tracker.endFrame();
  }
  assert(!tracker.hasPlayerWrapIntent(enemy),
    'an opening body wrap during same-direction travel must revoke stale automatic-release intent');
  chain.contacts.push({
    enemy,
    startNode: 4,
    endNode: 8,
    angle: Math.PI * 0.45,
    signedSweep: Math.PI * 0.45,
  });
  chain.tension = 1;
  chain.updateStuns();
  assert(enemy.snareTimer === 0,
    'full tension plus a remaining 81-degree bend must not auto-release after its old intent was revoked');
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

function occupiedRouteReducesOnlyFutureOutwardAllowanceTest() {
  const player = new PlayerState();
  player.x = 100;
  player.y = 0;
  const ball = new IronBallTether(player);
  ball.x = 0;
  ball.y = 0;
  ball.maxLength = 200;
  const resolver = new ArenaMotionResolver();
  resolver.resolveIronBallFrame(player, ball, [], bounds, { x: 50, y: 0 }, 80);
  near(player.x, 120, 1e-6, '80 occupied units must reduce the 200-unit outward allowance to 120');

  player.x = 150;
  resolver.resolveIronBallFrame(player, ball, [], bounds, { x: 0, y: 0 }, 100);
  near(player.x, 150, 1e-6, 'new obstacle occupancy must not passively drag a stationary player inward');
  resolver.resolveIronBallFrame(player, ball, [], bounds, { x: 20, y: 0 }, 100);
  near(player.x, 150, 1e-6, 'player already beyond adjusted allowance must not move farther outward');
  resolver.resolveIronBallFrame(player, ball, [], bounds, { x: -20, y: 0 }, 100);
  near(player.x, 130, 1e-6, 'player must remain free to move inward from an occupied chain limit');
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

function collisionRecoverySeparatesGraduallyTest() {
  const player = new PlayerState();
  player.x = 0;
  player.y = 0;
  const enemy = new EnemyState({ x: 0, y: 0 });
  enemy.applySnare(0.01);
  enemy.update(0.02, player, [enemy], bounds);
  assert(enemy.collisionEnabled && enemy.collisionSeparationScale < 0.3,
    'collision must re-enable with a low recovery strength after stun ends');
  const ball = new IronBallTether(player);
  ball.x = -200;
  ball.y = 0;
  ball.maxLength = 396;
  new ArenaMotionResolver().resolveIronBallFrame(player, ball, [enemy], bounds, { x: 0, y: 0 });
  const partialDistance = Math.hypot(player.x - enemy.x, player.y - enemy.y);
  assert(partialDistance > 0 && partialDistance < player.radius + enemy.radius,
    'first recovery frame must partially separate overlap instead of snapping to full clearance');
  for (let frame = 0; frame < 12; frame += 1) enemy.update(1 / 60, player, [enemy], bounds);
  assert(enemy.collisionSeparationScale === 1, 'collision recovery must reach full strength in bounded time');
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

function enclosedCandidateSharesAutomaticReleaseTest() {
  const chain = new ChainSimulation();
  const first = new EnemyState({ x: -30, y: 0 });
  const second = new EnemyState({ x: 30, y: 0 });
  const enclosed = new EnemyState({ x: 0, y: 30 });
  chain.contacts.push(
    { enemy: first, startNode: 3, endNode: 7, angle: Math.PI * 0.3, signedSweep: Math.PI * 0.3 },
    { enemy: second, startNode: 9, endNode: 13, angle: Math.PI * 0.3, signedSweep: Math.PI * 0.3 },
  );
  chain.contactIntentTracker.beginFrame();
  chain.contactIntentTracker.observe(first, { x: 100, y: 0 }, { x: 0, y: 0 }, Math.PI * 0.3);
  chain.contactIntentTracker.observe(second, { x: 100, y: 0 }, { x: 0, y: 0 }, Math.PI * 0.3);
  chain.contactIntentTracker.endFrame();
  chain.contactIntentTracker.beginFrame();
  chain.contactIntentTracker.observe(first, { x: 98, y: 24 }, { x: -2, y: 24 }, Math.PI * 0.4);
  chain.contactIntentTracker.observe(second, { x: 98, y: 24 }, { x: -2, y: 24 }, Math.PI * 0.4);
  chain.contactIntentTracker.endFrame();
  chain.contactIntentTracker.beginFrame();
  chain.contactIntentTracker.observe(first, { x: 88, y: 44 }, { x: -10, y: 20 }, Math.PI * 0.5);
  chain.contactIntentTracker.observe(second, { x: 88, y: 44 }, { x: -10, y: 20 }, Math.PI * 0.5);
  chain.contactIntentTracker.endFrame();
  chain.enclosureTracker.candidates.push(enclosed);
  chain.tension = 1;
  chain.updateStuns();
  assert(first.snareTimer > 0 && second.snareTimer > 0,
    'qualifying direct contacts must trigger the automatic release');
  assert(enclosed.snareTimer > 0,
    'enemy enclosed by the same guide loop must share the automatic release stun');
}

function realEnclosureRequiresStabilityAndSurvivesShallowContactTest() {
  const chain = new ChainSimulation();
  const enemy = new EnemyState({ x: 0, y: 0 });
  chain.reset({ x: 80, y: 0 }, { x: 80, y: 0 }, 700);
  const last = chain.nodes.length - 1;
  for (let index = 0; index <= last; index += 1) {
    const angle = index / last * Math.PI * 2;
    const radius = index === Math.floor(last * 0.5) ? enemy.radius + 2 : 80;
    const node = chain.nodes[index];
    node.x = Math.cos(angle) * radius;
    node.y = Math.sin(angle) * radius;
    node.previousX = node.x;
    node.previousY = node.y;
  }
  chain.rebuildContacts([enemy]);
  assert(chain.contacts.length === 1 && chain.contacts[0].angle < Math.PI * 0.25,
    'fixture must be enclosed while only shallowly brushing the chain');
  assert(chain.enclosureTracker.candidates.length === 0,
    'one-frame enclosure must not immediately qualify for a release event');
  chain.rebuildContacts([enemy]);
  assert(chain.enclosureTracker.candidates.includes(enemy),
    'stable enclosure must remain eligible even when it also has a shallow contact');
  enemy.x = 140;
  chain.rebuildContacts([enemy]);
  assert(!chain.enclosureTracker.candidates.includes(enemy), 'leaving the guide loop must clear enclosure eligibility');
}

function releaseSweepGeometryTest() {
  const previous = [{ x: -100, y: 60 }, { x: 100, y: 60 }];
  const current = [{ x: -100, y: -60 }, { x: 100, y: -60 }];
  assert(ChainSweepHitDetector.hitsMovingPolyline(previous, current, { x: 0, y: 0, radius: 16 }, 2),
    'enemy inside the retracting segment sweep must be hit');
  assert(!ChainSweepHitDetector.hitsMovingPolyline(previous, current, { x: 150, y: 0, radius: 16 }, 2),
    'enemy outside the retracting segment sweep must not be hit');
  assert(!ChainSweepHitDetector.hitsMovingPolyline(
    [{ x: -50, y: 0 }, { x: 50, y: 0 }],
    [{ x: -50, y: 0 }, { x: 50, y: 0 }],
    { x: 200, y: 0, radius: 16 },
    2,
  ), 'degenerate stationary sweep must not hit a collinear enemy beyond the chain');
}

function preparedSweepBroadPhaseMatchesExactResultTest() {
  const previous = [
    { x: -120, y: 80 },
    { x: 0, y: 110 },
    { x: 120, y: 70 },
  ];
  const current = [
    { x: -120, y: 0 },
    { x: 0, y: 0 },
    { x: 120, y: 0 },
  ];
  const segmentBounds = [];
  const overallBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0, moving: false };
  const count = ChainSweepHitDetector.prepareSweep(previous, current, segmentBounds, overallBounds);
  assert(count === 2 && segmentBounds.length === 2, 'prepared sweep must use one fixed bound per chain segment');
  const references = segmentBounds.slice();
  const fixtures = [
    { x: 0, y: 55, radius: 16 },
    { x: -95, y: 42, radius: 12 },
    { x: 170, y: 55, radius: 16 },
    { x: 0, y: 160, radius: 10 },
  ];
  for (const enemy of fixtures) {
    const prepared = ChainSweepHitDetector.circleOverlapsBounds(enemy, overallBounds, 2)
      && ChainSweepHitDetector.hitsPreparedSweep(previous, current, segmentBounds, count, enemy, 2);
    const direct = bruteSweepHit(previous, current, enemy, 2);
    assert(prepared === direct, 'two-level broad phase must not change the exact sweep result');
  }
  assert(!ChainSweepHitDetector.circleOverlapsBounds(fixtures[2], overallBounds, 2),
    'far enemy must be rejected by the whole-sweep AABB before segment tests');
  ChainSweepHitDetector.prepareSweep(previous, current, segmentBounds, overallBounds);
  assert(segmentBounds.every((bounds, index) => bounds === references[index]),
    'prepared segment AABBs must reuse their fixed buffer objects');
}

function persistentChainCollisionBroadPhaseTest() {
  const chain = new ChainSimulation();
  const farEnemies = [];
  for (let index = 0; index < ChainPerformanceBudget.maxActiveEnemies; index += 1) {
    farEnemies.push(new EnemyState({ x: 0, y: 180 + index * 3 }));
  }
  chain.update(1 / 60, { x: -120, y: -100 }, { x: 120, y: -100 }, farEnemies, 396);
  assert(chain.lastCollisionNarrowPhaseChecks === 0,
    'whole-chain AABB must reject far enemies before segment narrow phase');
  farEnemies[0].x = 0;
  farEnemies[0].y = -100;
  chain.update(1 / 60, { x: -120, y: -100 }, { x: 120, y: -100 }, farEnemies, 396);
  assert(chain.lastCollisionNarrowPhaseChecks > 0,
    'enemy near the chain must still enter segment narrow phase');
  assert(chain.lastCollisionNarrowPhaseChecks < 23 * ChainPerformanceBudget.guideConstraintIterations * 2,
    'segment AABBs must avoid testing every segment for one local enemy');
}

function sameChainStraighteningStunsSweptEnemyTest() {
  const chain = new ChainSimulation();
  const ball = { x: -160, y: 0 };
  const player = { x: 160, y: 0 };
  chain.reset(ball, player, 500);
  for (let index = 0; index < chain.nodes.length; index += 1) {
    const t = index / (chain.nodes.length - 1);
    const node = chain.nodes[index];
    node.x = ball.x + (player.x - ball.x) * t;
    node.y = Math.sin(t * Math.PI) * 120;
    node.previousX = node.x;
    node.previousY = node.y;
  }
  const sweptEnemy = new EnemyState({ x: 0, y: 54 });
  const outsideEnemy = new EnemyState({ x: 150, y: 150 });
  assert(chain.triggerManualPull(), 'manual release must begin the same-node straightening event');
  for (let frame = 0; frame < 16; frame += 1) {
    chain.update(1 / 60, ball, player, [sweptEnemy, outsideEnemy], 500);
  }
  assert(sweptEnemy.snareTimer > 0,
    'enemy crossed by the actual straightening chain must be stunned even without a 45-degree wrap');
  assert(outsideEnemy.snareTimer === 0,
    'same release must not stun an enemy outside the swept chain path');
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
    const previousX = player.x;
    const previousY = player.y;
    // The canonical collision route passes above the enemy, so clockwise
    // player orbit deepens that bend. Counter-clockwise movement unwraps it.
    const angle = -Math.min(Math.PI * 0.82, frame / 90 * Math.PI * 0.82);
    player.x = Math.cos(angle) * 190;
    player.y = Math.sin(angle) * 190;
    chain.update(1 / 60, ball, player, [enemy], 390, {
      x: player.x - previousX,
      y: player.y - previousY,
    });
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

function oppositeOrbitCannotStunTest() {
  const chain = new ChainSimulation();
  const ball = { x: -190, y: 0 };
  const player = { x: 190, y: 0 };
  const enemy = new EnemyState({ x: 0, y: 0 });
  let maximumAngle = 0;
  for (let frame = 0; frame < 150; frame += 1) {
    const previousX = player.x;
    const previousY = player.y;
    const angle = Math.min(Math.PI * 0.82, frame / 90 * Math.PI * 0.82);
    player.x = Math.cos(angle) * 190;
    player.y = Math.sin(angle) * 190;
    chain.update(1 / 60, ball, player, [enemy], 390, {
      x: player.x - previousX,
      y: player.y - previousY,
    });
    maximumAngle = Math.max(maximumAngle, chain.totalContactAngle);
  }
  assert(maximumAngle >= Math.PI * 0.25,
    'opposite-direction fixture must still produce a visible bend above 45 degrees');
  assert(enemy.snareTimer === 0,
    'moving against the signed contact bend must unwrap it, never trigger an automatic stun');
}

function inwardMotionClearsFullTensionTest() {
  const chain = new ChainSimulation();
  const ball = { x: -198, y: 0 };
  const player = { x: 198, y: 0 };
  chain.update(1 / 60, ball, player, [], 396, { x: 0, y: 0 });
  assert(chain.lastPullForce >= 0.98, 'fixture must begin at full tension');
  player.x = 100;
  chain.update(1 / 60, ball, player, [], 396, { x: -98, y: 0 });
  assert(chain.lastPullForce < 0.01,
    `moving inward must clear full tension even while the PBD contour remains long; got ${chain.lastPullForce}`);
}

function tautFreeChainStraightensOverTransitionTest() {
  const chain = new ChainSimulation();
  const ball = { x: -158.5, y: 0 };
  const player = { x: 158.5, y: 0 };
  chain.reset(ball, player, 317);
  for (let index = 1; index < chain.nodes.length - 1; index += 1) {
    const node = chain.nodes[index];
    node.y = Math.sin(index / (chain.nodes.length - 1) * Math.PI) * 80;
    node.previousY = node.y;
  }
  chain.update(1 / 60, ball, player, [], 317);
  assert(chain.lastPullForce >= 0.98, 'fixture must reach the full-tension threshold');
  const firstDeviation = Math.max(...chain.getRouteSnapshot().points.map((point) => Math.abs(point.y)));
  assert(firstDeviation > 0.01 && firstDeviation < 80,
    'a taut free chain must begin a visible retraction instead of snapping or retaining its full slack arc');
  for (let frame = 0; frame < 20; frame += 1) chain.update(1 / 60, ball, player, [], 317);
  assert(chain.getRouteSnapshot().points.every((point) => Math.abs(point.y) <= 1e-9),
    'a taut free chain must finish its short straightening transition');
}

function tautChainContactWithoutPlayerOrbitCannotStunTest() {
  const chain = new ChainSimulation();
  const ball = { x: -198, y: 0 };
  const player = { x: 198, y: 0 };
  const enemy = new EnemyState({ x: 0, y: 70 });
  let maximumAngle = 0;
  let maximumTension = 0;
  for (let frame = 0; frame < 120; frame += 1) {
    enemy.y = Math.max(0, enemy.y - 3);
    chain.update(1 / 60, ball, player, [enemy], 396, { x: 0, y: 0 });
    maximumAngle = Math.max(maximumAngle, chain.totalContactAngle);
    maximumTension = Math.max(maximumTension, chain.lastPullForce);
  }
  assert(maximumAngle >= Math.PI * 0.25,
    `fixture must produce a collision fold above 45 degrees; got ${maximumAngle * 180 / Math.PI}`);
  assert(maximumTension >= 0.98,
    `fixture must keep the chain fully taut; got ${maximumTension}`);
  assert(enemy.snareTimer === 0,
    'enemy moving into an already taut chain must not be stunned without player-driven orbit');
}

function localSegmentOverrunCannotFakeFullTensionTest() {
  const chain = new ChainSimulation();
  chain.update(0, { x: 0, y: 0 }, { x: 230, y: 0 }, [], 400);
  // White-box numerical fixture: move one interior node far away while both
  // endpoints remain only 230 units apart. Local solver error must not turn a
  // slack endpoint route into transmitted full tension.
  for (let index = 0; index < chain.nodes.length; index += 1) {
    chain.nodes[index].x = index * 10;
    chain.nodes[index].y = 0;
  }
  chain.nodes[Math.floor(chain.nodes.length / 2)].y = 280;
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

function visualDynamicsIsBoundedPresentationOnlyTest() {
  const authority = new ChainRouteSnapshot();
  const points = [];
  for (let index = 0; index < ChainPerformanceBudget.targetGuideNodes; index += 1) {
    const t = index / (ChainPerformanceBudget.targetGuideNodes - 1);
    points.push({ x: -180 + 360 * t, y: Math.sin(t * Math.PI) * 90 });
  }
  authority.publish(points, [], 0.4);
  const dynamics = new ChainVisualDynamics();
  const visual = dynamics.update(1 / 60, authority);
  assert(visual.points.length === ChainPerformanceBudget.visualNodes,
    'visual chain must use the fixed low-node presentation budget');
  near(visual.points[0].x, authority.points[0].x, 1e-9,
    'visual start endpoint must remain pinned to the authoritative route');
  near(visual.points[visual.points.length - 1].x, authority.points[authority.points.length - 1].x, 1e-9,
    'visual end endpoint must remain pinned to the authoritative route');
  const pointReferences = visual.points.slice();
  const authorityMiddleY = authority.points[12].y;
  points[12].y += 40;
  authority.publish(points, [], 0.4);
  dynamics.update(1 / 60, authority);
  near(authority.points[12].y, authorityMiddleY + 40, 1e-9,
    'presentation dynamics must never rewrite authoritative points');
  assert(visual.points.every((point, index) => point === pointReferences[index]),
    'visual dynamics must reuse its published point objects across frames');
}

function visualTensionThresholdCannotRemainStaleTest() {
  const authority = new ChainRouteSnapshot();
  const points = [{ x: -100, y: 0 }, { x: 100, y: 0 }];
  const dynamics = new ChainVisualDynamics();
  authority.publish(points, [], 0.981);
  dynamics.update(1 / 60, authority);
  assert(dynamics.getSnapshot().tension >= 0.98, 'fixture must publish a taut visual state');
  authority.publish(points, [], 0.979);
  dynamics.update(1 / 60, authority);
  assert(dynamics.getSnapshot().tension < 0.98,
    'crossing below full tension must publish immediately even when the numeric delta is below the sleep epsilon');
}

function visualChainSnapsWhenPlayerEndpointMovesTest() {
  const authority = new ChainRouteSnapshot();
  const points = [{ x: -100, y: 0 }, { x: 0, y: 70 }, { x: 100, y: 0 }];
  const dynamics = new ChainVisualDynamics();
  authority.publish(points, [], 0.4);
  dynamics.update(1 / 60, authority);
  points[2].x += 80;
  points[2].y += 35;
  authority.publish(points, [], 0.4);
  const visual = dynamics.update(1 / 60, authority);
  for (let index = 0; index < visual.points.length; index += 1) {
    const distance = authority.totalLength * index / (visual.points.length - 1);
    const expected = sampleRoute(authority, distance);
    near(visual.points[index].x, expected.x, 1e-9,
      'player endpoint movement must snap the visual chain x without inertia');
    near(visual.points[index].y, expected.y, 1e-9,
      'player endpoint movement must snap the visual chain y without inertia');
  }
}

function controllerUsesOnlyTheRewritePathTest() {
  const controller = fs.readFileSync(path.join(sourceRoot, 'ChainArenaController.ts'), 'utf8');
  const simulation = fs.readFileSync(path.join(sourceRoot, 'ChainSimulation.ts'), 'utf8');
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
  assert(controller.includes("from './ChainVisualDynamics'"),
    'controller must apply the visual chain only after authoritative simulation');
  assert(!simulation.includes('ChainVisualDynamics'),
    'authoritative simulation must never import or consume the presentation chain');
  assert(controller.indexOf('this.resolveEnemyEnemyCollisions()') < controller.indexOf('resolveIronBallFrame('),
    'enemy peer separation must happen before the authoritative player/ball solve');
}

function presentationUsesSharedRuntimeAtlasTest() {
  const loader = fs.readFileSync(path.join(sourceRoot, 'SpriteAssetLoader.ts'), 'utf8');
  const chainRenderer = fs.readFileSync(path.join(sourceRoot, 'SpriteChainRenderer.ts'), 'utf8');
  const arenaRenderer = fs.readFileSync(path.join(sourceRoot, 'ArenaSpriteRenderer.ts'), 'utf8');
  const controller = fs.readFileSync(path.join(sourceRoot, 'ChainArenaController.ts'), 'utf8');
  const tether = fs.readFileSync(path.join(sourceRoot, 'TetherSystem.ts'), 'utf8');
  const arenaModel = fs.readFileSync(path.join(sourceRoot, 'ArenaModel.ts'), 'utf8');
  assert(loader.includes('new Uint8Array(width * height * 4)'),
    'presentation must create one bounded in-memory RGBA atlas');
  assert(loader.includes('Texture2D.PixelFormat.RGBA8888'),
    'runtime atlas must declare an explicit supported RGBA format');
  assert(!loader.includes('resources.load') && !loader.includes('.svg'),
    'runtime presentation must not depend on the broken SVG import path');
  assert(chainRenderer.includes('snapshot.revision === this.lastRevision'),
    'sleeping visual chain must skip unchanged sprite-pool transforms');
  assert(chainRenderer.includes('LINK_SPACING = 14')
    && chainRenderer.includes('LINK_WIDTH = 7')
    && chainRenderer.includes('LINK_HEIGHT = 10')
    && chainRenderer.includes('sprite.sizeMode = Sprite.SizeMode.CUSTOM')
    && chainRenderer.includes('transform.setContentSize(SpriteChainRenderer.LINK_WIDTH, SpriteChainRenderer.LINK_HEIGHT)'),
    'chain links must keep normal spacing while rendering at half icon size');
  assert(arenaModel.includes('CHAIN_FULL_TENSION = 0.98')
    && chainRenderer.includes('snapshot.tension >= CHAIN_FULL_TENSION'),
    'yellow chain state must use the same full-tension threshold as automatic stun');
  assert(tether.includes('maxLength = 317'),
    'iron-ball chain must retain the requested one-fifth length reduction');
  assert(arenaRenderer.includes('setPositionIfChanged'),
    'arena sprite renderer must avoid unchanged transform writes');
  assert(controller.includes('hudText !== this.lastHudText'),
    'HUD must avoid rebuilding unchanged label geometry');
}

playerMotionProposalDoesNotCommitTest();
ordinaryEnemyCannotSteerPlayerThroughChainTest();
collisionCorrectionIsNotPlayerWrapIntentTest();
sameDirectionTranslationIsNotPlayerWrapIntentTest();
relativeAngleWithoutDeeperWrapIsNotIntentTest();
straightPassWithDeepeningWrapIsNotIntentTest();
enemyDeepeningWrapWithoutPlayerOrbitIsNotIntentTest();
openingWrapCancelsStoredPlayerIntentTest();
directLeashClipsOnceWithoutDirectionReversalTest();
occupiedRouteReducesOnlyFutureOutwardAllowanceTest();
ballAndStunCollisionAuthorityTest();
collisionRecoverySeparatesGraduallyTest();
taggedInfluenceIsTheOnlyChainDragExceptionTest();
authoritativeRouteAndManualPullTest();
noContactManualPullStraightensSameNodesTest();
orderedBoundedMultiContactTest();
manualPullTargetsOnlyTheFirstContactTest();
enclosedCandidateSharesAutomaticReleaseTest();
realEnclosureRequiresStabilityAndSurvivesShallowContactTest();
releaseSweepGeometryTest();
preparedSweepBroadPhaseMatchesExactResultTest();
persistentChainCollisionBroadPhaseTest();
sameChainStraighteningStunsSweptEnemyTest();
stableContactSideTest();
automaticWrapAndTensionStunTest();
oppositeOrbitCannotStunTest();
inwardMotionClearsFullTensionTest();
tautFreeChainStraightensOverTransitionTest();
tautChainContactWithoutPlayerOrbitCannotStunTest();
localSegmentOverrunCannotFakeFullTensionTest();
twelveEnemyBudgetTest();
visualDynamicsIsBoundedPresentationOnlyTest();
visualTensionThresholdCannotRemainStaleTest();
visualChainSnapsWhenPlayerEndpointMovesTest();
controllerUsesOnlyTheRewritePathTest();
presentationUsesSharedRuntimeAtlasTest();
console.log('chain rewrite tests passed');
