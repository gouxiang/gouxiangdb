# 07 · 已实现交互全量清单

> 版本 v1.0 ｜ 2026-09-18 ｜ 状态：**待确认**
> 盘点方式：对 `apps/web/src`（212 个 ts/tsx 文件）做只读全量勘察，按区域穷举每个交互的**触发条件 / 处理逻辑 / 边界与异常状态**，并对照本目录现行设计文档判定覆盖度。
> 本文件是**设计补全的事实基线**：任何"这个交互新设计没画"的判断都以此为准。
> 证据粒度到文件；行号在勘察记录中，需要时按文件 + 关键词即可定位。

---

## 0. 口径与判定标准

### 0.1 覆盖范围

| 区 | 内容 | 文件规模 |
|---|---|---|
| A 壳层与路由 | App 路由守卫、双壳开关、WorkspaceShell、顶栏、库切换器、全局搜索 | 约 130 条 |
| B 一级导航 | PrimaryNav、菜单树数据流、三态过滤、虚拟化 |  |
| C 二级导航 | SecondaryNav、三视角、收纳/移动 |  |
| D 导航编排器 | NavComposer、ComposerTree、拖拽 |  |
| E 表格与视图 | Grid、单元格编辑、键盘、选择、筛选/分组/排序、聚合、分页、记录抽屉、看板/日历/画廊/表单/详情 | 约 114 条 |
| F 字段与表单设计器 | FieldEditorSheet、FieldSettingsPanel、FormDesigner、视图设置 |  |
| G 反馈基座 | Toast、Modal、Popover、ContextMenu、Drawer、上传、危险操作确认 | 约 200 条 |
| H 认证/权限/异常 | 登录引导、强制改密、401/403/409/429 拦截、RBAC→UI、ErrorBoundary、异步基础设施 | 约 95 条 |
| I 设置/通讯录/搜索/ERD | 工作区设置、数据库设置、成员、部门、角色、PAT、语义检索、ERD、导入导出 | 约 140 条 |
| J 知识库 | 侧栏、文档树、编辑器顶栏、自动保存、Markdown/WYSIWYG、大纲、画布、分享/版本 | 约 80 条 |

### 0.2 覆盖度图例

| 标记 | 含义 | 后续动作 |
|---|---|---|
| ✅ **覆盖** | 现行设计文档已给出该交互的规格或状态 | 沿用，无需补 |
| ⚠️ **部分** | 文档只给了容器/尺寸/激活态，行为分支或异常态缺失 | **需补全设计** |
| ❌ **未覆盖** | 文档无对应条目 | **需新增设计** |
| 🔧 **设计已定·代码待改** | 设计稿（尤其 03 v3.0）已明确要求，实现尚未跟上 | 属落地任务，**不是设计缺口** |
| ➖ **沿用** | 按 `01-page-inventory.md` §5 裁决为内容区（C 级不动） | 本轮不设计，仅登记 |

### 0.3 关键区分（避免误判）

盘点中出现两类"对不上"，性质完全不同，处置方式也不同：

- **❌ 未覆盖**＝交互存在，但新设计稿没画 → 本轮要补设计。
- **🔧 设计已定·代码待改**＝新设计稿已明确要求（如 L2 竖向三点、ContextBar、顶栏无库切换器），代码还是旧实现 → 属于重构落地项，不计入设计缺口。

`03-navigation.md` v3.0 已定但代码中尚不存在的典型项：L2 竖向三点 ⋮、视图标签条 ⋮、ContextBar 独立成条、顶栏移除库切换器、L1 底部「回收站」、二级面板＝纯数据表列表。

---

## 1. 总览统计

| 区 | 交互数 | ✅ | ⚠️ | ❌ | 🔧 | ➖ |
|---|---|---|---|---|---|---|
| A 壳层与路由 | 46 | 4 | 17 | 23 | 2 | 0 |
| B 一级导航 | 15 | 3 | 5 | 7 | 0 | 0 |
| C 二级导航 | 17 | 1 | 4 | 10 | 2 | 0 |
| D 导航编排器 | 24 | 1 | 2 | 21 | 0 | 0 |
| E 表格与视图 | 114 | 22 | 33 | 54 | 0 | 5 |
| F 字段与表单设计器 | 32 | 2 | 6 | 24 | 0 | 0 |
| G 反馈基座 | 118 | 30 | 31 | 55 | 2 | 0 |
| H 认证/权限/异常 | 95 | 5 | 13 | 77 | 0 | 0 |
| I 设置/通讯录/搜索/ERD | 138 | 3 | 22 | 108 | 5 | 0 |
| J 知识库（外壳 29 / 内容 51） | 80 | 9 | 14 | 26 | 0 | 31 |
| **合计** | **679** | **80** | **147** | **405** | **11** | **36** |

> 结论：设计文档目前的覆盖集中在**容器尺寸、配色、激活态**这类静态规格；**行为分支、especially 异常态与权限分支**是最大的空洞（约 60% 未覆盖）。

---

## 2. A · 壳层与路由

| ID | 交互 | 触发 | 处理逻辑 | 边界 / 异常 | 覆盖 | 位置 |
|---|---|---|---|---|---|---|
| A-01 | 未登录拦截 | 任意受保护路由 | 读 zustand token，空则跳 `/login` | 仅看本地 token，不做服务端校验；过期 token 会先放行再被 401 硬跳 | ❌ | App.tsx |
| A-02 | 强制改密闸门 | `mustChangePassword===true` 且非 `/change-password` | 跳 `/change-password` | 字段缺失的旧账号视为无需改密；闸门下其它页面无设计 | ❌ | App.tsx / force-change-guard.ts |
| A-03 | 已登录访问 `/login` | token 存在 | 跳 `/` | 二次跳转（`/` → 首个 Base） | ❌ | App.tsx |
| A-04 | 404 兜底 | 路由未匹配 | 静默跳 `/` | 无 404 页面、无返回上一步 | ❌ | App.tsx |
| A-05 | `/` → 首个 Base | 访问根 | bases 加载中 Spinner；空数组显示空态 | **空库态**（"还没有任何 Base"）未设计 | ❌ | App.tsx |
| A-06 | 库根 → 首表 | `/base/:id` | 无表则跳 `/base/:id/settings` | 无表时跳设置页而非空态 | ❌ | App.tsx |
| A-07 | 表 → 首视图 | `/base/:b/table/:t` | 无视图跳 settings；`?design=1` 优先挑 detail 视图 | — | ❌ | App.tsx |
| A-08 | **错误边界按 pathname 重挂** | 任意路由变化 | `key=shell-${pathname}` 强制重挂整棵壳子树 | **副作用**：L1 折叠态、二级面板、抽屉、导航滚动位置每次跳转全丢 | ❌ | App.tsx |
| A-09 | 公开/匿名路由 | `/s/:token`、`/join/:token`、`/invite/:token` | 不套壳、不套守卫 | token 失效由页内自理 | ❌ | App.tsx |
| A-10 | 子路径部署 | 启动 | `BASE_URL` → Router basename + `withBase` | 设计稿无子路径约束 | ❌ | main.tsx / lib/base.ts |
| A-11 | QueryClient 默认策略 | 任意查询 | `retry:1`、`refetchOnWindowFocus:false`、`staleTime:5s` | **无离线/断网态** | ❌ | main.tsx |
| A-12 | 全局 401 登出 | 任意 401（除白名单） | 清 token + `window.location.assign` 硬跳 | 硬跳丢失全部状态；无提示文案；无 returnUrl | ❌ | api/client.ts |
| A-13 | 路径零变化 | base/kb/workspace 三组路由 | 新旧壳共用同一组路径 | — | ✅ | App.tsx |
| B-01 | navV2 探活 | ShellGate 挂载 | `GET /workspaces/current/menu`：200→新壳，404→旧壳 | 5xx 抛错不静默回退；模块级缓存只探一次 | ⚠️ | featureFlags.ts |
| B-02 | 探活中占位 | `isLoading` | 全屏中性 Spinner(22) | 无文案、无超时兜底（请求卡住即永久转圈） | ❌ | ShellGate.tsx |
| B-03 | flag on | — | 渲染 WorkspaceShell | — | ✅ | ShellGate.tsx |
| B-04 | flag off | — | `/kb` 前缀→KbShell，否则 AppShell | 路径前缀硬编码；旧壳一整条回退路径无设计 | ⚠️ | ShellGate.tsx |
| B-05 | 导航编排权限 | 进入 nav 设置 | 无 `manage_menu` → 只读提示，不挂载编排器 | actions 加载中按无权限（fail-closed），无骨架屏 | ❌ | WorkspaceSettingsPage.tsx |
| C-01 | ⌘K 全局搜索 | window keydown | `preventDefault` + 打开 SearchDialog | 输入框内也会触发；无对称关闭键 | ⚠️ | WorkspaceShell.tsx |
| C-02 | 宽窄断点 | window resize | `innerWidth>=1024` → wide | 无节流；<1024 左栏整体消失、二级面板永不渲染 | ❌ | WorkspaceShell.tsx |
| C-03 | 窄屏抽屉 | 点导航触发条 | `setDrawerOpen(true)` | 触发条常驻占一行；无图标折叠态 | ❌ | WorkspaceShell.tsx |
| C-04 | 抽屉遮罩关闭 | 点遮罩 | 关闭抽屉 | 遮罩是 `<button>`；**无 Esc 关闭** | ❌ | WorkspaceShell.tsx |
| C-05 | 路由变化收抽屉 | pathname 变化 | 自动收起 | query 变化不收 | ❌ | WorkspaceShell.tsx |
| C-06 | 窄屏点容器 | 抽屉内点容器 | 写 secondary 但渲染条件为 `wide && secondary` | **窄屏死交互，无任何反馈** | ❌ | WorkspaceShell.tsx |
| C-07 | 打开二级导航 | 点一级容器 | 记录 `{containerId, name}`（label 优先，回退实体名） | — | ⚠️ | WorkspaceShell.tsx |
| C-08 | 二级面板重挂 | 切容器 | `key=containerId` 重置 tab/搜索/展开 | 同容器内滚动位置也丢失 | ❌ | WorkspaceShell.tsx |
| C-09 | 二级面板关闭 | 点 X | `setSecondary(null)` | 无 Esc；关闭后无记忆 | ❌ | SecondaryNav.tsx |
| C-10 | 底部固定区导航 | 点四项 | 跳 contacts / authz / settings-nav / settings-assets | **无回收站**；命名与 03 §2.3 不一致 | 🔧 | WorkspaceShell.tsx |
| C-11 | 底部区选中 | 路径匹配 | accent 底 + 左 3px 竖条 | 与 03 §2.4「白卡 + shadow」规格不同 | ⚠️ | WorkspaceShell.tsx |
| C-12 | 主内容区 | — | `<Outlet/>`，无 ContextBar | **ContextBar（03 §4）代码中不存在** | 🔧 | WorkspaceShell.tsx |
| C-13 | 顶栏品牌点击 | 点 Logo | 跳 `/` | <1024 只留图标 | ✅ | WorkspaceTopBar.tsx |
| C-14 | 顶栏搜索按钮 | 点击 | 打开 SearchDialog，带 ⌘K 徽标 | 弹性 `max-w-md` ≠ 文档 300×34 | ⚠️ | WorkspaceTopBar.tsx |
| C-15 | 头像 → 个人中心 | 点击 | 打开 PersonalCenterDrawer | **无通知入口**；头像 24 ≠ 文档 30 | ⚠️ | WorkspaceTopBar.tsx |
| C-16 | 顶栏库切换器 | 点击 | 打开 LibrarySwitcher | 与 03 §5「顶栏不再出现库切换」冲突 | 🔧 | WorkspaceTopBar.tsx |
| C-17 | 退出登录 | footer 按钮 | 清 store + 跳 `/login` | 与 401 硬跳是两条路径 | ⚠️ | PersonalCenterDrawer.tsx |
| I-01 | 库切换展开 | 点触发器 | 显示当前库名 + 色点 | 无匹配显示「选择库」 | 🔧 | LibrarySwitcher.tsx |
| I-02 | 库切换搜索 | 输入 | 分数据库/知识库两段过滤 | 无虚拟化；两段皆空→「没有匹配的库」 | ❌ | LibrarySwitcher.tsx |
| I-03 | 切换库 | 点条目 | 关闭 + 跳转（再经两次重定向） | — | ❌ | LibrarySwitcher.tsx |
| I-04 | 浮层外部关闭 | mousedown / Esc | 延迟一帧挂载监听避免立即关闭 | 无焦点归还触发器 | ⚠️ | ui.tsx Popover |
| I-05 | 新建库 | 菜单项 | Modal：名称 + 类型二选一卡片 | `creating` 防重；失败 toast | ❌ | LibrarySwitcher.tsx |
| I-06 | fixed 浮层防溢出 | 祖先 overflow 裁剪 | 视口定位 + 滚动跟随 | 侧栏未启用 fixed | ❌ | ui.tsx Popover |
| K-01 | 登录态持久化 | setAuth / logout | localStorage `gx-auth` | **壳与导航无任何其它持久化**：折叠态/tab/滚动位置全不存 | ❌ | store/auth.ts |
| K-02 | 局部更新 user | 个人中心保存 | 合并 patch | user 为 null 时 no-op | ❌ | store/auth.ts |

