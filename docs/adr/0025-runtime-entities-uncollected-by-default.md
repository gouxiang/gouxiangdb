# ADR-0025：运行期实体默认未收纳——shortcut 仅"存量迁移基线 + S6 菜单编排"两源

**状态（Status）**：Accepted（方案 A 由项目总监 2026-09-12 终审定案，2026-09-14 归档；M3-S3 开工时回填，解除计划 §4.4/§7-S3 与 §5.4 旧 C4 阻断口径的内部矛盾）
**作者**：架构师 高见远
**上游依据**：`docs/_archive/originals/planning-phase2-M3-implementation-plan.md` §4.4 #7（复制表零噪音）、§5.3（存量初始全收纳）、§5.4（对账分级）、§7-S3/S4（验收口径）、§11 DoD；总监方案 A 裁决（2026-09-12）
**关联**：ADR-0026（权威节点层 vs 菜单引用层，候选顺延）；ADR-0029（删除悬挂三态 C-12，候选顺延）；M3 裁决 4（默认菜单不嵌套复刻文档树）、裁决 9（nav 同事务强一致）

---

## 1. 背景（Context）

M3 的导航是两层模型：`nav_nodes` 是实体的权威树（每个活 base/kb/table/view/doc/canvas
恰好一个活节点，由 18 个实体写点同事务强一致维护，裁决 9）；`menu_items` 是引用编排层
（shortcut 可重复、可别名、可拖拽，由 manage_menu 显式编排，删除 shortcut 不动权威父级）。

迁移 B（M3-S2）对**存量**活实体做一次性全收纳回填：每个活 table、根级活 doc、活 canvas
恰好获得一条默认 shortcut，构成"零入口全收纳"基线。问题出现在 M3-S3 开工核对：

- §4.4 #7 与 §7-S3 已明确：运行期写点（复制表、建表、建文档、建画布等）只 upsert
  nav_nodes 节点，**menu 不动、复制表不加快捷项**，新实体以"未收纳"态出现在二级
  "全部"列表；
- 但旧 §5.4 把 C4（每个活 table/根 doc/canvas 至少一条活 shortcut）定为**阻断**差异，
  S3 验收还要求随机写操作后 reconcile"全 0 差异"。

两者不可同时成立：只要运行期允许新建实体且写点不写菜单，新实体必然产生 C4；若再要求
C4 阻断为 0，等于强制 reconcile `--apply` 或 sync 原语在运行期自动补 shortcut。

## 2. 决策（Decision）：方案 A——运行期实体默认未收纳，可达性不依赖菜单

1. **shortcut 只有两个创建来源**：
   - **S2 存量迁移基线**：迁移 B 的回填 DML 对升级时点的存量活实体一次性全收纳
     （每活 table/根级活 doc/活 canvas 恰好一条活 shortcut）；
   - **S6 菜单写 API**：`PATCH /api/v1/workspaces/current/menu` 等 manage_menu
     编排动作，由有权限的用户显式收纳。
   除此之外，**任何运行期代码路径（18 写点的 `domain/nav/sync.ts` 原语、reconcile
   `--apply`、实体恢复路径）都不得创建 shortcut**。
2. **nav_nodes 与 menu_items 的生命周期解耦**：实体写点同事务只维护权威节点
   （裁决 9 的强一致仍完整适用于 nav_nodes）；菜单收纳是独立的用户编排动作，
   不进实体写事务。
3. **可达性不依赖菜单**：未收纳实体经两条路径可达——`GET /tree` 的 nav_nodes 权威树
   （含"未收纳"标记）与 S9 二级"全部"列表（N3 三视角：全部/未收纳/已收纳）；
   内容深链（`/base/.../view`、`/kb/.../doc|canvas`，ADR-0028 候选）永久有效，
   未收纳不影响直链访问与旧 RBAC 守卫。
4. **对账分级重定义（§5.4）**：
   - 阻断（非零即 exit 1，`--apply` 必须修复）：A1-A6（实体→节点）、B1-B3
     （节点→实体悬挂）、C1（shortcut 指向**物理消失**的节点/broken、nodeId 缺失）、
     C2（菜单容器环或嵌套 >2）、C3（iconName 不在白名单）；
   - warning（只报告，不影响 exit code，`--apply` 不自动处理）：
     **C4 未收纳**（活 table/根级活 doc/活 canvas 无活 shortcut——正常编排态）、
     C5（同父 menu ord 重复，拖拽并发可产生）、**C1S**（shortcut 指向软删节点
     soft_dangling：裁决 6 的正常悬挂态，shortcut 保留待实体恢复时由 sync restore
     原语连同节点原地复活，不阻断、不自动清理）。
   - broken shortcut 的物理清理仍需显式 `--purge-broken`（C-12 可解释性，不变）。
