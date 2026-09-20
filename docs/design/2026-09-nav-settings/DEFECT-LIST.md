# 导航 / 权限 / 设置治理 —— 下一阶段缺陷清单

> 版本：v1.0（2026-09-19）
> 范围：用户提出的 7 条已发现缺陷 + 工作区设置治理 + 语义检索配置补齐 + 同类缺陷排查
> 依据：三路独立只读调研，每条结论均带 `文件:行号` 代码实证；推断项已单独标注
> 状态：**部分已落地**（本文件是清单与方案，落地记录见下方 §0.1）

---

## 0.1 已落地（含 commit 与复验数字）

| 批次 | 内容 | commit | 复验 |
|---|---|---|---|
| 一 | D-01 侧栏个人信息栏下线（含旧壳两处）+ D-06 入口去重 | `fcb9a94` | web 578/43，七包 Done |
| 一 | D-07① FooterNav 按能力过滤 + `/workspace/authz` 页面级门控（新增 `lib/nav-gate.ts`，fail-closed） | `fcb9a94` | 真机 viewer 账号四项全不可见 |
| 一 | D-05 部门「添加已有成员」（后端零改动，复用 `assignDepartments`） | `74e8382` | 真机加成员 / 去重 / 无权限均通过 |
| — | 实体图标收尾：「恢复默认」真正清色 + 未自定义色板高亮 | `f610c73` | 七包 Done，web 578/43 |
| — | 实体图标收尾：数据表图标入口进表页 + KB 首页行菜单防裁剪 | `32c3c6e` | 真机 19/19，web 587/45 |
| 二 | **D-02 阶段 A**：建库/建知识库自动入一级导航（`ensureEntityShortcutTx` 幂等）+ 库入口从顶栏移入左侧 | `4d1fc4e` | api 2227/209、web 587/45、七包 Done；真机建库即现、刷新仍在、老库不重复 |
| 二 | D-04 L2 收起/展开 + 持久化（新增 `lib/l2-collapse.ts` 三态：未操作跟档位 / 用户意图落盘） | `98285a3` | web 596/46；真机 1440·1024·900 三档 13/13，F5 保持收起 |
| 二 | D-07② 管理类入口由「禁用」改「隐藏」（KB 新建、库设置改名/删除、视图管理、回收站彻底删除、成员角色） | `a397cf2` | web 602/47；viewer 真登录复验；**数据编辑类（工具栏新建记录）按红线保留 disabled 未动** |
| 四 | E-02 语义检索远端配置补齐：provider（向后兼容）/ dimension 按档位放开 / 并发+重试 / 总门运行时开关 / 测试连接 | `7287dd6` | api 2245/209、web 614/48、七包 Done；非法值 400、非 owner 不可见 |
| 四 | E-01 工作区设置治理：口径统一（8 分区全走 `effectiveSection`）/ 通讯录改说明+跳转 / 上传限制上提到全局 / 新增回收站聚合入口 / <1024 左栏折叠 | `f1071d8` | web 632/49（+18 例）；真机 owner 与非 owner 均无空白、1024·900 无溢出 |

| 三 | **D-02 B + D-03 导航重构**：L1 改列 bases+knowledge_bases（`buildLibraryRows`）；L2 改列选中容器子项（base→表 / kb→文档·画布 tab）；下线导航编排（NavComposer、`/workspace/settings/nav`、「收纳到导航」、后端自动写 shortcut） | `032168a` + `720e09c` | web 639/50、api 2243/209、七包 Done；真机 23/23，一级无二级内容、折叠刷新保持 |
| 三 | 收尾：L1「个人用户」分组与 4 个规划入口下线（点了只弹 toast 的假入口）+ 新数据源补 7 例单测 | `d90c058` | web 639/50 |

> 说明：`f1071d8` 复跑时出现的 1 次失败定位于 `features/workspace/lib/nav-window.test.ts` 的 `performance.now` 计时基线 —— 该文件本次未被改动，属**记录在案的既有抖动**（约 1/6，高负载触发），非本次回归；已按约定不改阈值。

## 0.2 全部完成后的遗留