---

## 3. B · 一级导航 PrimaryNav

| ID | 交互 | 触发 | 处理逻辑 | 边界 / 异常 | 覆盖 | 位置 |
|---|---|---|---|---|---|---|
| D-01 | 菜单树拉取 | 挂载 | `useNavMenu()`，staleTime 10s | 全员同一份不剪枝 | ❌ | nav-hooks.ts |
| D-02 | 三态占位 | loading / error / 空 | Spinner /「导航加载失败，刷新重试」/「暂无导航项」 | **错误态无重试按钮** | ⚠️ | PrimaryNav.tsx |
| D-03 | 三态过滤（浏览态） | 渲染 | 只留 `state==="alive"` 的快捷项；容器恒留 | soft_dangling 隐藏、broken 隐藏 | ✅ | menu-tree.ts |
| D-04 | 组树 | items 变化 | `parentId` 真相 + `ord` + `id` 兜底 | 脏数据（父项缺失）挂到根，避免整树白屏 | ❌ | menu-tree.ts |
| D-05 | 容器折叠/展开 | 点 chevron | Set 增删；`aria-expanded` | **折叠态不持久化**，且被 A-08 的重挂在每次跳转后重置 | ⚠️ | PrimaryNav.tsx |
| D-06 | 折叠影响摊平 | collapsed 变化 | 折叠容器的子行不摊平 | 空容器仍渲染（不剔除） | ❌ | menu-tree.ts |
| D-07 | 点容器名 | 点击 | 打开二级面板 | 与 chevron 是两个独立按钮 | ✅ | PrimaryNav.tsx |
| D-08 | 点快捷项跳转 | 点击 | 按 kind 解析 href 后 navigate + 展开父容器 | **href 解析失败（view/group/祖先缺失）→ 整行禁用**；深于 maxDepth=10 不解析 | ⚠️ | nav-links.ts |
| D-09 | 激活高亮 | 路由参数 | 资源 id 优先级 tableId > docId > baseId > kbId | **同一实体多处挂载会多处高亮** | ❌ | menu-tree.ts |
| D-10 | 激活样式 | 命中 | accent 底 + 左 3px 竖条 | 与 03 §2.4 白卡规格不同 | ⚠️ | PrimaryNav.tsx |
| D-11 | **行虚拟化** | 滚动 / resize | `NAV_ROW_H=32`，`overscan=12`，padTop/padBottom 撑高 | **只有窗口内行在 DOM → Tab 无法到达未渲染行**；无 `role="tree"`/`aria-setsize` | ❌ | useMenuVirtualizer.ts |
| D-12 | 缩进 | 渲染 | `8 + depth*14` | — | ✅ | PrimaryNav.tsx |
| D-13 | 图标解析 | 渲染 | `iconName` 白名单优先，否则 `navKindIcon(kind)` | 白名单外可能渲染失败，无兜底 | ⚠️ | PrimaryNav.tsx |
| D-14 | 别名显示 | 渲染 | `label ?? summary.name`，`title` 显示真实名 | 编排态另加「→ 原名」 | ❌ | PrimaryNav.tsx |
| D-15 | 空容器计数 | — | `visibleShortcutCount` 已导出但**全仓无调用** | 空容器灰显能力存在但未接线 | ❌ | menu-tree.ts |

---

## 4. C · 二级导航 SecondaryNav

| ID | 交互 | 触发 | 处理逻辑 | 边界 / 异常 | 覆盖 | 位置 |
|---|---|---|---|---|---|---|
| E-01 | 数据装配 | 挂载 | `useNavTreeDeep(parentId=root, maxDepth=10)` + `useNavMenu` | `all=1` 是管理员通道（普通成员 403） | ❌ | nav-hooks.ts |
| E-02 | 三视角切换 | 点胶囊 tab | 全部 / 未收纳 / 已收纳 | **与 03 §3 的「纯数据表列表」口径不同** | 🔧 | SecondaryNav.tsx |
| E-03 | 未收纳计数徽标 | collection 变化 | 嵌套 doc 跟随父文档不计入；view/base/kb/group 不参与 | — | ✅ | SecondaryNav.tsx |
| E-04 | 列表内筛选 | 输入 | 名称 `includes` 过滤 | 无防抖；不进 URL；空态「没有匹配的内容」 | ⚠️ | SecondaryNav.tsx |
| E-05 | 三分区 | 渲染 | 按 kind 分 数据表 / 文档 / 画布，空段不产段头 | 03 §3 只有单段「数据表」 | 🔧 | SecondaryNavSections.tsx |
| E-06 | 文档树展开/折叠 | 点箭头 | Set 增删；无子文档的箭头 `invisible` | 孙级递归 push | ⚠️ | SecondaryNavSections.tsx |
| E-07 | **hover 才出现的行操作** | `group-hover` | `opacity-0 group-hover:opacity-100` | **键盘与触屏不可达**；且是横向图标，不是 03 要求的竖向三点 | 🔧 | SecondaryNavSections.tsx |
| E-08 | 收纳到导航 | 点 + | PATCH insert 快捷项 → toast → 失效 menu | **即时落库非草稿**；无 loading；并发重复点击会插入多条 | ❌ | SecondaryNav.tsx |
| E-09 | 移动到分组 | 点 folder | `confirmed:false` → 409 → 影响弹窗 → `confirmed:true` 重发 | 无分组→引导去设置；非 409 直接 toast | ❌ | SecondaryNav.tsx |
| E-10 | 影响面确认 | 409 `MOVE_NEEDS_CONFIRM` | 显示受影响成员 / 子树内容 / 菜单引用三行 | 取消即丢弃，不重发 | ❌ | MoveImpactModal.tsx |
| E-11 | 点击行跳转 | 点名称 | 解析 href；为 null 时禁用灰显 | — | ❌ | SecondaryNavSections.tsx |
| E-12 | 当前资源高亮 | 路由参数 | `currentResource === node.resourceId` | 无 baseId/kbId 兜底 | ❌ | SecondaryNav.tsx |
| E-13 | 已收纳标记 | 渲染 | 行尾 check 图标 + 原生 `title` | 无 Tooltip 组件 | ⚠️ | SecondaryNavSections.tsx |
| E-14 | 容器子树限定 | 容器变化 | `scopeIds` 过滤；为 null 时不过滤（全量） | 容器未绑实体 → 退化为全工作区 | ❌ | SecondaryNav.tsx |
| E-15 | 空态 | 列表为空 | 「全部内容都已收纳」/「没有匹配的内容」 | — | ❌ | SecondaryNav.tsx |
| E-16 | 行虚拟化 | 滚动 | `SECONDARY_ROW_H=31`，段头也占定高行 | 同 D-11 键盘可达性问题 | ❌ | SecondaryNav.tsx |
| E-17 | 面板宽度 | — | `w-64`(256) | 03 规格 240 | ⚠️ | SecondaryNav.tsx |

---

## 5. D · 导航编排器 NavComposer

