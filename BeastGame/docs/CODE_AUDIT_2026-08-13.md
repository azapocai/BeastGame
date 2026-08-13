# Demo 代码收口审查（2026-08-13）

## 结论

当前 Demo 不需要再次整体重构。现行运行链已经形成单一权威：

`MainGame.scene → GameBootstrap → ChainArenaController → ArenaMotionResolver + ChainSimulation`

应继续维护这条链。旧 `ChainSnareSystem` 解析式体系经引用确认后已经完整退役。

## 现行代码：保留

以下 19 个脚本属于当前运行或直接依赖：

- `GameBootstrap.ts`：场景入口。
- `ChainArenaController.ts`：当前 Demo 编排与占位表现。
- `ArenaModel.ts`：玩家、敌人、房间和测试数据。
- `ArenaMotionResolver.ts`：铁球房玩家位置的唯一提交者。
- `ChainSimulation.ts`：唯一链条几何、碰撞、接触、张力和眩晕权威。
- `ChainContactIntentTracker.ts`：有方向的玩家主动缠绕证据。
- `ChainEnclosureTracker.ts`：稳定圈内候选。
- `ChainSweepHitDetector.ts`：回直过程连续扫掠命中。
- `ChainRouteSnapshot.ts`：玩法与渲染共享的只读发布路径。
- `ChainPerformanceBudget.ts`：12 敌人、24 节点、4 接触等固定预算。
- `CircleCollisionSolver.ts`：可复用结果对象的圆形分离。
- `TetherSystem.ts`：铁球与暂未开放的转盘机关状态。
- `SpriteChainRenderer.ts`、`TetherRenderer.ts`：Sprite 主链与 Graphics 回退表现。
- `InputRouter.ts`、`Math2D.ts`：输入和基础数学。
- `ChainVisualDynamics.ts`：只消费权威快照的固定 16 节点显示后处理。
- `SpriteAssetLoader.ts`、`ArenaSpriteRenderer.ts`：统一图片加载和固定容量实体 Sprite 表现。

其中 `ChainArenaController.ts` 体积较大，但当前只是单房间技术 Demo；现在拆成更多层只会增加跳转和生命周期协调，不产生实际性能收益，因此本轮不做形式化拆分。

## 已完成退役：逐文件记录

以下 14 个脚本属于已否决的解析式旧锁链体系：

1. `ChainSnareSystem.ts`
2. `ChainAnalyticContactRefiner.ts`
3. `ChainClusterBoundarySolver.ts`
4. `ChainContactCluster.ts`
5. `ChainContactSolver.ts`
6. `ChainContactTopology.ts`
7. `ChainEnclosureAnalyzer.ts`
8. `ChainGuideCollision.ts`
9. `ChainGuideSolver.ts`
10. `ChainGuideState.ts`
11. `ChainReleaseTransition.ts`
12. `ChainRouteSolver.ts`
13. `ChainRuntimeStats.ts`
14. `MultiContactRouteSolver.ts`

同时删除：

- 上述脚本各自对应的 `.meta` 文件。
- `tests/chain-snare.test.js`，它只验证旧体系，不代表当前运行架构。

上述文件由用户逐项删除；随后已移除只为旧测试存在的铁球耦合兼容入口，以及 `ChainPerformanceBudget` 中只服务旧体系的 `maxExactCandidates`、`maxGuideNodes`、`maxGuideConstraintIterations` 和 `maxRoutePoints`。当前项目不再编译或测试两套锁链架构。

## 本轮已实施收口

- 删除 `ChainSimulation.setVisibleLinkCount()` 空接口及 Controller 的无效调用。
- 合并铁球/转盘完全相同的链条渲染分支。
- 删除未使用的 `FixedAnchor` 和 `TetherRenderer.drawChain()`。
- `ChainRouteSnapshot` 注释改为真实发布者 `ChainSimulation`。
- 接触圈稳定帧数统一读取 `ChainPerformanceBudget.enclosureStableSteps`，不再重复硬编码 `2`。
- `ChainSimulation` 的测量总长改为局部变量，减少无意义的跨帧状态。
- 敌人两两碰撞复用结果对象，避免每次发生重叠时产生临时对象。
- 敌人碰撞的确定性备用方向改为模块常量，并用直接循环替代每帧 `every()` 回调。
- `TetherRenderer` 复用颜色常量，消除每帧 Graphics 回退、铁球、眩晕和调试绘制中的 `Color` 分配。
- 删除 `TetherSystem` 中仅供历史测试调用的旧耦合 `update/resolveBodyCollisions`；铁球房只能通过 `ArenaMotionResolver` 提交玩家与实体分离。
- 铁球高速命中的归一化方向改为复用缓冲区，避免命中检测时创建临时向量。

## 性能审查

当前链条计算的上限仍然受控：1 条链、24 个节点、4 次约束、12 个敌人、最多 4 个发布接触。持续碰撞有整链和逐段 AABB，回直扫掠有候选缓存与逐段 AABB。没有发现会随游玩时间持续增长的链条数组或监听器泄漏。

仍需真机验证的主要成本不是旧代码，而是：

- Cocos `Graphics` 的角色和场地占位绘制；
- 64 个链节 Sprite 的节点与合批情况；
- 12 敌人密集接触时的 24 节点 × 4 轮 PBD 碰撞；
- HUD 每帧字符串刷新。

这些项目需要微信开发者工具和低端设备数据才能继续判断，本轮不凭桌面预览提前降级效果。

## 文档处理原则

`MULTI_CONTACT_CHAIN_REFACTOR_PLAN.md` 和 `CHAIN_OPTIMIZATION_DESIGN.md` 保留为失败方案与需求演进记录，不再视为实现说明。当前事实以 `CHAIN_REWRITE_IMPLEMENTATION.md`、本审查和代码为准。