- **死代码（未清，不影响功能）**：`menu-sections.ts` 的 `buildFlyoutRows` / `FLYOUT_MAX_DEPTH`、`nav-gate.ts` 的 `canSeeNavComposer` 已无调用方。
- **后端冷备**：`domain/nav/*` 与 menu 相关 API/测试按约定保留未删，只停止前端依赖与自动写入；`menu_items` 历史数据仍在库里但不再被读取。
- **待主理人确认口径**：L1「个人用户」四项规划入口已按第 ① 条口径移除并转入需求池，若需保留可从 `720e09c` 之前取回。

---

## 0. 速览

| 编号 | 问题 | 优先级 | 批次 | 一句话根因 |
|---|---|---|---|---|
| D-01 | 侧栏底部个人信息栏需移除 | P1 | 一 | `WorkspaceShell.tsx:234` 贴底渲染 UserCard，与右上角同开一个 Drawer |
| D-02 | 建库入口在顶部 / 建完导航为空 | **P0** | 二（A）/ 三（B） | 建库只写 `nav_nodes`，而 L1 读的是 `menu_items` |
| D-03 | 导航层级规则不统一 | **P0** | 三 | L2 是「收纳面板」而非「选中容器的子项列表」 |
| D-04 | L2 不支持收起/展开 | P1 | 二 | 折叠只做了一半：L1 有持久化，L2 只有响应式 `l2Hidden` |
| D-05 | 部门缺「添加已有成员」 | P1 | 一 | 后端已支持，前端只做了「成员→部门」单向 |
| D-06 | 个人信息入口重复 | P1 | 一 | 4 处渲染同一个 `PersonalCenterDrawer` |
| D-07 | 无权限应隐藏而非禁用 | **P0** | 一（导航门控）/ 二（禁用改隐藏） | 导航层完全无门控，内容层普遍用 disabled |
| E-01 | 工作区设置治理 | P1 | 四 | 成员/角色三处重复、回收站分裂、上传限制错位 |
| E-02 | 语义检索远端模型配置缺失 | P1 | 四 | 缺 provider / dimension 可配 / 并发重试；总门只能改 env |

---

## 1. D-01 侧边导航底部个人用户信息栏需移除（本阶段不纳入规划）

**问题描述**
默认布局（`WorkspaceShell`）左侧导航最底部有一条用户信息栏：圆形首字母色块 + `displayName`，点击后打开个人中心抽屉。本阶段不纳入规划，需从界面移除，仅保留在需求池中。

**根因分析**
- 渲染点：`apps/web/src/features/workspace/WorkspaceShell.tsx:234` `<UserCard collapsed={collapsed} />`，注释（`:233`）明确「始终贴底」。
- 组件本体：`WorkspaceShell.tsx:119-148`，`border-t + p-1.5` + `button h-8 w-full`，约占 44px；折叠档只显示头像。
- 行为：唯一动作是 `onClick → setOpen(true)`，打开的正是**右上角同一个** `PersonalCenterDrawer` —— 功能完全重复，不是另一套能力。
- 依赖核查（决定能否直接删）：`logout()` 全仓调用点仅 3 处（`PersonalCenterDrawer.tsx:69` 登出、`:75` 注销后登出、`api/client.ts:188` 401 自动登出），退出登录 UI 唯一在 `PersonalCenterDrawer.tsx:152`；头像上传 / 改密 / 注销均在 Drawer 内 Tab（`:34-40`），**不在 UserCard**。→ 顶栏入口保留即不失联。

**优先级**：P1（低风险、无依赖、可立即执行）

**修复方案**
1. 移除 `WorkspaceShell.tsx:234` 的 `<UserCard>` 渲染。
2. `UserCard` 组件不物理删除，改为不导出使用 + 顶部注释「本阶段不启用，需求池 #个人门户」，避免后续复用时重写。
3. 同步确认 L1 底部不再留出空白间距（`aside` 的 flex 布局需复核）。
4. 同类处理：`PrimaryNav.tsx:126` / `:318-320` 的「个人门户」是带 `plannedHint` 的规划入口，与本项目同类（规划中功能不应出现在正式界面）——建议一并归入需求池，若保留则不得新增同类入口。

---

## 2. D-02 建库与库切换入口必须从顶部移入左侧导航；新建后导航仍为空