| ID | 交互 | 触发 | 处理逻辑 | 边界 / 异常 | 覆盖 | 位置 |
|---|---|---|---|---|---|---|
| F-01 | 草稿初始化 | menu 变化 | `setDraft(menu.items)` | **他人改动导致 menu 刷新时，本地未保存草稿被整体覆盖**，无冲突提示、无锁 | ❌ | NavComposer.tsx |
| F-02 | dirty 判定 | draft 变化 | `diffMenu(...).length>0` 决定保存/放弃按钮 | — | ❌ | NavComposer.tsx |
| F-03 | 保存（整单事务） | 点保存 | diff → insert/reorder/update/delete → 一次 PATCH | ops 为空→toast「没有需要保存的改动」；级联删除只发容器一条 | ❌ | menu-ops.ts |
| F-04 | 放弃改动 | 点放弃 | 用服务端数据重建 draft | **无二次确认** | ❌ | NavComposer.tsx |
| F-05 | 拖拽起止 | dragStart / dragEnd | 记录 dragId；结束时清空 | 编辑别名时不可拖（`draggable={!editing}`） | ❌ | ComposerTree.tsx |
| F-06 | 落点判定 | dragOver | 上/下半区 → before/after/into；指示器为顶部 2px 线或全行 ring | — | ❌ | ComposerTree.tsx |
| F-07 | 落点清除 | dragLeave | `!contains(relatedTarget)` → 清空 | 快速移动可能残留 hover | ❌ | ComposerTree.tsx |
| F-08 | 放置 | drop | `moveItem(draft, dragId, parentId, index)` | 未选落点时无操作 | ❌ | ComposerTree.tsx |
| F-09 | **成环拒绝** | 拖到自身/后代 | `isSelfOrDescendant` → toast「不能拖到自身或其子容器内」，不变更状态 | `not-found`/`same-position` 原因**静默无提示**；后端二次拦截 400 | ❌ | menu-ops.ts |
| F-10 | 根层放置条 | 拖到列表下方 | hover `{parentId:null,index:9999}` | 拖出窗口无取消逻辑 | ❌ | ComposerTree.tsx |
| F-11 | 排序重算 | move 成功 | 只重算受影响两个容器的 `ord`（0..n 连续） | 同父同位置返回 same-position | ❌ | menu-ops.ts |
| F-12 | 内联改别名 | 双击 / 点编辑 | `autoFocus+select`；Enter 保存、Esc 取消、**失焦即保存**、`maxLength=60` | 空串→`label:null`（回退实体名） | ❌ | ComposerTree.tsx |
| F-13 | 别名≠原名提示 | 渲染 | 显示「→ 原名」 | — | ❌ | ComposerTree.tsx |
| F-14 | broken 显灰 | 渲染 | 删除线 + hint 色 + 徽章「已失效」 | 徽章/删除线样式 05 未定义 | ⚠️ | ComposerTree.tsx |
| F-15 | hover 行操作 | group-hover | 容器：添加实体；全部：编辑别名、删除 | hover-only，键盘/触屏不可达 | ⚠️ | ComposerTree.tsx |
| F-16 | 删除快捷项 | 点 trash | `removeItem` → toast「已从草稿移除，保存后生效」 | 文案明确「仅移除这一处引用」 | ❌ | DeleteMenuModal.tsx |
| F-17 | 删除容器二策略 | 点 trash | radio：级联删除 / 移出后删除（选目标容器） | 目标排除自身与后代；未选目标时按钮 disabled | ❌ | DeleteMenuModal.tsx |
| F-18 | 添加实体到容器 | 点 plus | EntityPickerModal：三 Tab + 搜索 + 多选 | **硬截断 200 条无提示**；已在本容器仍可重复添加 | ❌ | EntityPickerModal.tsx |
| F-19 | 添加生效 | 确认 | 插入带本地临时摘要的草稿项 | 保存后由服务端回填覆盖 | ❌ | NavComposer.tsx |
| F-20 | 新建分组 | 点按钮 | 建权威 group → 再挂到根层菜单 | **分组创建立即落库、菜单挂载仍需保存**（两步原子性缺口） | ❌ | NavComposer.tsx |
| F-21 | 编排态恒展开 | 渲染 | `flattenMenuRows(tree, ()=>true)` | 无折叠交互 | ❌ | ComposerTree.tsx |
| F-22 | 兄弟序换算 | 拖拽期间 | 按 parentId 分组排除被拖项后排序 | 每次渲染重建 Map，大菜单拖拽有性能风险 | ❌ | ComposerTree.tsx |
| F-23 | 空菜单态 | draft 空 | 引导文案（建分组 / 从二级导航收纳） | — | ❌ | NavComposer.tsx |
| F-24 | 无权限 | 无 manage_menu | 整块替换为只读提示 | — | ❌ | WorkspaceSettingsPage.tsx |

---

## 6. E · 表格与视图

### 6.1 单元格

| ID | 交互 | 触发 | 处理逻辑 | 边界 / 异常 | 覆盖 | 位置 |
|---|---|---|---|---|---|---|
| G-01 | 单击选中 | td click | 设 active + 焦点给滚动容器 | 只读用户也能选中；焦点被抢走 | ⚠️ | GridView.tsx |
| G-02 | checkbox 翻转 | td click（checkbox 列） | 取反后 PATCH，`checkInflightRef` 防连点 | 无乐观更新；失败不回滚 | ⚠️ | GridView.tsx |
| G-03 | 双击进入编辑 | dblclick | 先判 `canEditData`，再排除 10 类只读类型 | 只读用户**静默无反馈**；richText 落入纯文本框会丢 HTML | ⚠️ | GridView.tsx |
| G-04 | Enter 进入编辑 | keydown | 不校验字段是否只读 → 计算字段会进入空白编辑 | 只能 Esc 退出 | ❌ | GridView.tsx |
| G-05 | 文本编辑 | 编辑态 | Enter 提交下移 / Tab 提交右移 / Esc 取消 / blur 提交；`isComposing` 保护 | **无格式与 maxLength 校验** | ❌ | CellEditor.tsx |
| G-06 | 长文本编辑 | 编辑态 | ⌘Enter 提交，普通 Enter 换行 | 行高 32 时 textarea 极窄；编辑层不溢出单元格 | ❌ | CellEditor.tsx |
| G-07 | 数字编辑 | 编辑态 | 空串→null；`NaN` **原样提交脏字符串** | 不校验 precision | ❌ | CellEditor.tsx |
| G-08 | 单选编辑 | 编辑态 | Popover 选 id；「清除」→null；**点空白 = 放弃** | 无新建选项、无键盘上下选 | ⚠️ | CellEditor.tsx |
| G-09 | 多选编辑 | 编辑态 | 本地 Set，**点空白 = 提交** | 与单选语义相反 | ❌ | CellEditor.tsx |
| G-10 | 日期编辑 | 编辑态 | 原生 `date` / `datetime-local`，blur 提交 | 各浏览器样式不一；无日期选择器组件 | ❌ | CellEditor.tsx |
| G-11 | 评分编辑 | 编辑态 | 点第 i 星；点同一星清零 | 无 blur 提交；无键盘左右 | ❌ | CellEditor.tsx |
| G-12 | 关联编辑 | 编辑态 | 服务端搜索（limit 50 + 250ms 防抖）+ 字段级筛选 + 临时筛选；已选回显置顶 | 候选满 50 提示「请缩小范围」；无「加载更多」 | ❌ | CellEditor.tsx |
| G-13 | **附件编辑** | 编辑态 | `FileReader` → **base64 存进 JSON**；单文件 ≤2MB、单格 ≤20 个 | 超限**部分成功**并 toast 列出文件名；抽屉/表单不支持上传 | ❌ | CellEditor.tsx |
| G-14 | 提交写库 | onCommit | PATCH record；成功 toast「已保存」 | **无乐观更新、失败不回滚、无冲突检测（后写覆盖）、无重试** | ❌ | GridView.tsx |
| G-15 | 提交后光标移动 | move 参数 | down / right / none | — | ❌ | GridView.tsx |
| G-16 | 编辑层容器 | editing 命中 | `absolute inset-0 z-30`，阻止冒泡到行 | — | ✅ | GridRow.tsx |
| G-17 | 只读/计算字段 | 渲染 | 10 类弱化显示 + 拦截编辑 | tabs 不渲染；subtable 落 default 分支 | ⚠️ | CellRenderer.tsx |
| G-18 | 方向键移动 active | keydown | 索引 ±1 夹在边界 | **移动后不 scrollIntoView**；虚拟滚动未渲染行无法到达 | ❌ | GridView.tsx |
| G-19 | Esc 清除选中 | keydown | `setActive(null)` | 各编辑器 Esc 语义不统一（取消 vs 提交） | ❌ | GridView.tsx |
| G-20 | Tab / Shift+Tab | keydown | **未实现** | 非编辑态 Tab 会跳出表格；与编辑态行为割裂 | ❌ | GridView.tsx |
| G-21 | 焦点入口 | 点击 | 容器 `tabIndex=0` + `outline-none` | 移除了焦点可见性；全表零 ARIA | ❌ | GridView.tsx |
| G-22 | 行勾选 | 行首 checkbox | Set 增删；**跨分页保持** | 无 Shift 连选、无表头全选（`toggleAll` 未接线） | ⚠️ | GridRow.tsx |
| G-23 | 批量态工具栏替换 | 选中数 >0 | 整条替换为「N 行已选 + 批量修改 + 删除 + 取消」 | **替换而非叠加**，选中期间筛选/分组/排序全部不可达 | ✅ | GridToolbar.tsx |
| G-24 | 批量删除 | 点删除 | `bulkDeleteRecords` → toast | **无二次确认、无条数上限、失败不 catch** | ⚠️ | GridView.tsx |
| G-25 | 批量修改字段 | 点按钮 | 选字段 + 新值 | 只支持 1 个字段；无类型校验、无权限校验、无进度 | ⚠️ | GridView.tsx |
| G-26 | **行空白点击开抽屉** | tr click | 排除 button/input/a/`[data-cell-content]` | **全仓无 `data-cell-content` 属性** → 点单元格文本会同时选中并打开抽屉 | ⚠️ | GridRow.tsx |
| G-27 | 展开按钮开抽屉 | 点按钮 | 打开抽屉 | 规格写 hover 出现，实现为常驻 | ⚠️ | GridRow.tsx |
| G-28 | 行视觉叠加 | 渲染 | 斑马纹 → 选中底 → hover → 行色条 | 选中态与行色条共用同一条 3px，选中时无 accent 竖条 | ⚠️ | GridRow.tsx |
| G-29 | 行号 | 渲染 | **空占位 span**，无数字 | 04 §4 已要求补行号，实现未做 | 🔧 | GridRow.tsx |
| G-30 | 行拖拽排序 | — | **未实现**（无 moveRecord API） | 若新设计要含此交互，属从零新建 | ❌ | — |
| G-31 | 列宽拖拽 | 表头右缘热区 | mouse 事件累加增量，最小 60 | **只存 useState 不写回 config**；纯 mouse，触屏不可用 | ✅ | GridHeaderCell.tsx |
| G-32 | 默认列宽 | 渲染 | 按类型 80/200/220/160/140/120 | — | ✅ | GridView.tsx |
| G-33 | 字段菜单 | 表头 chevron | 排序 / 取消排序 / 隐藏列 / 重命名 / 编辑 / 删除 | 排序为单字段覆盖式；删除字段无确认 | ✅ | GridHeaderCell.tsx |
| G-34 | 隐藏列 | 菜单项 | 写 `hiddenFieldIds` | 隐藏后仍在候选集，可勾回 | ✅ | GridView.tsx |
| G-35 | 列拖拽排序 | — | **未实现**（`fieldOrder` 零引用、`moveField` 零调用） | 列序完全由服务端决定 | ❌ | — |
| G-36 | 列冻结 | 渲染 | 仅主字段 + 行首列 sticky | 用户不可配置 | ⚠️ | GridView.tsx |
| G-37 | 右键菜单 | — | **未实现**（全仓无 onContextMenu） | 05 §5 有规范但 Grid 未接线 | ⚠️ | — |
| G-38 | 复制/粘贴 | — | **未实现**（无 clipboard、无区域选择） | 无法跨格填充、无法从 Excel 粘贴 | ❌ | — |

### 6.2 工具栏与面板