5. **"零入口全收纳"不变量的作用域收窄**：它只约束 S2 存量初始迁移基线，由迁移 DML 与
   `nav-backfill-s2` 测试逐 id 保证（迁移后 C4=0）。S2 之后 C4 集合的正确语义是
   "恰等于运行期未收纳实体集合"——S3 验收要求 C4 计数与条目（ref=节点 id）与预期
   未收纳集合**逐 id 相等、不多不少**，而非恒为 0。

## 3. 被否决的备选：方案 B——运行期同事务自动写 shortcut

在实体写事务内为每个新建 table/根 doc/canvas 自动挂一条默认 shortcut（reconcile C4
保持阻断，`--apply` 补默认菜单）。否决理由：

1. **噪音菜单**：用户高频创建/删除临时表、草稿文档时，一级菜单被系统自动项淹没，
   菜单退化为"实体表投影"，编排层失去独立价值；用户删 shortcut 后 reconcile 又自动
   补回，用户意图被系统持续覆盖。
2. **与复制表零噪音、三视角设计直接冲突**：§4.4 #7 已定复制表不加快捷项；S9 的
   N3"未收纳/已收纳"三视角（裁决 8）以"新实体默认未收纳、由用户显式收纳"为前提，
   方案 B 使"未收纳"永远为空集，三视角退化。
3. **与 AC-M3-1 的两层边界冲突**：菜单拖拽/收纳必须零权威副作用（只动 menu_items），
   反向的"实体写自动改菜单"把两层重新耦合，菜单不再是纯引用层。
4. 方案 B 唯一收益（任何活实体在一级菜单必有入口）已由权威树 + 二级"全部"列表 +
   永久深链覆盖，不需要以菜单噪音为代价。

## 4. 对 reconcile 与验收的影响

- exit code 只看 A/B/C1/C2/C3；C4/C5/C1S 在 `warnings` 段，仅展示与留痕。
- `--apply` 修复集：节点补缺/复活/改名/ord、path 重建、B2 与 C1S 的软删对齐
  （节点/shortcut 置 deletedAt，运行期 sync 本应已做，脚本仅兜底）；
  **不含任何 menuItem create**；broken 物理清理仍需 `--purge-broken`。
- S2 验收：存量库迁移后阻断=0 且 C4=0（全收纳基线）。
- S3 验收：18 写点双向回滚三证明原样保留（裁决 9 针对 nav_nodes，不受本决策影响）；
  新增正向断言——每个产生新活 table/根 doc/canvas 的写点后，C4 集恰为预期未收纳集；
  并以 grep 审查证明 sync.ts 与五路由接线处、reconcile.ts 均无 menuItem 写。
- S4 异常库演练夹具按新分级：broken→阻断+purge；改名→A4 阻断；软删悬挂→C1S
  warning 且恢复后消失。

## 5. 后果（Consequences）

正面：
- 菜单回归"用户编排的引用层"本位，新建实体零菜单噪音；三视角与 AC-M3-1 语义自洽。
- reconcile 的 exit code 成为可在生产库日常巡检中直接使用的健康信号（不会因正常
  未收纳实体而误报失败）。
- 决策只改文档口径与对账分级，nav_nodes 的强一致事务纪律一行未放松。

代价/边界：
- 存量库管理员若把 reconcile 旧版"C4=0"当作巡检预期，需理解新基线（迁移点）之后
  C4 非 0 是正常态；runbook 已按此改写处置口径。
- M4 菜单按权限剪枝后，未收纳集合与可见集合是两个维度，剪枝不得改变 C4 的计算
  （C4 基于实体存在性，与可见性无关）。
- shortcut 编号在本 ADR 后固定：C1=broken 阻断、C1S=soft_dangling warning、
  C4=未收纳 warning；后续里程碑不得复用或改义。

## 6. 验证证据（计划，M3-S3/S4/S11 落地后回填）

- `domain/nav/__tests__/nav-backfill-s2.test.ts`：S2 基线 C4=0 逐 id 断言
  （测试已存在，M3-S3 随口径修订）。
- M3-S3 18 写点真库测试：操作后阻断=0 且 C4 集 == 预期未收纳集（逐 id 相等）。
- 代码审查 grep：`domain/nav/sync.ts`、bases/tables/views/kb/records 五路由接线处、
  `domain/nav/reconcile.ts` 中无 `menuItem.create`。
- M3-S4 三夹具演练输出：broken（C1 阻断）、改名（A4 阻断）、软删悬挂（C1S warning
  且恢复后消失）。