**问题描述**
用户反馈：顶部新建数据库后，左侧导航仍然为空。怀疑与「导航编排」逻辑冲突。要求把建库与库切换入口从顶部移入左侧导航；若改造成本高，可直接下线导航编排。该问题在参考 UI 稿中早已明确，多次迭代未修复。

**根因分析（代码实证，非推测）**

建库入口的真实位置不在顶栏本体，而在顶栏挂载的库切换器下拉里：
- `WorkspaceTopBar.tsx:43-45` 挂载 `<LibrarySwitcher>`；顶栏其余元素为品牌（`:34-42`）、搜索（`:53-67`）、个人中心（`:70-83`）。
- 建库实际在 `components/LibrarySwitcher.tsx:75-98` 的 `create()`：base 走 `:81` `createBase`，kb 走 `:87` `createKb`。

「建完为空」的**完整因果链**：
1. `apps/api/src/routes/bases.ts:158` POST 建库 → `:178` **确实调用了** `syncNavFromEntitiesTx(tx)`，`nav_nodes` 里因此有 base/table/view 节点。
2. 但 `apps/api/src/domain/nav/sync.ts:7` 注释明写：本文件**只维护 `nav_nodes`，不写 `menu_items`（"menu 不动"）**。
3. 全仓写 `menu_items` 的生产路径**只有** `domain/nav/menu.ts:160`（建 shortcut），其余是 `reconcile.ts:123`、`sync.ts:187`（物理删前清引用）——**没有任何「建库自动建 shortcut」的代码**。
4. 而 L1 读的正是 `menu_items`：`PrimaryNav.tsx:227 useNavMenu()` → `nav-hooks.ts:52` → `client.ts:1064 GET /api/v1/workspaces/current/menu` → `menu-read.ts:93 tx.menuItem.findMany`。

→ **结论：不是"编排冲突"，是建库只写 `nav_nodes`、不写 `menu_items`。用户必须在 L2「未收纳」tab 点「收纳到导航」（`SecondaryNavSections.tsx:182`）才会进 L1。**

「导航编排」是什么（决定下线代价）：`nav_nodes`（`schema.prisma:505`）是权威实体树、`menu_items`（`:537`）是引用编排层（`nodeId` shortcut 可重复引用）；前端手动入口 `SecondaryNav.tsx:151 collect()` → `usePatchMenu` → PATCH menu，另有 `NavComposer.tsx` 做整单编排。

**下线导航编排的代价评估：中（不是小）**
- 可行性有：`WorkspaceShell.tsx:268-269` 已持有 `useBases()` / `useKbList()`（现用于实体图标索引），L1 数据源现成。
- 前端需改约 **15 个文件**（含测试）：`WorkspaceShell`、`PrimaryNav`、`SecondaryNav`、`NavComposer`、`EntityPickerModal`、`MoveToGroupModal`、`nav-hooks`、`api/client`、`lib/menu-ops`、`PermNodeTree` 等。
- 后端：`domain/nav/` 13 个域文件 + `routes/v1/{workspace,nodes,index}.ts`。
- **最大风险是测试**：api 侧 34 个 nav/menu 相关测试文件、前端 5 个（`nav-render`/`nav-menu-polish`/`nav-dom-bounds`/`shell-stage1`/`secondary-nav-render`）整体失效需重写。
- **额外量**：L2 现由 `buildCollection(nav_nodes, menu_items)` 派生，去掉 `menu_items` 后「已收纳/未收纳」语义消失，L2 须改为按 baseId 列 tables —— **这是独立重写量，不是删除即可**。

**优先级**：P0

**修复方案（分两阶段，先解痛再动架构）**

- **阶段 A（立即做，成本小，彻底解决"建完为空"）**
  1. 后端：建库 / 建知识库事务内自动 upsert 一条 `menu_item` shortcut（`bases.ts:178` 之后、`kb/index.ts` create 之后）。幂等：已存在则跳过。
  2. 前端：`LibrarySwitcher` 从 `WorkspaceTopBar.tsx:43-45` 撤下，移入 L1（顶部）；L1 增加「新建数据库 / 新建知识库」入口（沿用现有按钮样式与 `gx-*` 令牌，不新增视觉语言）。
  3. 验收：新建库后 L1 立刻出现该库，无需手动收纳。