| ID | 交互 | 触发 | 处理逻辑 | 边界 / 异常 | 覆盖 | 位置 |
|---|---|---|---|---|---|---|
| G-39 | 新建记录 | 主按钮 | 建空草稿（跳过创建期必填） | 不自动滚动定位、不进入编辑 | ✅ | GridToolbar.tsx |
| G-40 | 行高切换 | 按钮 | 三档 32/44/64 | 影响分组/聚合栏布局 | ✅ | GridToolbar.tsx |
| G-41 | 字段显隐面板 | 按钮 | 新建字段 + Checkbox 列表 + hover 齿轮 | 勾选即发 PATCH（无防抖）；无搜索/全选 | ✅ | GridToolbar.tsx |
| G-42 | 视图内搜索 | 输入 | 300ms 防抖 → 写 config | 无清空按钮、无 loading；降级时无提示 | ✅ | GridToolbar.tsx |
| G-43 | 筛选面板 | 按钮 | and/or 组 + 条件行 + 自定义/匹配字段双模式 + 实时「匹配 N 条」 | **嵌套组无法切成 OR**；无空值校验 | ⚠️ | FilterPanel.tsx |
| G-44 | 筛选计数徽标 | 渲染 | 递归数 condition 节点 | `filters` 为 `{}` 时也亮 | ✅ | GridToolbar.tsx |
| G-45 | 分组面板 | 按钮 | 白名单类型；「清除分组」 | 分组后关闭虚拟滚动；降级时非物理字段 disabled | ⚠️ | GroupPanel.tsx |
| G-46 | 排序面板 | 按钮 | 每字段一对 ↑↓；同向再点=移除 | **与表头菜单单字段替换行为不一致**；无字段搜索 | ⚠️ | GridToolbar.tsx |
| G-47 | 行颜色面板 | 按钮 | 三模式（无 / 按选择 / 按条件） | 无保存按钮，每次改动全量覆写 PATCH | ⚠️ | RowColorPanel.tsx |
| G-48 | 更多菜单 | 按钮 | CSV 导入 / 导出 / 复制视图 / 清空表 | 图标仍是 download，与 04 §2 的「应统一为 ⋯」修正点未落地 | ✅ | GridToolbar.tsx |
| G-49 | CSV 导出 | 菜单项 | 客户端拼 CSV（含公式注入防护） | **只导已加载页**；文件名固定；无 BOM | ⚠️ | GridView.tsx |
| G-50 | CSV 导入 | 选择文件 | `csvImport({hasHeader:true})` | 无大小/类型限制、无列映射 UI、无进度、无部分失败报告 | ⚠️ | GridView.tsx |
| G-51 | 复制视图 | 菜单项 | `duplicateView` → 失效 | **无 toast、无跳转** | ⚠️ | GridView.tsx |
| G-52 | 清空表 | 菜单项 | `window.confirm` → clearTable | **原生 confirm**；不走回收站 | ⚠️ | GridView.tsx |
| G-53 | 聚合函数选择 | 聚合栏格 | Popover 按类型列函数 + 清除聚合 | 选函数即全量覆写（无防抖） | ✅ | AggregationBar.tsx |
| G-54 | 聚合值格式化 | 渲染 | `toLocaleString` + tabular-nums | 百分比/货币**不带单位** | ⚠️ | AggregationBar.tsx |
| G-55 | 降级提示 | `isComputedInMem` | 行首「聚合·受限」+ 顶部 `role="alert"` 警告条 | 不显示数值也不解释原因 | ✅ | AggregationBar.tsx |
| G-56 | 分组头与折叠 | 渲染 / 点箭头 | 每组一个 tbody，h36；折叠不渲染子行 | 无折叠全部；跨页分组只渲染已加载页 | ✅ | GridView.tsx |
| G-57 | 状态栏计数 | 渲染 | 「共 N 条」+ 筛选后 + 已选 + 视图名 | `total` 取首页响应，续翻后不更新 | ✅ | GridView.tsx |
| G-58 | 分页 / 能力探测 | 挂载 | 首页不带 limit；`supportsKeyset` 判定灰度 | **keyset 关闭时退化为单页 200，无「加载更多」** | ❌ | records-paging-hooks.ts |
| G-59 | 触底自动续翻 | scroll | 距底 <480px 触发 | 提前量固定，不随行高自适应 | ❌ | GridView.tsx |
| G-60 | 加载更多按钮 | click | 居中 secondary，仅 hasNextPage 时渲染 | 与自动续翻并存 | ✅ | GridView.tsx |
| G-61 | **游标失效（400）** | 服务端 400 | 转 `CursorExpiredError` → 回第一页 + toast | 静默丢弃已翻页数据与滚动位置 | ❌ | records-paging-hooks.ts |
| G-62 | 跨页去重 | 合并 | 按 id 去重，保留首次位置 | 编辑后重拉可能行序跳变 | ❌ | records-paging.ts |
| G-63 | 有界预览 | 挂载 | 自动续翻到 10000 条上限并提示「前 N 条预览」 | 上限不可配置 | ❌ | records-paging.ts |
| G-64 | 虚拟滚动 | 渲染 | >300 行启用，缓冲 20/40 | `containerH` **只在 loading 变化时测一次**，resize/切行高后不更新 | ✅ | GridView.tsx |
| G-65 | 加载态 | isLoading | 居中 Spinner(24) | 无骨架屏；切视图/改筛选都整页 Spinner | ✅ | GridView.tsx |
| G-66 | 空表态 | 无记录 | EmptyState「暂无记录」 | **无操作按钮**；「无数据」与「筛选无匹配」共用文案 | ⚠️ | GridView.tsx |
| G-67 | 视图配置写回 | 配置变更 | 本地乐观更新 + PATCH | **失败不回滚**；并发互相覆盖；无保存中/已保存态 | ❌ | GridView.tsx |
| G-68 | 切视图重置 | view.id 变化 | 重置本地配置态 | 列宽不重置；selection 跨视图保留（可能选中非本视图行） | ❌ | GridView.tsx |

### 6.3 记录抽屉与其余视图

| ID | 交互 | 触发 | 处理逻辑 | 边界 / 异常 | 覆盖 | 位置 |
|---|---|---|---|---|---|---|
| G-69 | 抽屉打开（同表） | 行空白 / 展开 / links 胶囊 / `?record=` | 写 URL `?record=`（replace 不堆历史） | 刷新保持打开；URL 可分享 | ⚠️ | ViewRouter.tsx |
| G-70 | 跨表打开 | links 指向他表 | `sessionStorage["gx-pending-record"]` → 跳转 → 目标表读取 | JSON 解析失败静默；不带 viewId → 落默认视图 | ❌ | ViewRouter.tsx |
| G-71 | 抽屉关闭 | Esc / 遮罩 / 按钮 / 删除后 | 清 state + 移除 URL 参数 | **无脏数据拦截**（关闭即 blur 提交，因此也无"未保存"态） | ❌ | RecordDrawer.tsx |
| G-72 | 滑出动画 | open 变化 | 200ms translate-x | 宽度 560 ≠ 04 §9 的 480；无 role/焦点陷阱 | ⚠️ | RecordDrawer.tsx |
| G-73 | 宽度拖拽 | 左缘手柄 | Pointer Events，clamp [340,960]，写 localStorage | 无键盘 resize | ❌ | RecordDrawer.tsx |
| G-74 | 上一条/下一条 | 头部箭头 | 基于**单页 200** 列表求 idx | 超 200 条后按钮全 disabled；顺序与当前视图不一致 | ❌ | RecordDrawer.tsx |
| G-75 | 字段内联编辑 | 点字段值 | `FieldInput` + blur 提交；JSON 相等则跳过 | 无保存中/已保存指示；无必填校验 | ⚠️ | DetailLayout.tsx |
| G-76 | 子表格面板 | 渲染 | 内嵌表格 + 添加数据 / 选择数据 / 编辑 / 解除关联 | **>200 条对面表时编辑弹窗永远"加载中…"** | ❌ | DetailLayout.tsx |
| G-77 | 选项卡面板 | 渲染 | tab 切换 + 按 rows/widths 还原布局 | 空 tab 提示；tab 名未配置显示「选项卡 N+1」 | ❌ | DetailLayout.tsx |
| G-78 | 评论面板 | 头部按钮 | 输入 + 发表 + 删除（权限判定） | 无评论权限时**整个输入区不渲染**且无提示 | ❌ | RecordDrawer.tsx |
| G-79 | 删除记录 | 底部按钮 | `deleteRecord` → toast → 关闭 | **无二次确认** | ❌ | RecordDrawer.tsx |
| G-80 | 新建记录 | 底部按钮 | 建草稿 + 打开抽屉 | 无权限时按钮不渲染 | ❌ | ViewRouter.tsx |
| G-81 | 布局编辑入口 | 头部 grid 图标 | 切到 FormDesigner | 无权限校验；编辑中关闭不保存 | ❌ | RecordDrawer.tsx |
| G-82 | 系统信息 | 渲染 | 创建 / 最后修改 / 创建人 | 无最后修改人、无版本号 | ❌ | RecordDrawer.tsx |
| G-83 | 视图切换器 | 触发器 | 列出全部视图，点击 navigate | 触发器在浮层外 → 250ms 抑制防重开 | ❌ | ViewSwitcher.tsx |
| G-84 | 新建视图 | 菜单项 | 类型九宫格 + 名称；**等列表取回再跳转** | 名称空禁用；失败弹窗不关 | ❌ | ViewSwitcher.tsx |
| G-85 | 重命名视图 | 菜单项 | 同名 Modal | 名称未变不保存 | ❌ | ViewSwitcher.tsx |
| G-86 | 删除视图 | 菜单项 | 仅一个时禁用；否则 confirm → 删除 → 跳剩余首个 | 后端也保证至少留一个 | ❌ | ViewSwitcher.tsx |
| G-87 | 视图设置（锁定模式） | 独立入口 | onBlur 改名 + 锁定模式三档 | **locked/personal 在 Grid 侧无任何前端分支** | ❌ | ViewSettingsPanel.tsx |
| G-88 | 看板未配置空态 | 渲染 | 空态 + 单选字段下拉 | 无权限时下拉禁用但无说明 | ❌ | KanbanView.tsx |
| G-89 | 看板卡片拖拽 | DnD | 只支持换列，不支持列内排序 | 无指示线；HTML5 DnD 移动端不可用；失败静默 | ❌ | KanbanView.tsx |
| G-90 | 看板列内新建 | 点添加 | 建带该列值的草稿 → 开抽屉 | — | ❌ | KanbanView.tsx |
| G-91 | 有界/降级提示 | 渲染 | `ResultNotice` + 截断文案 | 两种提示互斥（degraded 优先） | ❌ | KanbanView.tsx |
| G-92 | 日历未配置空态 | 渲染 | 空态 + 日期字段下拉 | — | ❌ | CalendarView.tsx |
| G-93 | 日历月/周/前后/今天 | 控件 | 月 42 格、周 7 格 | **周视图 7 格放进 grid-rows-6 导致错位** | ❌ | CalendarView.tsx |
| G-94 | 日历事件 chip | click | 每格最多 3 条 + `+N` | `+N` 不可点；无拖拽改期、无格内新建 | ❌ | CalendarView.tsx |
| G-95 | 画廊卡片 | 渲染 | `auto-fill minmax(260px,1fr)`；封面取首个附件 | 附件为 base64 dataURL，无懒加载 | ⚠️ | GalleryView.tsx |
| G-96 | 画廊新建 | 按钮 | 建草稿 → 开抽屉 | 无权限时空态无操作 | ❌ | GalleryView.tsx |
| G-97 | 表单字段生成 | 渲染 | 有 `formFields` 用配置，否则自动按全部非系统字段生成并显示提示条 | 未过滤只读计算字段 | ❌ | FormView.tsx |
| G-98 | 表单提交校验 | 点提交 | 顺序遍历，**只报第一个必填错误**（toast） | **无格式/类型/长度/唯一校验**；无字段级错误态 | ❌ | FormView.tsx |
| G-99 | 提交成功页 | submitted | 空态「提交成功」+「再填一份」 | 无查看记录入口 | ❌ | FormView.tsx |
| G-100 | 表单无权限 | 渲染 | 整页锁 | 只读用户看到整页锁而非只读表单 | ❌ | FormView.tsx |
| G-101 | 详情卡片列表 | 渲染 | 每记录一张卡 + 编辑/删除 | **全量渲染无虚拟滚动**；删除无确认 | ❌ | DetailView.tsx |
| G-102 | 详情齿轮菜单 | 图标 | 编辑表单 / 重置布局 | 重置需 canManageSchema | ❌ | DetailView.tsx |
| G-103 | 详情加载更多 / 新建 | 底部按钮 | 复用 infinite | 无自动触底 | ❌ | DetailView.tsx |

