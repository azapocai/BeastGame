# Chain Arena Cocos Demo

这是从网页原型迁移的 Cocos Creator 3.8.8 锁链缠绕专项测试版本：单一铁球锁链房、3 名普通敌人。

完整设计与状态文档：

- `docs/PROJECT_DESIGN.md`：项目定位、设计原则、技术基线与路线图。
- `docs/DEMO_STATUS.md`：当前 Demo 的真实功能、参数、限制与验证记录。
- `docs/CHAIN_OPTIMIZATION_DESIGN.md`：已确认的下一阶段方案；明确规则级持久引导链、局部解析接触、纯视觉动力三层职责，以及固定预算和实施验收门。
- `docs/MULTI_CONTACT_CHAIN_REFACTOR_PLAN.md`：旧解析式多接触重构的历史记录；冲突处以最新三层方案为准。
- `docs/CHAIN_REWRITE_IMPLEMENTATION.md`：Video 10 后的当前运行架构、硬性规则、性能预算、严格测试与编辑器验收清单；与旧方案冲突时以此为准。

## 启动

1. 用 Cocos Creator 3.8.8 打开 `BeastGame`。
2. 打开 `assets/MainGame.scene`。
3. 确认场景节点已经挂载 `GameBootstrap.ts`。
4. 点击预览。`GameBootstrap` 会在运行时创建 Canvas、图形、HUD 和全部玩法节点。

## 控制

- `WASD` / 方向键：移动
- 鼠标：瞄准；左键或空格 / `J`：攻击
- `Shift` / `K`：闪避
- `C`：专项测试强制拉脱当前接触，并绊倒敌人（无需达到缠绕门槛）
- `R`：重开锁链缠绕实验场
- `F2`：显示锁链长度、动态锚点和有效直线路径
- 触屏：左侧拖动移动，右侧上半攻击，右下闪避

## 当前范围

- 当前测试范围：单房间、3 名敌人、减速移动、同范围近战、眩晕穿透、铁球实体碰撞、最多 4 个解析接触槽、满张力绊倒、释放路径再捕获和标记单位的链条反向影响。
- 当前实现：`ArenaMotionResolver` 是铁球房玩家位置的唯一提交者；`ChainSimulation` 用固定 24 个节点统一碰撞、接触、局部绕角、张力、眩晕和绘制路径。旧 `ChainSnareSystem` 已退出控制器运行路径。
- 当前已知限制：已通过 TypeScript 与纯逻辑测试，尚待 Cocos 编辑器复验实际操控、多人接触和 C 同链收紧表现；微信真机性能尚未验证。
- 本轮不开放：转盘、火药桶、多房间流程；后续再恢复这些验证项。