- **阶段 B（下线导航编排，与 D-03 一并规划）**
  1. L1 数据源退化为直接列 `bases + knowledge_bases`；停写 `menu_items`；下线「收纳到导航」入口与 `NavComposer`。
  2. L2 重写为「选中容器的子项列表」（见 D-03）。
  3. **决策点**：阶段 A 已能解决用户抱怨的核心症状；阶段 B 的代价主要在约 39 个测试文件重写。建议 B 与 D-03 合并单独立项，不要与 A 混在同一批改动里。

---

## 3. D-03 导航层级规则不统一（一级不得出现二级内容）

**问题描述**
期望规则：
- 最左为一级导航：数据库、知识库及相关管理功能；一级内不得呈现任何二级内容。
- 二级导航由一级选中项决定：选中数据库 → 展示该库下的表；选中知识库 → 提供文档/画布选项卡并展示对应数据列表。
- 右侧主区域仅依据二级选中项渲染内容、编辑、列表等操作区。

**根因分析**
- L2 现在是「收纳 / 资产 collection 面板」，不是「选中容器的子项列表」：`SecondaryNav.tsx:40-43` 三个视角 tab「全部/未收纳/已收纳」，`:85 buildCollection(tree.items, menu.items)` 由 nav_nodes + menu_items 派生，`:129-133` 按 table/doc/canvas 分组。
- 根因是 D-02 的连带产物：L2 的数据模型围绕「`menu_items` 收纳」设计，与「容器 → 子项」的层级模型不是一回事。**只要 L1/L2 还建立在编排层上，层级规则就不可能统一。**

**优先级**：P0

**修复方案**
1. 与 D-02 阶段 B 一并重写 L2：数据源改为「选中容器」—— 选中 base → 列该 base 下的 tables；选中 kb → 文档/画布 tab + 对应列表。
2. 去掉「收纳」语义（全部/未收纳/已收纳），改为「文档 / 画布」tab（知识库）与「表列表」（数据库）。
3. 一级导航只保留：数据库分组、知识库分组、管理功能（通讯录 / 权限 / 设置，按 D-07 加门控）。
4. 「收纳到导航」入口随之下线；若仍需「把实体放进侧栏」的能力，改由 D-02 阶段 A 的自动 shortcut 承担。
5. 验收口径：一级任意一项下不得出现子级缩进项；切换一级 → 二级整体换源；主区只跟随二级。

---

## 4. D-04 一级与二级导航均需支持收起/展开

**问题描述**
要求一级、二级导航都可收起，用于扩大主内容可视区域。

**根因分析**
折叠能力只做了一半：
- L1 有且持久化：`lib/l1-collapse.ts:8` 键 `gx.l1.collapsed`，`WorkspaceShell.tsx:252` 读、`:291-297` 写。
- **L2 没有等价机制**：只有 `l2Hidden`（`WorkspaceShell.tsx:251`），初值由 `isFloatingL2Tier(tier)` 响应式档位决定，`:349` onClose / `:411` onOpen；无 localStorage、无独立收起按钮。（已搜 `L2_COLLAPSED|l2Collapsed|secondaryCollapsed|L2折叠|L2收起`，仅命中 `Shell.tsx:246` 注释）
- 根因：L2 的显隐被当成「响应式行为」，而不是「用户意图」，因此没有持久化。

**优先级**：P1

**修复方案**
1. 新增 `apps/web/src/features/workspace/lib/l2-collapse.ts`，与 L1 同构：常量（`L2_COLLAPSED_KEY="gx.l2.collapsed"`）+ 读写函数 + 默认值。
2. L2 面板头加收起按钮；收起后保留一条 56px 竖条（与 L1 折叠态同构：`L1_WIDTH_COLLAPSED=56`）。
3. 优先级规则：**用户显式收起 > 响应式档位**（窄屏自动收起后，用户手动展开的值要能被记住并覆盖档位默认值）。
4. 与 `l1-collapse.ts` 共用同一套读写范式，不要再发明第二种持久化写法。

---

## 5. D-05 通讯录部门管理缺「添加已有成员」入口

**问题描述**
部门管理里只能新建用户，无法把系统中已存在的成员加进部门。