---

## 7. F · 字段与表单设计器

| ID | 交互 | 触发 | 处理逻辑 | 边界 / 异常 | 覆盖 | 位置 |
|---|---|---|---|---|---|---|
| G-104 | 字段编辑器入口 | 表头菜单 / 字段面板 | 打开 FieldEditorSheet | 无 schema 权限时连齿轮都不显示 | ⚠️ | GridView.tsx |
| G-105 | 字段属性编辑 | 选字段 | 名称/提示/必填/唯一/字数/选项/精度/关联/公式/子表/自动编号/默认内容/占比 | **改动需点保存，但布局改动是画布即时态**（两个独立提交） | ❌ | FieldSettingsPanel.tsx |
| F-01~18 | FieldEditorSheet | 见 §8.3 | 28 种类型分 6 组；编辑模式锁类型；系统字段只读 | 提交**无 loading**；失败仅 toast 且不在字段旁 | ❌ | FieldEditorSheet.tsx |
| G-106 | 设计器画布拖放 | drag | 四类落点（row / line / tab / tabLine）+ rAF 合帧 + 落点浅比较 | 从字段库拖入 = 先 createField 后落位；tabs 不可嵌套；HTML5 DnD 移动端不可用 | ❌ | FormDesigner.tsx |
| G-107 | 行内布局 ▲/▼/⇄ | 悬停浮钮 | 并入上行 / 拆独立行 / 与左邻交换 | 一行最多 4 个；宽字段不压缩；移动预览隐藏 | ❌ | FormDesigner.tsx |
| G-108 | 字段复制 / 移除 | 卡片按钮 | 复制配置命名「X 副本」；移除仅从布局删除 | 复制需权限；删除 tabs 容器才物理删字段 | ❌ | FormDesigner.tsx |
| G-109 | 选项卡容器操作 | tab bar | 添加/删除（至少留一个）/改名/删除容器 | 失败仅 toast（布局已本地移除） | ❌ | FormDesigner.tsx |
| G-110 | 设计器保存 | 顶栏按钮 | 两段式：先逐个 tabs 容器 updateField，再 updateView | 任一段失败即中断；全屏模式 Esc 直接关闭不确认 | ❌ | FormDesigner.tsx |
| G-111 | 桌面/移动预览 | Segmented | 三栏 ⇄ 单列 + 底部面板 | 仅为视觉预览，非真实断点响应 | ❌ | FormDesigner.tsx |
| G-112 | Toast 反馈 | 各写操作 | 唯一反馈通道 | 无内联错误、无重试 | ⚠️ | 全局 |
| G-113 | 权限门禁 | 渲染 | `canEditData` / `canManageSchema` 决定禁用或隐藏 | **批量操作不校验 canEditData** | ⚠️ | 全局 |
| G-114 | 移动端/触屏 | — | 列宽拖拽仅 mouse；看板与设计器 DnD 不可用 | 无移动端 Grid 布局 | ❌ | 全局 |

---

## 8. G · 反馈基座（Toast / Modal / 表单 / 上传 / 确认）

### 8.1 Toast

| ID | 交互 | 现状 | 边界 / 异常 | 覆盖 |
|---|---|---|---|---|
| T-01 | 发布订阅 | 模块级单例，无 Context | 无去重、无队列上限 | ⚠️ |
| T-02 | 变体 | 仅 success / error / info 三种 | **无 warning 变体**（`gx-warning` token 已定义）；约 54 处走默认 info | ⚠️ |
| T-03 | 时长 | 固定 3200ms | 不可配置、hover 不延时 | ✅ |
| T-04 | 关闭 | **无关闭按钮、不可点击关闭** | 用户无法主动消除 | ❌ |
| T-05 | 撤销 | **全仓无 action/undo toast** | 删除记录、清空表、批量删除、撤销授权后均无挽回路径 | ❌ |
| T-06 | 位置层级 | 底部居中 `z-[1000]` | — | ✅ |
| T-07 | 无障碍 | **无 `role="status"` / `aria-live`** | 读屏无感（`ResultNotice` 反而有，标准倒挂） | ❌ |
| T-08 | 调用规模 | 257 处调用 / 62 个文件 | 无语义使用规范 | ❌ |

### 8.2 Modal / Popover / Drawer

| ID | 组件 | 现状 | 边界 / 异常 | 覆盖 |
|---|---|---|---|---|
| M-00 | Modal Esc | 无条件 onClose | **不区分未保存改动、不区分提交中** | ⚠️ |
| M-01 | 遮罩点击 | 无条件关闭 | 有 dirty 时直接丢弃 | ⚠️ |
| M-02 | 焦点管理 | **无自动聚焦、无 focus trap、关闭不归还焦点** | 键盘用户 Tab 会跑到背景页 | ❌ |
| M-03 | 滚动锁定 | **全仓 0 处** | 弹窗打开时背景仍可滚 | ❌ |
| M-04 | 层级 | `z-[800]` + portal | — | ✅ |
| M-05 | 尺寸结构 | 默认 480，`max-h-85vh` | **不传 title 时无 header 也无关闭按钮** | ⚠️ |
| M-06 | 入场动画 | **无** | 05 §10 要求 180ms 淡入 + scale | ❌ |
| M-07 | `role="dialog"` / `aria-modal` | **无** | `PersonalCenterDrawer` 反而有，标准不统一 | ❌ |
| M-08 | 二级弹窗层级 | 各自为政 | **`FilterRuleModal` z-[60] 低于父 Modal 800，实测被遮住**；02 §6 无此档位 | ❌ |
| P-00~03 | Popover / ContextMenu | fixed 900 / absolute 40；菜单 220、子菜单 280 | 子菜单无规范 | ⚠️ |
| D-00~05 | Drawer | **5 处自绘**：RecordDrawer z-40、PersonalCenterDrawer z-50（居中 Modal 形态）、VersionHistoryDrawer z-50（无 Esc）、MemberDrawer z-40（无 Esc）、EffectiveDrawer 复用 Modal | 与 02 §6 的 drawer=400 全不符 | ❌ |

### 8.3 表单控件与校验落位

| ID | 控件 | 现状 | 边界 / 异常 | 覆盖 |
|---|---|---|---|---|
| C-00 | Input / Textarea | **无 error 态、无 disabled 视觉** | 05 §3 表格写了 Error/Disabled，实现零落地 | ❌ |
| C-02 | Select | 无 error/disabled；focus 无 2px 外环 | — | ⚠️ |
| C-03 | Button | loading→强制 disabled + spinner；disabled→opacity .5 | — | ✅ |
| C-04 | IconButton | **无 Disabled 样式、无 loading** | — | ❌ |
| C-05 | Checkbox / Switch | Switch **无 disabled 参数** | — | ⚠️ |
| C-08/09 | ColorPicker | **双实现**（ui.tsx 内 12 色 vs 独立 12KB 文件） | — | ❌ |
| F-04 | 字段名必填 | `!!name.trim()` → 禁用保存 | **无长度上限、无重名校验** | ⚠️ |
| F-06 | 字段保存 | mutateAsync → toast → 关闭 | **按钮无 loading**；失败不在字段旁 | ❌ |
| F-09 | 选项编辑 | 添加/改色/删除 | **无重名、无空名、无最少 1 项、无排序** | ❌ |
| F-10/49 | 数值钳制 | 精度 0–8、序号位数 1–10 | **越界静默改写，无提示** | ⚠️ |
| F-12 | 关联字段锁定 | 已配对后锁目标表与关系类型 | 「已锁定」态无视觉规范，仅 disabled + 灰字 | ❌ |
| F-23/25 | 筛选弹窗校验 | 失效字段检测 → 底部红字；单条件行红底 + 行内红字 | **确认按钮永远可点**；无 Esc；层级被父弹窗遮 | ⚠️ |
| F-34 | 公式实时校验 | 5 类错误（括号/花括号/未知字段/未知函数/参数数） | 只显示第一条 + 计数，折叠策略无规范 | ⚠️ |
| F-38 | 复制公式 | `clipboard.writeText().catch(()=>{})` | **失败静默吞掉** | ❌ |
| F-41 | 默认内容净化 | 脏配置静默清空 | 用户填了却没保存也不知道 | ❌ |
| F-45 | 子表格兼容预览 | 同源 / 无同名字段 / 部分匹配（最多列 3 个） | 第三种"影响提示"形态，与另两种不统一 | ❌ |
| F-53 | 视图重命名 | **onBlur 即存** | 无回车提交、无保存按钮 | ❌ |
| F-54 | 锁定模式 | 切换立即提交 | **无 loading、无失败处理、完全静默** | ❌ |
| A-04 | 邀请成员 | 邮箱正则 + 姓名 1–60 + 密码 8–72 | **只有密码有内联提示**，邮箱/姓名无 | ⚠️ |
| A-08 | PAT 表单 | 名称 + 6 scope + 有效期 | 错误在**表单底部一行红字**（非字段下方） | ⚠️ |
| S-01 | 登录/注册 | toast 拦截 | 错误全走 toast，字段旁无提示 | ❌ |
| S-04 | 个人信息 | 按钮上方红字 **+ toast 双份** | 全仓唯一有字段级错误区的表单 | ⚠️ |
| S-06 | 修改密码 | 3 段强度条（弱/中/强） | 强度条是设计系统缺失组件 | ⚠️ |
| S-07 | 头像上传 | 白名单 + 5MB + >1MB 压缩 + **XHR 真实进度** | 全仓唯一达标上传实现；05 无 Progress 规范 | ⚠️ |
| S-08 | 注销账号 | **输入「注销」+ 当前密码**双因子 | 应作为范本 | ✅ |
| S-09 | 删除 Base | **输入名称完全一致** | 应作为范本 | ✅ |