**根因分析**
- 后端**已支持**：`apps/api/src/routes/v1/org/members.ts:67-68` `POST /:id/departments`，body `{ add?, remove?, mainDeptId? }`，守卫 `requireOrgAction("manage_members")`；前端封装 `client.ts:975-982 OrgMembers.assignDepartments`。
- 唯一调用点只在「成员 → 部门」方向：`MemberDrawer.tsx:76-84`（勾选后 diff 出 add/remove）。**部门 → 成员方向没做入口**。
- 部门菜单现状：`DeptTree.tsx:166-169` 仅 4 项 —— 新建子部门 / 重命名 / 移动到… / 删除部门。
- 现有「添加」按钮是新建用户：`MemberList.tsx:108`/`:161` → `InviteMemberModal.tsx`，两路都是建账号（邀请 INVITED `client.ts:963` / 直建 ACTIVE `client.ts:969`）。
→ **后端零改动，前端缺一个入口**。

**优先级**：P1

**修复方案**
1. `DeptTree.tsx` 部门菜单新增「添加已有成员」（`canManage` 才渲染，与 `:96` 同款门控）。
2. 打开人员选择器：优先复用现有人员选择弹窗；若无，复用 `EntityPickerModal` 或新增最小选择器 —— 不得新增第二套人员数据结构。
3. 选中后调 `OrgMembers.assignDepartments({ id, add: [...deptIds] })`，处理去重与「已在本部门」过滤。
4. 验收：给部门加一个已存在的成员后，成员详情页的部门归属同步显示。

---

## 6. D-06 右上角与左下角个人信息编辑入口重复

**问题描述**
两处都能编辑个人信息，需只保留其一。

**根因分析**
- 顶栏右：`WorkspaceTopBar.tsx:70-83` 头像按钮 → `setPersonalCenterOpen(true)` → 渲染于 `:85`。
- 侧栏底：`WorkspaceShell.tsx:119-148` UserCard → 渲染于 `:145`。
- 旧壳另两处：`Sidebar.tsx:302-305` → `:368`；`KbSidebar.tsx:123-126` → `:143`。
- 四处打开的是**同一个** `PersonalCenterDrawer`，属同一份编辑能力；路由表里不存在 `/profile`、`/me`、`/account`（`App.tsx:124-191`），没有第二条独立路径。

**优先级**：P1

**修复方案**
1. 保留右上角（符合通用产品直觉，且是登出入口的载体）。
2. 移除侧栏底部（与 D-01 同一处改动，一次完成）。
3. 旧壳 `Sidebar` / `KbSidebar` 两处：默认布局已不走旧壳（`App.tsx:155-165` 统一走 `ShellGate`，`featureFlags.ts:3` 默认 `GX_ENTERPRISE_NAV=on`），但为消除不一致建议一并清掉；若旧壳仍需保留，则至少不再新增入口。

---

## 7. D-07 无权限应完全隐藏而非可见不可改（复测结论：问题真实存在）

**问题描述（待复测项）**
无权限用户对某功能或某张表应完全隐藏，而非可见但不可修改。

**复测结论：真实存在，且是三种形态并存，不是个别遗漏**

| 形态 | 实证 | 判定 |
|---|---|---|
| 已隐藏（正确） | `MemberList.tsx:107 {canManageMembers && <Button>}`、`DeptTree.tsx:96 {canManage && <IconButton>}`、`WorkspaceSettingsPage.tsx:118 canManageMenu` | 符合 |
| 仅禁用（不符合） | `GridToolbar.tsx:298 disabled={!permissions.canEditData}`（`:301` title「无编辑权限」）；`KbHomePage.tsx:142`/`:151` 新建文档/画布 `disabled={!canCreate}`（定义 `:65`）；`SettingsPage.tsx:280` 名称 Input `disabled={!canManageBase}` + `:329`「仅所有者可执行此操作」；`:326` 删除 Base 按钮仅 disabled | 不符合 |
| **完全无门控（最严重）** | `WorkspaceShell.tsx:99-105` FooterNav 对 `nav-footer.ts:17-22` 四项（含 `/workspace/authz` 权限管理、`/workspace/settings/assets` 工作区设置）**无条件 map 渲染**；`PermPanel.tsx:12-16` 页面本体也无门控（`useAuthzCapability.ts:1-7` 注释证实门控只下沉到内部写入口） | 严重 |

附加问题：**权限判定口径分散为两套** —— contacts 用 `actions.has()`（`ContactsPage.tsx:14-16`），authz 用 `canManageAuthz`（`lib/capability.ts:13`）；全仓不存在统一的 `can()` / `useCapability()`。

**优先级**：P0（导航层无门控）/ P1（禁用改隐藏）

**修复方案**
1. **先补导航层门控（P0，立即做）**：`WorkspaceShell.tsx:99-105` 的 FooterNav 按能力过滤四项；`PermPanel` 加页面级门控（无权限重定向或显示无权限态，而不是渲染出完整策略树）。
2. **禁用改隐藏（P1）**：管理类操作（删除库、库设置名称编辑、知识库新建文档等）改为不渲染入口，或降级为只读展示。
3. **红线（必须遵守）**：隐藏不能造成「功能凭空消失」的困惑 —— 判据是：
   - **管理类 / 配置类入口** → 隐藏（用户本就不该知道它的存在）；
   - **数据编辑类操作**（工具栏加记录等）→ 保留禁用 + 明确提示原因（用户需要知道"我能看但不能改"）。
4. **统一口径（P2，架构项）**：收敛 `actions.has()` 与 `canManageAuthz` 为统一 `useCapability()`，避免两套判定继续分叉。

---

## 8. E-01 工作区设置治理（延伸要求）

### 现状清单（7 个设置/管理页）

| 路由 | 文件 | 分区 |
|---|---|---|
| `/base/:baseId/settings` | `features/settings/SettingsPage.tsx` | 概览/成员与权限/分享/数据表/危险操作（`:24-30`，渲染 `:293`）|
| `/base/:baseId/trash` | `TrashPage.tsx` | 库回收站 |
| `/kb/:kbId/settings` | `features/kb/KbSettingsPage.tsx` | 成员与权限（`:89`）、上传限制（`:95`）、基本信息 |
| `/kb/:kbId/trash` | `KbTrashPage.tsx` | 知识库回收站 |
| `/workspace/contacts` | `ContactsPage.tsx` | 成员与部门 / 角色（`:83-84`）|
| `/workspace/authz` | `PermPanel.tsx` | 权限管理（左资源树 + 右策略，`:20`/`:33-38`）|
| `/workspace/settings/*` | `features/workspace/WorkspaceSettingsPage.tsx` | 通用/通讯录/导航编排/语义检索/MCP接入/资产（`:33-38`）|

### 重复交叉（实证，两端行号）

1. **成员三处**：库级 `MembersPanel`（`SettingsPage.tsx:293`；`MembersPanel.tsx:42/44/73`，5 角色 × 5 权限矩阵 `:2`）；知识库级 3 角色（`KbSettingsPage.tsx:57/168`）；组织级（`MemberList.tsx:161`、`RoleManager.tsx:60`）。切面不同但能力同名。
2. **角色三处**：库权限矩阵（`MembersPanel.tsx:2`）、通讯录自定义角色 CRUD（`RoleManager.tsx:60`）、authz 节点策略（`PermPanel.tsx:33+`）。
3. **通讯录三入口同指一页**：FooterNav（`nav-footer.ts:18`）、`Sidebar.tsx:282`、工作区设置 contacts 分区（后者仅一个跳转按钮、无内容，`WorkspaceSettingsPage.tsx:235-248`）。
4. **PAT 令牌**：`PatListPanel` 被工作区设置 MCP 分区复用（`WorkspaceSettingsPage.tsx:18/282`）。（与个人中心抽屉同源属**推断**，未逐行核实）
5. **回收站分裂**：库（`Sidebar.tsx:276`）与知识库（`KbSidebar.tsx:95`）各一，无统一入口。
6. **上传限制**：仅 `KbSettingsPage.tsx:95` 一处，不重复 —— 但它**全局生效**却挂在知识库设置里，属于语义错位。

### 入口层级与布局