### 8.4 危险操作确认强度矩阵（现状）

| ID | 操作 | 确认机制 | 强度 | 覆盖 |
|---|---|---|---|---|
| X-01 | 批量删除记录 | **无确认** | 最低 | ❌ |
| X-02 | 清空表 | `window.confirm` | 低（原生） | ❌ |
| X-03 | 删除视图（ViewSwitcher） | `window.confirm` | 低 | ❌ |
| X-04 | 删除视图（ViewSettingsPanel） | **仅禁用** | 极低 | ❌ |
| X-05 | 删除单个记录 | **无确认** | 最低 | ❌ |
| X-06 | 回收站彻底删除 | Modal + danger | 中 | ⚠️ |
| X-07 | 删除 Base | 输入名称一致 | 高 | ✅ |
| X-08 | 注销账号 | 输入「注销」+ 密码 | 最高 | ✅ |
| X-09 | 删除菜单容器 | 二选一 radio | 中高 | ⚠️ |
| X-10 | 中断权限继承 | **409 驱动 + 影响面列表 + 豁免说明** | 最高 | ✅ |
| X-11 | 移动实体到分组 | **409 驱动 + 影响面三行** | 高 | ⚠️ |
| X-12/13 | 吊销 PAT / 永不过期 | Modal + danger；取消文案「返回修改」 | 中高 | ✅ |
| X-14 | 撤销文档独立授权 | **无确认** | 最低 | ❌ |
| X-15 | 版本回滚 | Modal + 「自动备份为新版本」 | 中高（可撤销） | ✅ |
| X-16 | 删除文档 | `window.confirm` + 30 天承诺 | 低 | ⚠️ |
| X-17 | 画布/文档未保存关闭 | `window.confirm`（三份不同文案） | 低 | ❌ |
| X-18 | 删除容器（设计器） | `window.confirm` | 低 | ❌ |

---

## 9. H · 认证 / 权限 / 异常

| ID | 分支 | 触发 | 处理逻辑 | 边界 / 异常 | 覆盖 |
|---|---|---|---|---|---|
| A-01/02 | 登录守卫 | — | 仅本地 token，无服务端校验 | 过期 token 先进首页再被 401 打断 | ❌ |
| A-03/05 | 登录/注册校验 | 提交 | toast 拦截 | 无邮箱格式校验（依赖原生）；两套规则 | ⚠️ |
| A-06 | 登录错误文案 | 非 2xx | `err.message` 直出 | **暴露 `API 401: xxx` 英文前缀与后端原文** | ❌ |
| A-07 | 断网 | fetch reject | toast `err.message` | 显示浏览器原生 `Failed to fetch` | ❌ |
| A-09/10 | bootstrap 探针 | 加载中 / 失败 | 加载中＝常规登录页；失败 `console.warn` 静默降级 | 无任何 UI 反馈 | ❌ |
| A-11 | **空库首运行引导** | `initialized===false` | 登录页整体变形（隐藏 tab + 说明卡 + 4 字段 + 新副标题） | 用户以为在注册，实际是自举 owner | ❌ |
| A-12 | 注册入口关闭 | `signupOpen===false` | 隐藏切换、标题降级为静态 | 字段缺失时按开放处理 | ❌ |
| A-14 | bootstrap 错误映射 | 400/401/403/409/429/5xx/status=0 | 六档中文，`status===0` →「网络异常，请检查服务是否已启动」 | **唯一做过网络异常本地化的路径** | ❌ |
| B-01 | 登录后落改密页 | `mustChangePassword` | navigate | — | ⚠️ |
| B-02 | 全局改密守卫 | 闸门 + 非改密页 | 跳 `/change-password` | 白名单只有改密页本身 | ❌ |
| B-04 | 改密校验 | 提交 | 8–72 + 两次一致 | **无新旧相同校验、无强度条**（与抽屉内改密不一致） | ⚠️ |
| B-05 | 改密成功回拉 | 200 | `Auth.me()` 成功后放行 | `me()` 失败则**本地强行置 false 放行**（防锁死），无 UI 解释 | ❌ |
| B-06 | 改密 401 | 当前密码错 | 在自身凭据白名单内 → 不触发全局登出 | 令牌真过期也不登出 | ❌ |
| B-07 | 改密页无出口 | — | 无返回、无退出登录、后退会被弹回 | 困局态完全未设计 | ❌ |
| C-01 | 令牌存储 | setAuth | localStorage `gx-auth` 整份落盘 | 非 httpOnly；无有效期、无刷新令牌 | ❌ |
| C-02 | 请求头 | 每次请求 | **`X-GX-Token`** | 刻意弃用 Bearer（飞牛网关会吞） | ❌ |
| C-03 | **漏改的 Bearer** | 头像上传 / 清嵌入 Key | 仍手写 `Authorization: Bearer` | 网关下 `res.ok=true` + 非 JSON → `res.json()` 抛 SyntaxError，绕过所有 `instanceof ApiError` | ❌ |
| D-01 | 全局 401 | 非白名单 401 | 清 token + **硬导航** | 丢全部状态、无提示、无 returnUrl | ❌ |
| D-02 | 并发 401 风暴 | 同时多个 401 | 模块级标志只处理一次，3s 冷却 | **窗口内后续 401 既不登出也不跳转** | ❌ |
| D-03 | 自身凭据白名单 | 路径正则命中 | 不登出 | `/api/auth/me/avatar` 等均不豁免 | ❌ |
| D-05 | **全局 403** | 任意 403 | **无全局分支**，各页面自理 | 三种风格：toast 原文 / 静默隐藏 / 整块替换 | ❌ |
| D-07 | 5xx | — | `retry:1` 后抛错 | 无统一提示、无重试按钮 | ❌ |
| D-08 | 429 | 限流 | `Retry-After` 已解析 | **只有 PAT 面板用**；无倒计时、无按钮退避 | ⚠️ |
| D-09 | 409 继承确认 | `INHERITANCE_CONFIRM_REQUIRED` | 替换快照重弹同一 Modal 重放 | 用户看到"没点确认怎么又弹一次" | ❌ |
| D-10 | 409 文档保存冲突 | `baseVersion` 落后 | **前端无实现** | 冲突后果未定义 | ❌ |
| D-11 | 400 游标失效 | 分页 400 | 回第一页 | **静默，无 toast** | ❌ |
| D-12 | 200 非 JSON | 网关 `200 invalid token` | `res.json()` 抛 SyntaxError | 非 ApiError，所有分支失效 | ❌ |
| D-13 | 断网/超时 | fetch reject | 无处理 | 无 AbortController、无 timeout、无 online/offline 监听 | ❌ |
| E-01 | 角色→权限矩阵 | role ∈ 五级 | 查表；未知角色降级 viewer | 权限位全来自服务端 | ❌ |
| E-02 | 非 owner 进设置 | `!canManageBase` | **禁用与隐藏混用**（名称禁用、操作列隐藏、删除禁用） | 无统一决策表 | ⚠️ |
| E-03/04 | owner 行 | — | 列表里**隐藏** owner 选项、表格里**禁用** owner 行 | 两处相反 | ❌ |
| E-05 | 权限写入口总门 | `authzManage===true` | 严格判定，加载中按关闭 | fail-closed | ❌ |
| E-06 | 面板只读横幅 | — | 「环境未开放」与「你没权限」两句 | 用户无法区分 | ❌ |
| E-08 | 资源类型不支持 | kind ∉ {table,base} | Checkbox **禁用** + 灰字 | 与 E-09（隐藏）策略相反 | ⚠️ |
| E-09 | 非继承型资源 | 非 doc/canvas | `return null`（**隐藏**） | — | ❌ |
| E-11 | 面包屑失败 | 请求失败 | 不渲染、不猜祖先；截断时显示「上级受限」pill | — | ⚠️ |
| E-12 | 策略加载失败 | isError | 整面板降级一句话 | **403 与网络错误共一句**；无重试 | ❌ |
| E-16 | 悬挂主体 | `subjectName===null` | 显示「已删除主体」 | 行仍可删除（悬空清理路径） | ❌ |
| E-17 | 字段三态 | fieldMask | hidden / readonly / editable | 授权层隐藏 ≠ UI 列显隐 | ❌ |
| E-18/19 | 检索面 / MCP/PAT 门控 | owner / enterpriseOrg | **隐藏入口** + URL 直戳回落 | 用户不知道功能存在 | ❌ |
| E-20 | 导航编排无权限 | — | 整块内容**替换** | 第三种处理风格 | ❌ |
| F-02 | 探活中间态 | isLoading | 全屏 Spinner | 无超时兜底，卡住即永久转圈 | ⚠️ |
| G-01~09 | PAT 管理 | — | 一次性明文、三态色、四档错误文案 | **不落 localStorage/URL**；404 中性化 | ❌ |
| H-01 | ErrorBoundary 默认 | 子树抛错 | 卡片 + 重试 + 等宽错误详情 | 重试只清 error 不重置数据，大概率复现 | ❌ |
| H-02/03 | compact / fallback | — | **全仓零使用** | — | ❌ |
| H-05 | 覆盖面 | — | **只包了壳一层** | 单元格/富文本/抽屉无保护 → 单点崩溃整应用白屏 | ❌ |
| H-06 | 错误上报 | — | `console.error` | 无远程上报 | ❌ |
| I-03 | 缓存失效 | 写成功 | 按维度失效 + 反向失效父表 | **无乐观更新、无回滚 UI** | ❌ |
| I-04 | 骨架屏 | — | **全仓不存在**，只有 Spinner（5 种尺寸） | — | ❌ |
| I-05 | 空态 | 数据为空 | **两套组件并存** + authz 第三类内联 dashed 卡 | — | ⚠️ |
| I-07 | 重试 UI | 请求失败 | **无任何业务请求提供重试按钮** | — | ❌ |
| I-08 | 加入 Base | `/join/:token` | 三态机 | err 态直接显示英文 `API 404: ...` | ❌ |
| I-09 | 邀请激活 | `/invite/:token` | 8 位 + 一致校验 → 提交 | **唯一用内联 alert 而非 toast** 的呈现 | ❌ |
| J-01 | 退出登录 | 点击 | 清 store + 跳登录 | **不调用后端登出接口** | ❌ |
| J-03 | 注销账号 | 双因子 | `DELETE /api/auth/me` | 仍是唯一 owner 时只提示不拦截，靠后端报错 | ❌ |

---

## 10. I · 设置 / 通讯录 / 搜索 / ERD / 导入导出

### 10.1 工作区设置