- 最深 3 层：知识库设置（首页 → FooterNav 工作区设置 → 资产 → 点知识库）。语义检索 / MCP 各 2 层，库设置 1 层。
- FooterNav「工作区设置」直接落到 `/workspace/settings/assets` 子页，与「无 splat 落 general」不一致。
- 设置入口**无「更多」溢出嵌套**（已搜 `更多|MoreHorizontal|Ellipsis|DropdownMenu|Popover`，仅命中 `shell/TopBar.tsx:161` 与 `Sidebar.tsx:200`，均非设置入口）。
- 布局：`WorkspaceSettingsPage.tsx` 左固定 208px（`w-52`）+ 右内容（`min-w-0 flex-1`，`:197`），非 Tabs；**无 `md:`/`lg:`/`xl:` 断点、无 `flex-wrap`**，1024 宽下左栏硬占 208px 无降级。
- **已在的守卫 + 同类隐患**：`effectiveSection` 在 `:139-140`（兜底非 owner 直戳 search / 非企业直戳 mcp → general）；但 `:202`/`:260`/`:274` 用 `effectiveSection`，而 `:235`(contacts)/`:250`(nav)/`:286`(assets) 用原始 `section` —— **三口径混用**，新增一个 gated section 若沿用 `section` 就会复现「点左侧右侧空白」。

### 修复方案

1. **统一「成员与角色」切面**：库级 = 库内成员；知识库级 = 知识库成员；组织级 = 部门 + 全局角色。工作区设置里的通讯录分区只做**说明 + 跳转**，不再提供第二套编辑能力（现状已是跳转，需补齐说明文案，避免"点了像没反应"）。
2. **上传限制上提**：从 `KbSettingsPage` 移到工作区设置（它是全局生效的，放在知识库设置里语义错位）。知识库设置页留一行指向全局设置的说明。
3. **回收站**：保留库 / 知识库各自入口（符合就近原则），在工作区设置补一个聚合入口。
4. **布局**：左栏加响应式降级（<1024 抽屉化），并把三处 `section` 口径统一为 `effectiveSection`。
5. **FooterNav 分层**：四项按 D-03 的一级/二级规则改造（管理类走二级子菜单），并落实 D-07 的门控。

**优先级**：P1（治理）/ P2（布局响应式）

---

## 9. E-02 语义检索缺失的远端模型 API 配置项（延伸要求）

### 现状

- **总门**：`GX_M5_SEARCH` 三态 off/shadow/on，只认小写、默认 off（`configM5Search.ts:20-24`、`config.ts:331`）；off 时六个管理端点全 404（`adminSearch.ts:3-4`）。
- **六个端点**（均 owner 门 `adminSearch.ts:39-42`）：`POST /admin/reindex`(`:57`)、`GET /admin/search/status`(`:112`)、`GET /admin/embedding/config`(`:123`)、`PATCH /admin/embedding/config`(`:143`)、`POST /admin/embedding/api-key/rotate`(`:168`)、`DELETE /admin/embedding/api-key`(`:193`)。
- **PATCH 已支持**：mode（仅 `off|cloud`，`:157`）、baseURL(`:173`)、model(`:188`)、batchSize(`:200`)、timeoutMs(`:215`)、fieldChunkCap(`:232`)、confirmCloud(`:163`)、apiKey(`:253`)；契约见 `packages/shared-types/src/api.ts:517-528`。
- **持久化**：主库 `app_settings` 表（`embeddingConfig.ts:22-31`，键 `embedding.mode/base_url/api_key_cipher/model/batch_size/timeout_ms`、`search.field_chunk_cap/reindex_required`）；apiKey AES-256-GCM 加密、密钥由 jwtSecret HKDF 派生（`:34-36`/`:213`）；env 仅作首启种子，**db 优先于 env**（`:8`）→ **有运行时写接口，不是只能改 env**。
- **前端 UI 已存在**：`features/search/EmbeddingSearchPanel.tsx`，挂 `WorkspaceSettingsPage.tsx:266`（ownerOnly `:36`）；字段有服务地址(`:190`)、模型名称(`:194`)、批量大小/超时(`:196-199`)、字段索引上限(`:201`)、dim 只读显示(`:208-211`)、密钥写入/轮换/清除(`:225-240`)。

### 缺失项（本次要补）