| ID | 交互 | 触发 | 处理逻辑 | 边界 / 异常 | 覆盖 |
|---|---|---|---|---|---|
| C-01 | URL 驱动子页 | 点击 / 直访 | splat → general/contacts/nav/search/mcp/assets；未知回落 general | 与数据库设置的本地 state Tab 不一致 | ⚠️ |
| C-02 | MCP 门禁 | 挂载 | `enterpriseOrg===true` 才渲染 | **loading/失败一律隐藏入口**（不显示"未开放"）；直戳 URL 强制回落 | ❌ |
| C-03 | 检索面 owner 门禁 | 挂载 | 非 owner 隐藏段 + URL 回落 | — | ❌ |
| C-04 | 返回 | 点击 | `navigate(-1)` | 与 SettingsPage 的 `navigate(/base/:id)` 语义不同 | ❌ |
| C-07 | 导航编排门控 | 进入 nav | 无权限 → 整段替换提示（**入口仍在左栏**） | 与 MCP 的「隐藏」策略相反 | ❌ |
| C-09 | 重建索引 | 点击 | 选范围 → 提交 → toast | **403 静默**；409 不在弹窗内报错 | ❌ |
| C-10 | 语义检索未启用空态 | 404/NOT_FOUND | 整面板替换为虚线框 + 自助指引 | 「未启用」vs「故障」两态区分，文档无 | ❌ |
| C-11 | 云端模式二次确认 | 选 cloud | 先弹数据出域确认（409 `NEED_CLOUD_CONFIRM` 时重弹） | — | ❌ |
| C-13 | 密钥轮换/清除 | 点击 | 轮换需先输入；清除 Modal 确认 | 只回显 maskedLast4，**绝不显示明文** | ❌ |
| C-14 | 覆盖度轮询 | 挂载 | 重建中 5s，否则 30s；回前台立即刷新 | 403/404 不重试 | ❌ |
| C-15 | 覆盖度 A–F 展示 | 渲染 | 6 项，0 绿点、非 0 按 blocking 分红/黄 | — | ❌ |
| C-16 | 重建范围选择 | 点击 | 单选 all/record/doc/canvas | busy 时**取消按钮也禁用** | ❌ |
| G-06 | 重建索引（旧壳入口） | 点击 | 同上 | 403 静默 | ❌ |
| G-05 | 资产列表 | 进入 | 数据库 / 知识库两段 | — | ⚠️ |

### 10.2 通讯录与成员

| ID | 交互 | 触发 | 处理逻辑 | 边界 / 异常 | 覆盖 |
|---|---|---|---|---|---|
| A-01 | 整页加载占位 | 挂载 | 权限信号未就绪时不渲染任何写按钮（防闪现） | — | ⚠️ |
| A-02 | 三栏 ⇄ Tab | resize ≥1024 | 宽屏三栏；窄屏两 Tab | 无断点降级定义 | ❌ |
| A-03 | 三枚组织动作门控 | 权限 | 无权限时**按钮不渲染**（非置灰） | — | ❌ |
| A-04 | 部门树默认全展开 | 首次数据 | `expanded` 回落全部 id | 用户手动折叠后不再回落 | ❌ |
| A-08 | 部门 ⋯（hover 显形） | hover | 新建子部门/重命名/移动/删除 | 非管理员完全不渲染 | ⚠️ |
| A-10 | 重命名部门 | 菜单 | 1–60 校验 | **无重名预检，靠后端报错** | ❌ |
| A-11 | 移动部门 | 菜单 | 排除自身+子孙；`wouldFormCycle` → 主按钮 disabled + 红字 | — | ❌ |
| A-12 | 删除部门 | 菜单 | 409（仍有子部门/成员）→ 展示后端文案引导 | 无「级联/迁移」选项设计 | ❌ |
| A-13 | 部门加载失败 | isError | 整栏红字 | **无重试按钮** | ❌ |
| A-14 | 成员搜索防抖 | 输入 | 300ms | — | ⚠️ |
| A-16 | 状态分段筛选 | 点击 | 全部/在职/待激活/已停用；徽章文字+圆点双表意 | 与 05 §6 SegmentedControl 不符（手绘） | ⚠️ |
| A-18 | 虚拟滚动 | 滚动 | ROW_H=52，OVERSCAN=8 | — | ❌ |
| A-19 | 触底续拉 | 每次渲染（**无依赖数组**） | 距底 <ROW_H*6 触发 | **无「已到底」提示** | ❌ |
| A-20 | 过滤变更回顶 | filter 变化 | `scrollTo(0)` | — | ❌ |
| A-21 | 加载中/空态 | — | Spinner / EmptyState | **无 isError 分支**，失败静默落到空态 | ⚠️ |
| A-27 | **邀请链接一次性结果视图** | 点生成 | 弹窗切换为结果态 + toast；footer 变单个「完成」 | **关闭即焚，无再查看入口** | ❌ |
| A-28 | 复制链接 | 点击 | clipboard；失败 toast「请手动选择链接复制」 | — | ❌ |
| A-31 | 部门归属勾选 | 点击 | 首个勾选自动设主 | **`checked.size===0` 可提交，无主部门守卫** | ❌ |
| A-33 | 有效角色来源清单 | 抽屉打开 | 列出角色 + sources（直接/经部门继承） | 部门名查不到回落 `id.slice(0,8)` | ❌ |
| A-34 | **停用账号** | 点击 | ConfirmDanger → 停用 → toast | 后端守卫：自停用 400、最后 owner 409；**前端无预判，无禁用态** | ❌ |
| A-37 | 切换成员 | selectedId 变化 | 重置编辑态 | **未保存改动静默丢弃，无确认** | ❌ |
| A-41 | 删除角色 | 点击 | 409 悬挂 → toast 原文 | **后端支持 `reassignTo` 迁移授予，前端未用** | ❌ |
| A-42 | 移除授予对象 | 点 × | 整集 PUT 替换 | **无二次确认、无 loading** | ❌ |
| A-43 | 添加授予对象 | 点击 | SubjectPicker 双 Tab | **成员候选只有首屏 100 条，无远程搜索/分页** | ❌ |
| A-46 | **操作审计日志** | — | **功能不存在**（后端只有 MCP 文件审计） | 需确认是否纳入本轮 | ❌ |

### 10.3 数据库设置 / 回收站 / 个人中心

| ID | 交互 | 触发 | 处理逻辑 | 边界 / 异常 | 覆盖 |
|---|---|---|---|---|---|
| B-01 | 左二级 Tab | 点击 | 本地 state（**不进 URL**） | 与 C-01 的 URL 驱动不一致 | ⚠️ |
| B-02 | Hash 直达 | `#share` | 初始取 hash，不在列表内回落 | **切 Tab 不回写 hash** | ❌ |
| B-03 | 返回 | 点击 | `navigate(/base/:id)` | 与 C-04 的 `navigate(-1)` 不一致 | ❌ |
| B-06 | 改库名/图标色 | 保存 | `updateBase` | **名称为空可提交**；加载后 useEffect 覆盖本地编辑态 | ⚠️ |
| B-07 | **数据表行操作** | 点复制/清空/删除 | 直接执行 | **清空与删除均无二次确认** | ❌ |
| B-10 | 成员列表 | 进入 | **全量平铺**（无搜索/筛选/分页） | 与通讯录成员列表是**两套并行交互** | ❌ |
| B-11/12 | 改角色 / 移除 | 点击 | updateMember / removeMember | **无自移除/自降级/最后 owner 守卫；移除无确认** | ❌ |
| B-13 | 邀请成员 | 提交 | 仅校验非空，**无邮箱格式校验** | 与 A-25 校验强度不一致 | ❌ |
| B-16 | 创建分享链接 | 点击 | 直连 API（hook 不支持 expiresAt） | 用原生 `datetime-local` | ❌ |
| B-18 | 删除分享链接 | 点击 | 直接删 | **无二次确认** | ❌ |
| B-20 | 回收站恢复 | 点击 | `restoreTrash` | **前端用 canEditData 判定，后端 field/table 要求 canManageSchema** → 有按钮却 403 | ❌ |
| B-21 | 彻底删除 | 点击 | Modal 确认 | **恢复冲突无专属提示**（原位置已删只回 404） | ⚠️ |
| B-22 | **清空回收站** | 点击 | **串行 for 逐条 purge** | **无确认**；中途失败已删部分不可回退 | ❌ |
| B-24 | 个人中心 5 Tab | 点击 | danger 变体用 danger 配色 | **切 Tab 不复位滚动**（注释声称有，代码无） | ⚠️ |
| B-26 | 用户名保存 | 提交 | 3–24 + 字符集正则 | **重名靠后端 409**；存在「第三方账号」占位块（违反 01 §2「不放假占位」） | ❌ |
| B-30 | 注销账号 | 双因子 | `deleteMe` | 提示转让 owner 但**无可操作跳转** | ❌ |

### 10.4 搜索 / ERD / 导入导出

| ID | 交互 | 触发 | 处理逻辑 | 边界 / 异常 | 覆盖 |
|---|---|---|---|---|---|
| E-03 | 打开重置 | open→true | 清空 raw/q/active + 聚焦 | 关闭不清空 | ❌ |
| E-04 | 输入防抖 | 输入 | 280ms | **无请求取消**（全仓无 AbortController） | ⚠️ |
| E-05 | v1 优先 + 404 回退 | 请求 | 先 v1，404 回退旧链 | 非 404 照常抛出；降级对 UI 不可见（有意为之） | ❌ |
| E-07 | 结果分组 | 数据到达 | doc/canvas 在前、record 在后，sticky 组头 | 单组为空则整组不渲染 | ❌ |
| E-08 | 键盘导航 | keydown | ↑↓ 夹紧不循环 + Enter + Esc | **doc 行缺 `data-idx` → 知识库区键盘滚动不生效** | ⚠️ |
| E-10 | 关键词高亮 | 渲染 | `indexOf` **仅高亮首个匹配** | — | ❌ |
| E-11 | 无结果态 | — | 居中文案 | 加载中不显示（防闪烁） | ⚠️ |
| E-12 | 降级状态条 | `data.notice` | 截断 / 降级两条拼接 | 文案刻意中性化 | ❌ |
| E-14 | **最近搜索** | — | **功能不存在** | 无历史、无持久化 | ❌ |
| E-15 | 底部快捷键条 | 常驻 | ↑↓/Enter/Esc | 无 ⌘K 说明、无结果计数 | ❌ |
| F-01 | ERD 加载失败 | — | 纯文本「加载失败」 | 无重试、无详情（01 §5 列为 C 不动） | ❌ |
| F-03 | ERD 圆环布局 | 数据到达 | `radius=clamp(140,320, 90+n*16)` | **表多时节点必然重叠**；不可拖拽、不可保存 | ❌ |
| F-04 | ERD 连线 | 渲染 | 贝塞尔 + 箭头 + 字段名 | 不可点击、无 hover 高亮、`relationKind` 未渲染 | ❌ |
| F-07 | ERD 缩放 | — | `viewBox` + overflow-auto | **无 zoom 控件** | ❌ |
| G-02 | CSV 导出（客户端） | 菜单 | Blob 下载 `export.csv` | 只导已加载页；无 BOM；无 try/catch | ⚠️ |
| G-04 | CSV 导出（服务端） | 菜单 | `window.open(export.csv?viewId=)` | **与 G-02 产出口径不一致** | ❌ |
| G-03/05 | CSV 导入 | 选文件 | `hasHeader` 硬编码 true，**`mapping` 参数前端零传** | 无大小/类型限制、无预览、无进度、无行级错误报告 | ⚠️ |
| G-07 | **导入导出向导** | — | **功能不存在** | 03 §3 画的 L2「导入/导出/分享」是纯新增 | ❌ |