1. **`provider` 概念不存在** —— 远端只有 `cloud` 一种，无法接 OpenAI 兼容端点 / 自建服务。
2. **`dimension` 显式拒绝入参**（`adminEmbedding.ts:145-146`「维度由 model 元数据决定」）—— 自建模型场景下无法指定。
3. **并发 / 重试无配置项**（搜 `concurren|retry|parallel|batch` 仅命中 batchSize）。
4. **总门 `GX_M5_SEARCH` 只能改 env 重启**，无写接口无 UI（`SearchEnableGuide.tsx:3-5` 原文自述）。

### 修复方案

1. **总门可运行时配置**：在 `app_settings` 增加 `search.enabled` 覆盖，前端语义检索页提供开关；不可热切换的部分在 UI 上明确标注「需重启生效」，不要让用户以为点了没用。
2. **补 provider**：契约加 `provider`（`cloud` / `openai-compatible` / `self-hosted`），baseURL 与 model 随 provider 走；`dimension` 在 `self-hosted` 下允许手动指定（解除当前的硬拒），其余仍由 model 元数据决定。
3. **补并发与重试**：新增 `embedding.concurrency`、`embedding.retry`（次数 + 退避），后端消费这两个值。
4. **补连通性自检**：配置页加「测试连接」按钮，调后端探活（不落库），避免"配完不知道通不通"。
5. **优先级**：P1；涉及 shared-types 契约改动，改完 web + api 都要 typecheck。

---

## 10. 同类缺陷排查（用户未点名、本次一并查出）

| 编号 | 问题 | 处置 |
|---|---|---|
| C-01 | `PrimaryNav.tsx:126`/`:318-320`「个人门户」是带 `plannedHint` 的规划入口，与 D-01 同为「规划中功能不该出现在正式界面」 | 归入需求池；若保留则不得新增同类入口 |
| C-02 | 旧壳 `Sidebar.tsx:302-305`/`KbSidebar.tsx:123-126` 仍有重复的个人信息入口，`:276`/`:95` 有分裂的回收站入口，`:282` 有第三个通讯录入口 | 与 D-06 / E-01 一并处理；默认布局不走旧壳，建议整体下线旧壳 |
| C-03 | `WorkspaceSettingsPage` 三处用 `section`、三处用 `effectiveSection`，口径混用会复现「点左侧右侧空白」 | E-01 第 4 条 |
| C-04 | 权限判定两套口径（`actions.has()` vs `canManageAuthz`），无统一 `can()` | D-07 第 4 条 |
| C-05 | `WorkspaceSettingsPage` 无响应式断点，1024 下左栏硬占 208px | E-01 第 4 条 |

---

## 11. 分期实施计划

**第一批（低风险、可立即执行）**
- D-01 移除侧栏底部用户信息栏
- D-06 个人信息入口去重（保留右上角）
- D-05 部门「添加已有成员」（后端零改动）
- D-07① FooterNav + PermPanel 权限门控

**第二批**
- D-02 阶段 A：建库/建知识库自动入导航 + 建库与库切换入口移入 L1
- D-04 L2 收起/展开 + 持久化
- D-07② 管理类入口由「禁用」改「隐藏」

**第三批（需决策后单独立项）**
- D-02 阶段 B + D-03：下线导航编排、L1 改列实体、L2 重写为「选中容器的子项」
- 代价：前端约 15 文件 + 后端 13 域文件 + **约 39 个测试文件需重写**。建议单独排期，不与前两批混改。

**第四批**
- E-01 工作区设置治理（切面收敛、上传限制上提、布局响应式、口径统一）
- E-02 语义检索配置补齐（provider / dimension / 并发重试 / 运行时总门 / 连通性自检）

---

## 12. 验收口径（每批完成后的机械复验项）

1. `pnpm -w typecheck` 七包全 Done；web / api / shared / canvas 测试总数不低于基线。
2. 真机浏览器逐条点验：新建库后 L1 立即出现（D-02 A）；L1/L2 收起后刷新保持（D-04）；部门可加已有成员（D-05）；无权限账号看不到管理入口（D-07）。
3. 无权限账号复测必须**真的用一个受限账号登录**，不能用管理员账号推断。
4. 每批改动后跑一次既有导航/设置相关测试，确认没有把 `nav-render`/`shell-stage1` 等基线打崩。