---

## 11. J · 知识库

### 11.1 外壳部分（要重设计）

| ID | 交互 | 触发 | 处理逻辑 | 边界 / 异常 | 覆盖 |
|---|---|---|---|---|---|
| SH-01 | 库切换 | 点击 | LibrarySwitcher | `kbId` 为空时 active.id=null | ❌ |
| SH-02 | 全局搜索入口 | 点击 / ⌘K | SearchDialog | 与顶栏入口重复 | ⚠️ |
| SH-03 | 「全部内容」导航 | 点击 | navigate | **active 用 `includes('/trash')` 导致文档页也高亮** | ⚠️ |
| SH-04/05 | 回收站 / 设置导航 | 点击 | navigate | 03 §2.3 只定义了工作区级，KB 级入口 L2 化后无落点 | ⚠️ |
| SH-07 | 侧栏选中态 | 路由 | 左 3px 竖条 + accent 底 | — | ⚠️ |
| SH-08 | **知识库级 ⋯** | — | **不存在**（`useUpdateKb`/`useDeleteKb` 定义后零调用） | 03 §2.2 已承诺，属「设计画了、代码没有」 | 🔧 |
| SH-10 | 文档/画布 Tab | 点击 | 写 `localStorage['gx-kb-tab-'+kbId]` | 值损坏回退 doc | ⚠️ |
| SH-11/12/13 | 新建文档/子文档/画布 | 点 + | 创建后**立即进入内联重命名态** | pending 时静默 return | ⚠️ |
| SH-14 | 展开/收起 | 点 chevron | 持久化 `localStorage['gx-kb-collapsed-'+kbId]` | 无子节点时渲染占位空 span | ⚠️ |
| SH-16 | **hover 才出现的 ⋯** | hover | `opacity:0→1` | **触屏/键盘不可达**，与 03 §3「竖向三点常驻」冲突 | 🔧 |
| SH-17 | 节点操作菜单 | 点 ⋯ | fixed portal Popover | 缺「移动」「分享」（03 §2.2 承诺了） | ⚠️ |
| SH-18 | 内联重命名 | 菜单 / 新建后 | Enter 提交（触发 blur）、Esc 丢弃、失焦提交 | 空值直接退出；**无重名校验** | ⚠️ |
| SH-19 | 删除（软删） | 菜单 | `window.confirm` + 30 天承诺 | 删的是当前文档则跳回首页 | ⚠️ |
| SH-20/22 | **拖拽重挂父级** | drag | 排除自身与后代；落到顶级虚线区 | 03/01 未定义树的拖拽交互 | ❌ |
| SH-21 | 非法落点 | drop | toast「无法移动：不能将文档放到它自己或它的子级中」 | — | ❌ |
| SH-24 | 移动成功/失败 | drop | invalidate + toast | **无同层排序能力** | ❌ |
| SH-25 | 树右键菜单 | — | **不存在** | 05 §5 有规范但未接线 | ❌ |
| SH-26 | 深层嵌套 | 渲染 | 递归，缩进 `8+depth*14` | **无深度上限、无虚拟滚动**，超深树标签被压到不可读 | ❌ |
| SH-27 | 权限门控 | 渲染 | `canEdit` 为假时按钮/⋯/拖拽全部**不渲染** | `kb` 未加载时 role 缺省 owner → **首帧可能错误显示编辑入口** | ❌ |
| SH-28 | 加载中/空态 | — | 加载中文案 / 「暂无文档」「暂无画布」 | **无加载失败态** | ⚠️ |
| SH-30~36 | 编辑器顶栏 | 返回/标题/保存/分享/版本 | 标题空值回落「未命名文档」 | 403/401→「没有访问权限」；404→「不存在」 | ✅ |
| SH-33 | **保存状态** | 被动 | 三态：saving / saved / unsaved | **无 failed 独立态**（失败折叠进 unsaved，用户分不清） | ⚠️ |
| SH-37 | **草稿恢复条** | 加载检测 | 黄条 + 恢复/丢弃 | 设计稿无它的位置 | ❌ |
| SH-39 | 面包屑 | — | **不存在** | 深层子文档无法回溯 | ❌ |
| SH-40 | 顶栏加载中 | 路由进入 | 全屏 Spinner | 顶栏不出现 | ❌ |
| SH-41 | 访问错误态 | isError | 三类分文案 + 重试（403/404 不给重试） | — | ❌ |
| SH-42 | 画布顶栏 | 路由 | 与文档顶栏**逐字重复** | 未合并 | ⚠️ |
| SH-43 | 顶栏溢出 | 窄屏 | 无折叠策略 | 6 元素可能溢出 | ❌ |
| SH-52 | 首页搜索 | 输入 | 250ms 防抖，服务端全文 | 无清除按钮、无搜索中指示 | ⚠️ |
| SH-53 | 类型筛选 | Segmented | 与搜索词叠加 | **不写入 URL，刷新丢失** | ⚠️ |
| SH-55/56/57 | 首页行 ⋯ | 点击 | 重命名/独立权限/删除 | 与树的 `window.confirm` **交互不一致** | ⚠️ |
| SH-58 | 独立权限 | 菜单 | DocAclModal / DocPolicyView 双通道 | 空邮箱禁用；**撤销无二次确认** | ❌ |
| SH-60/61 | 新建知识库 / 卡片进入 | 点击 | `createKb` | 无重名校验 | ❌ |
| SH-62/63 | 回收站找回/彻底删除 | 点击 | restore / purge | 找回不还原层级关系的前端呈现 | ⚠️ |
| SH-65 | 上传限制配置 | 保存 | 写 localStorage | **只能增不能减**（与默认值取并集，UI 未说明） | ❌ |
| CT-03 | **409 保存冲突** | 服务端 409 | 置 unsaved + 写草稿 + toast「已被他人修改…请刷新后合并」 | **无冲突合并 UI**，只能刷新人工合并 | ❌ |
| CT-04 | 保存失败（非 409） | — | 置 unsaved + 写草稿；**自动保存失败静默** | 用户看到"有未保存更改"但不知是失败 | ❌ |
| CT-05 | 离开拦截 | beforeunload | 写草稿 + keepalive 尽力带走 | 依赖浏览器原生确认，无应用内弹窗 | ❌ |
| CT-80 | 画布加载失败 | — | `setComp` 静默不触发 | **无错误态** | ❌ |
| CT-110 | 分享链接失效 | 进入 | 全屏文案 + 返回 | 无「联系分享者」引导 | ❌ |

### 11.2 内容区（按 01 §5 裁决为 C 级 · 沿用，仅登记）

| 组 | 交互 | 沿用结论 |
|---|---|---|
| CT-01/02/06/07/08 | 自动保存 1200ms 防抖、本地草稿、缓存回写、草稿检测与丢弃 | ➖ 沿用；仅「草稿/失败」的展示需与顶栏规范对齐 |
| CT-10~23 | Markdown 三态切换、斜杠命令、@ 提及、内部链接、⌘S、预览渲染与内链点击、危险协议拦截 | ➖ 沿用 |
| CT-30~62 | WYSIWYG 块输入回写、行首快捷排版、回车分裂、退格合并、撤销重做（cap 100）、行内格式、块类型循环、块上下移、跨块导航、右键菜单（文本/链接/表格/原子块）、原子块选中删除、代码块、表格单元格、折叠块、提示块、锚点复制、内链可达性探测、粘贴锚点 URL | ➖ 沿用 |
| CT-70~76 | DocOutline 生成（1000ms 轮询 + MutationObserver）、点击跳转、滚动高亮联动、层级缩进、hash 锚点闪烁 | ➖ 沿用；但 `topGap=64` 与 `fixed right-5` 硬编码会受新顶栏/新 L2 宽度影响，需同步 |
| CT-80~91 | 画布加载、编辑上抛、⌘S、只读态拦截、节点样式条、节点注释、关联文档、内嵌画布弹窗、版本预览缩放 | ➖ 沿用 |
| CT-100~111 | 分享角色切换、外部链接开关、持链者权限、同步下级、复制链接、存版本、版本预览、回滚、公开分享页树、匿名编辑 | ➖ 沿用 |
| CT-120~122 | MdContent 渲染、单元格内链点击、HTML 消毒 | ➖ 沿用 |

---

## 12. 覆盖度汇总（按主题）

| 主题 | 状态 | 说明 |
|---|---|---|
| 容器尺寸 / 配色 / 圆角 / 字阶 | ✅ 已覆盖 | 02、03、04 三份文档规格完整 |
| 导航激活态 / 禁用态 | ⚠️ 部分 | 有规格，但实现为"accent 底 + 竖条"，与 03 §2.4「白卡 + shadow」不一致 |
| 空态 | ❌ 未覆盖 | 05 无空态规范；代码里有两套 EmptyState 组件 + 第三类内联卡 |
| 加载态 | ⚠️ 部分 | 只有 Spinner，**全仓无骨架屏**；探活/顶栏等处连文案都没有 |
| 错误态 | ❌ 未覆盖 | 只有 ErrorBoundary 一个兜底，且只包壳一层；各页面自行其是 |
| 无权限 / 降级态 | ❌ 未覆盖 | 隐藏 / 禁用 / 整块替换 三种策略混用，无决策表 |
| 网络异常 / 离线 / 超时 | ❌ 未覆盖 | 全站无离线感知；断网显示浏览器原生 `Failed to fetch` |
| 冲突与并发 | ❌ 未覆盖 | 无乐观锁 UI、无冲突合并、后写覆盖 |
| 危险操作确认 | ⚠️ 部分 | 有个别范本（删 Base、注销账号、继承确认），但强度无分级 |
| 表单校验与错误落位 | ❌ 未覆盖 | 基座无 error 态，业务方四种落位各行其是 |
| 键盘与无障碍 | ❌ 未覆盖 | Tab 未实现、虚拟化列表不可达、无 focus trap、无 ARIA、无焦点归还 |
| 移动端 / 触屏 | ❌ 未覆盖 | 列宽与 DnD 仅 mouse；hover-only 操作在触屏完全不可达 |
| 反馈体系 | ⚠️ 部分 | Toast 无 warning/无关闭/无撤销/无 ARIA；三套弹窗体系并存 |
