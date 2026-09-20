# 编辑器/画布 + 导航入口 + 丢失功能 + 后台配置 —— 修复计划与实施记录

> 版本：v1.0（2026-09-19 晚）
> 来源：主理人在 192.168.31.167 新部署上实测反馈（附截图：文档内嵌画布出现红色矩形残影）
> 依据：两路只读调研实证，每条带 `文件:行号`
> 优先级口径（主理人定）：**严重回归 > 丢失功能 > 交互层级 > 后台配置**

---

## 一、问题判定总表

### P0 严重回归 / 严重可用性（第一批实施）

| # | 问题 | 判定 | 根因（实证） |
|---|---|---|---|
| ⑤ | 画布编辑时左侧列表跳回文档列表、画布选中态丢失 | **720e09c 引入的真回归** | `SecondaryNav.tsx:83` `kbTab` 是纯本地 state 默认 "doc"，从不与路由同步；`:100` 数据源按 tab 过滤 kind → 在 `/kb/:kbId/canvas/:docId` 时画布行不在列表里 |
| ① | 内容上/下无空行时无法插入 | 基线老缺陷（非回归，`637eb9d` 起未改） | `WysiwygEditor.tsx:2308-2309` 仅当邻块为「占用型」（`needsEmptyPair:151`）或首尾块才渲染插入热区；嵌入块紧邻普通段落时热区被抑制 |
| ② | 拖拽元素残影、连接线不实时跟随 | 真缺陷 | `GxLinkBlockView.tsx:59-71` 拖拽只写本地 `dragVb` 驱动 FO、不写 plait（「松手一次性落库」），plait 连线绑在原 `points` 上全程不动；`CanvasEmbed.tsx:122` 预览是真实可交互 Drawnix（readonly+allowViewInteraction），`DrawnixCanvas.tsx:11-13` 非受控、选区/拖拽态不回灌 → 残留态呈现为"残影" |
| ④a | 嵌入编辑关闭的二次确认弹窗被编辑弹窗遮挡 | 真缺陷 | `ConfirmHost→Modal` 用 `gx-z-modal=800`（`ui.tsx:634`），画布/文档编辑弹窗 `gx-z-canvas-modal=820`（`CanvasEditModal.tsx:99`、`DocEditModal.tsx:101`） |
| ④b | 画布顶部工具条压住版本历史 | 真缺陷 | `VersionHistoryDrawer.tsx:129` 裸 `z-50`，画布 chrome 固定 75（`kb.css:184-188`），且未建堆叠上下文 |

### P1 丢失功能（第二批实施）

| # | 问题 | 判定 | 现状 |
|---|---|---|---|
| 5a | 表改名 / 新建数据表 / 删除表 | **真丢失** | 仅存在于旧壳 `Sidebar.tsx:50/62/97`（行菜单 :190-204）；新壳 L2 表行 `SecondaryNavSections.tsx:160-226` 是纯导航行，`RowMoreMenu` 已停用 |
| 5b | 可视化布局（表单设计器） | 挪位难达 | `DetailView.tsx:149-156` 齿轮菜单「编辑表单」+ `?design=1`，需先有 detail 视图 |
| 5c | 复制表 / 清空数据 / 编辑表单 | 真丢失 | 同 5a，旧壳专属 |
| 6 | KB 拖拽文档到另一文档下成为下一级 | **能力在代码、入口不可达**（死代码） | `KbTree.tsx:72-73/225-233` 有完整 dnd + `moveDoc({parentId})`，但 KbTree 只被旧壳 KbSidebar 使用 |
| 7 | 其余旧版入口 | 见下方盘点清单 | |

**旧版有、新版不可达的完整盘点**（第 7 条）：
- `Sidebar.tsx`：重命名 / 编辑表单 / 复制表（含数据·不含数据）/ 清空数据 / 删除 / 图标颜色 / 「+ 新建数据表」
- `TopBar.tsx:167`：删除表
- `KbTree.tsx`：拖拽改层级 + 文档重命名 / 删除
- `KbSidebar.tsx`：库切换器与知识库新建（已被 L1 的 NavLibraryBlock 覆盖，不丢）
- 第三批 `720e09c` 有意删除：`NavComposer`、三视角、「收纳到导航」、「移动到分组…」、`/workspace/settings/nav`、FooterNav 第四项（**属编排下线，非丢失，不恢复**）

### P2 交互层级（第三批实施）

| # | 问题 | 判定 |
|---|---|---|
| ③ | 循环嵌套：文档↔画布互嵌 + 版本历史预览 | **无任何深度/循环守卫**（`depth/visited/cycle/MAX_` 全仓零命中）；靠「内嵌不带 enhance + canEdit:false」隐式约定终止。需加深度上限 + 祖先链检测 + 超限降级为链接卡 |
| 3a | 权限管理并入工作区设置 | FooterNav 第三项 `/workspace/authz` 移入设置分区；FooterNav 变两项 |
| 3b | 通讯录直接展示列表 | 设置页 contacts 分区由「说明+跳转」改为**内嵌成员列表**（ContactsPage 需抽成可复用组件） |
| 3c | 二级菜单顶部返回按钮 | **从未存在，无需修复**（`SecondaryNav.tsx:175-195` 面板头只有 图标+名称+收起） |
| 1 | 新建文档/画布按钮移入 L2 按当前选项卡 | 现在在 KbHomePage:154-171 |
| 2 | 导入导出移到表详情页搜索框右侧 | 现在双入口（TableActionRow:98-101 + GridToolbar「更多」:460-461），收敛到搜索框右侧常驻 |
| 4 | 回收站改 L2 底部入口、进入即展示当前容器 | 现在聚在设置页；列表页按路由参数定容器（`/base/:baseId/trash`、`/kb/:kbId/trash`），L2 可直接带参跳转 |

### P3 后台配置（第四批实施）

| # | 问题 | 判定 |
|---|---|---|
| 8 | 语义检索"硬编码" | 真差距：`searchGate.ts:39-48` **env=off 时后台开关打不开**（override 无效）；且分区 `ownerOnly` 把管理员挡在外面。修法：env 只作初始种子、`app_settings.search.enabled` 为权威（inherit=未设置时按 env）；前端透传三态提示；门控放宽 |
| 9 | MCP 令牌权限 | 现状：新建时勾选 `PAT_SCOPES` 六位子集（独立 scope，不继承签发者）；**无独立权限设置面板**（主理人记忆有误）；**无接入地址展示**。修法：移除 scope 勾选，鉴权改为按签发者用户身份计算能力（token 仅认证 + 有效期）；新增接入方式说明与按 `location.origin` 动态生成的地址 |

---

## 二、实施批次与进度

> 取证方式：`git log --oneline`、`git show --shortstat <hash>`、`git show --stat <hash>`、Grep 关键符号、读源文件。
> 本表所有 hash / 文件数 / 增删行 / 测试数均来自上述命令与 commit message 的**真实输出**，未做任何估算；
> 无证据的数字一律标 `【未实测】`。
> 四个计划批次**均已提交**。文档写作时 HEAD = `9cdc85a`（批次之外另有 2 个追加 commit，见表末两行）。
> 逐条验证方式与丢失入口裁决见 `docs/acceptance/2026-09-20-editor-nav-remediation-report.md`。

| 批次 | 范围 | 状态 | commit | 改动（`git show --shortstat`） | 关键文件 | 实测证据（测试 / 截图 / 复验记录） | 复验数字（出处） | 备注 |
|---|---|---|---|---|---|---|---|---|
| 一（P0） | ⑤①②④a④b | **已完成** | `9a6ef44` | 21 文件 +802/−97 | `SecondaryNav.tsx`、`SecondaryNavSections.tsx`、`WysiwygEditor.tsx`、`wy-zones.ts`（新）、`GxLinkBlockView.tsx`、`link-drag.ts`（新）、`DrawnixCanvas.tsx`、`board-guards.ts`（新）、`ui.tsx`、`feedback.tsx`、`VersionHistoryDrawer.tsx`、`kb.css`、`packages/design-tokens/src/{layout,tailwind}.ts` | `wy-zones.test.ts::zoneFlags：嵌入块紧邻正文时两侧热区必须可命中（P0-①）`；`link-drag.test.ts::syncLinkDragPoints：拖拽期写 plait + 单撤销批次`；`board-guards.test.ts::installPreviewBoardGuards：只读预览一律短路板手势`；`version-history-layer.test.tsx::版本历史抽屉的层级（P0-④b）`；`secondary-nav-render.test.tsx::画布路由下 L2 停在画布 tab`；真机 21/21 断言 + 9 张 `docs/acceptance/screenshots/editor-canvas-*.png` | web 665 passed/54 files（基线 639/50）、api 2243/209、typecheck 七包 Done、lint 0 err/114 warn —— 出处 `docs/_archive/originals/acceptance-2026-09-19-p0-editor-canvas-recheck.md` §二 | 干掉 2 处裸 z 数值改走 `gx-z-*` 令牌；新增 4 个测试文件 |
| 二（P1） | 5a/5b/5c/6 + P2 的 1/2/4 | **已完成** | `a08d96d` | 15 文件 +963/−254 | `SecondaryNavTableOps.tsx`（新）、`SecondaryNavKbOps.tsx`（新）、`SecondaryNav.tsx`、`SecondaryNavSections.tsx`、`TableActionRow.tsx`、`KbHomePage.tsx`、`GridToolbar.tsx`、`GridView.tsx`、`api/hooks.ts` | `secondary-nav-lost-features.test.tsx`（①②③④⑤ 五组共 15 条，含「无权限不渲染」「两页路由已存在不是死链」）；`secondary-nav-render.test.tsx`、`shell-stage1.test.tsx`、`perm-hide-gating.test.ts`、`grid-toolbar-narrow.test.tsx` 同步改断言 | web 665/54 → **681/55**（commit message 记载，改 5 处既有断言均注明原因） | commit subject 写作「第五批」，实际是本计划第二批（措辞不一致，内容对齐 5a/5b/5c/6 + 1/2/4）；顺带修 `duplicateTable` 只失效 `["bases"]` 的缓存洞（补 `["tables"]`）；`TableActionRow.tsx` 净 −127 行 |
| 二-补（P1 位置微调） | 2（导入导出位置） | **已完成** | `d562075` | 3 文件 +13/−12 | `GridToolbar.tsx`、`grid-toolbar-narrow.test.tsx`、`TableActionRow.tsx` | `grid-toolbar-narrow.test.tsx`：顺序断言由「导入/导出在搜索框之前」翻转为「在搜索框之后」（用例名与注释同步） | 【未实测】（该 commit 未记载跑测数字） | 主理人实测后追加：`a08d96d` 落在搜索框**左侧**，本 commit 移到**右侧**。即第 2 条经两轮才落到位 |
| 三（P2） | ③/3a/3b（3c 判定无需修） | **已完成** | `5e97def` | 18 文件 +919/−187 | `embed-depth.ts`（新）、`enhanceEmbeds.ts`、`EmbedDepthFallback.tsx`（新）、`MarkdownEditor.tsx`、`RefEmbedCard.tsx`、`RefEmbedBody.tsx`、`VersionHistoryDrawer.tsx`、`ContactsDirectory.tsx`（新）、`ContactsPage.tsx`、`PermPanel.tsx`、`WorkspaceSettingsPage.tsx`、`lib/nav-footer.ts`、`lib/nav-gate.ts` | `embed-nest-guard.test.tsx`（`planEmbed：环检测优先于深度限制` / `enhanceCanvasEmbeds：按 planEmbed 的结果决定挂载什么` / `降级卡形态：图标 + 标题 + 跳转按钮`）；`workspace-settings-p2b.test.tsx`（B1/B2/B3 三组）；`nav-gate.test.ts` | web **706 passed/57 files**（基线 681/55，+25/+2）；typecheck 七包 Done；lint 0 err/114 warnings 与基线持平 —— 出处 commit message | 环优先于深度（`MAX_EMBED_DEPTH=3`）；顺手修独立 root 缺 Router context 的崩溃（`MemoryRouter`+`NavBridge` 桥接）；3c 判定「从未存在」→ 无对应改动 |
| 四（P3） | 8/9 | **已完成** | `6cec628` | 37 文件 +728/−266 | `searchGate.ts`、`searchGateRuntime.ts`（新）、`routes/v1/index.ts`、`adminSearch.ts`、`search.ts`、`pats.ts`、`mcp/pat/patService.ts`、`mcp/tools/{catalog,registry,record.tools,types}.ts`、`CreatePatForm.tsx`、`PatListPanel.tsx`、`pat-labels.ts`、`search-admin-copy.ts`、`EmbeddingAdminSections.tsx`、`WorkspaceSettingsPage.tsx`、`lib/nav-gate.ts`、`packages/shared-types/src/api.ts` | `apps/api/src/domain/search/__tests__/search-gate-matrix.test.ts::总门判定矩阵（db 覆盖 × env）`（九格 + unset + 「核心回归：env=off 时后台置 on 必须压过 env」）；`PatListPanel.test.tsx`、`pat-labels.test.ts`、`EmbeddingAdminSections.test.tsx`；api `m6-p0a-search-scope.test.ts`、`registry-gate.test.ts`、`m5-search-gate.test.ts`、`m6-s3/s4/s6/s7` 运输层用例 | web **715 passed/58 files**（基线 706/57）；api **2260 passed/212 files**（基线 2243）；typecheck 七包 Done —— 出处 commit message | 总门权威顺序 `app_settings.search.enabled` > env > 默认 off；`/api/v1/search` 与 `/admin` 由启动期静态挂载改为恒挂载 + 请求期 `assertSearchGate`；PAT scope 六位勾选下线，能力按签发者实时计算（`scopes` 保留入库不迁移） |
| 追加（非本计划条目） | 第三批遗留死代码清理 | 已完成 | `9cdc85a` | 1 文件 −35 | `lib/menu-sections.ts`（删 `buildFlyoutRows` / `FlyoutRow` / `FLYOUT_MAX_DEPTH`） | Grep 全仓（含 `*.test.*`）确认零引用后删；commit 记载「715 单测全绿」 | 715 单测全绿（commit 记载，未记载文件数） | `nav-gate.ts` 的 `canSeeNavComposer` **未删**（仍是 `canSeeWorkspaceSettings` 的真实调用方，`nav-gate.test.ts` 有 4 条断言），按纪律保留并备案 |

**合计（区间净变化）**：`git diff --shortstat 9a6ef44~1..HEAD` = **85 文件、+3411/−837**（HEAD = `9cdc85a`，含上表全部 6 个 commit）。
仅四批区间 `9a6ef44~1..6cec628` = 84 文件、+3410/−802。
四个 commit 的文件数之和为 91，比 84 多 7，是因为下列 7 个文件被跨批次二次改动（非笔误）：
`VersionHistoryDrawer.tsx`、`SecondaryNav.tsx`、`SecondaryNavSections.tsx`、`WorkspaceSettingsPage.tsx`、
`WorkspaceSettingsSectionGating.test.tsx`、`lib/nav-gate.ts`、`secondary-nav-render.test.tsx`。

### 二·附：逐批完整改动文件清单（`git show --stat` 原文摘录）

<details>
<summary>批次一 `9a6ef44`（21 文件）</summary>

```
apps/web/src/components/feedback.tsx                          |   4 +
apps/web/src/components/modal-a11y.test.tsx                   |  23 +-
apps/web/src/components/ui.tsx                                |   9 +-
apps/web/src/features/kb/DrawnixCanvas.tsx                    |  48 +-
apps/web/src/features/kb/VersionHistoryDrawer.tsx             |  13 +-
apps/web/src/features/kb/WysiwygEditor.tsx                    |  50 +-
apps/web/src/features/kb/canvas/GxLinkBlockView.tsx           |  60 +-
apps/web/src/features/kb/canvas/board-guards.test.ts          |  91 +++
apps/web/src/features/kb/canvas/board-guards.ts               |  83 +++
apps/web/src/features/kb/canvas/link-drag.test.ts             | 107 +++
apps/web/src/features/kb/canvas/link-drag.ts                  |  67 +++
apps/web/src/features/kb/kb.css                               |   6 +-
apps/web/src/features/kb/version-history-layer.test.tsx       |  63 +++
apps/web/src/features/kb/wy-zones.test.ts                     |  65 +++
apps/web/src/features/kb/wy-zones.ts                          |  66 +++
apps/web/src/features/workspace/SecondaryNav.tsx              |  28 +-
apps/web/src/features/workspace/SecondaryNavSections.tsx      |   2 +
apps/web/src/features/workspace/secondary-nav-render.test.tsx |  57 +-
docs/_archive/originals/acceptance-2026-09-19-p0-editor-canvas-recheck.md        |  51 +++
packages/design-tokens/src/layout.ts                          |   4 +
packages/design-tokens/src/tailwind.ts                        |   2 +
```
</details>

<details>
<summary>批次二 `a08d96d`（15 文件）</summary>

```
apps/web/src/api/hooks.ts                                     |  10 +-
apps/web/src/components/interaction.test.tsx                  |   5 +-
apps/web/src/features/grid/GridToolbar.tsx                    |  14 +-
apps/web/src/features/grid/GridView.tsx                       |  99 +-
apps/web/src/features/grid/grid-toolbar-narrow.test.tsx       |  21 +-
apps/web/src/features/kb/KbHomePage.tsx                       |  39 +-
apps/web/src/features/settings/perm-hide-gating.test.ts       |  17 +-
apps/web/src/features/workspace/SecondaryNav.tsx              | 116 +-
apps/web/src/features/workspace/SecondaryNavKbOps.tsx         | 175 +++
apps/web/src/features/workspace/SecondaryNavSections.tsx      |  57 +-
apps/web/src/features/workspace/SecondaryNavTableOps.tsx      | 245 +++
apps/web/src/features/workspace/TableActionRow.tsx            | 127 ---
apps/web/src/features/workspace/secondary-nav-lost-features.test.tsx | 228 +++
apps/web/src/features/workspace/secondary-nav-render.test.tsx |  26 +-
apps/web/src/features/workspace/shell-stage1.test.tsx         |  38 +-
```
</details>

<details>
<summary>批次二-补 `d562075`（3 文件）</summary>

```
apps/web/src/features/grid/GridToolbar.tsx                    |  13 +-
apps/web/src/features/grid/grid-toolbar-narrow.test.tsx       |  10 +-
apps/web/src/features/workspace/TableActionRow.tsx            |   2 +-
```
</details>

<details>
<summary>批次三 `5e97def`（18 文件）</summary>

```
apps/web/src/features/authz/PermPanel.tsx                     |  11 +-
apps/web/src/features/contacts/ContactsDirectory.tsx          | 141 +++
apps/web/src/features/contacts/ContactsPage.tsx               | 130 ---
apps/web/src/features/kb/EmbedDepthFallback.tsx               |  61 +++
apps/web/src/features/kb/MarkdownEditor.tsx                   |   5 +-
apps/web/src/features/kb/VersionHistoryDrawer.tsx             |  16 ++
apps/web/src/features/kb/__tests__/embed-nest-guard.test.tsx  | 206 +++
apps/web/src/features/kb/canvas/RefEmbedBody.tsx              |  10 +-
apps/web/src/features/kb/canvas/RefEmbedCard.tsx              |  26 +-
apps/web/src/features/kb/embed-depth.ts                       |  85 +++
apps/web/src/features/kb/enhanceEmbeds.ts                     |  88 +-
apps/web/src/features/workspace/WorkspaceSettingsPage.tsx     |  86 +-
apps/web/src/features/workspace/WorkspaceSettingsSectionGating.test.tsx | 28 +-
apps/web/src/features/workspace/__tests__/workspace-settings-p2b.test.tsx | 170 +++
apps/web/src/features/workspace/lib/nav-footer.ts             |   5 +-
apps/web/src/features/workspace/lib/nav-gate.test.ts          |  15 +-
apps/web/src/features/workspace/lib/nav-gate.ts               |  18 +-
apps/web/src/features/workspace/nav-menu-polish.test.tsx      |   5 +-
```
</details>

<details>
<summary>批次四 `6cec628`（37 文件）</summary>

```
apps/api/src/domain/search/__tests__/embedding-remote-config.test.ts   |   7 +-
apps/api/src/domain/search/__tests__/search-gate-matrix.test.ts        |  76 +++
apps/api/src/domain/search/searchGate.ts                               |  28 +-
apps/api/src/domain/search/searchGateRuntime.ts                        |  21 ++
apps/api/src/mcp/pat/patService.ts                                     |  13 +-
apps/api/src/mcp/permissions/types.ts                                  |   4 +
apps/api/src/mcp/tools/__tests__/m6-p0a-search-scope.test.ts           |  86 +-
apps/api/src/mcp/tools/__tests__/registry-gate.test.ts                 |  25 +-
apps/api/src/mcp/tools/catalog.ts                                      |  12 +-
apps/api/src/mcp/tools/record.tools.ts                                 |  34 +-
apps/api/src/mcp/tools/registry.ts                                     |  20 +-
apps/api/src/mcp/tools/types.ts                                        |  12 +-
apps/api/src/mcp/transport/__tests__/m6-s3-gate.test.ts                |  28 +-
apps/api/src/mcp/transport/__tests__/m6-s4-read-tools.test.ts          |  14 +-
apps/api/src/mcp/transport/__tests__/m6-s4-write-tools.test.ts         |  13 +-
apps/api/src/mcp/transport/__tests__/m6-s6-canvas-read.test.ts         |  30 +-
apps/api/src/mcp/transport/__tests__/m6-s7-audit-idempotency.test.ts   |  20 +-
apps/api/src/mcp/transport/authenticate.ts                             |   4 +
apps/api/src/routes/v1/__tests__/m5-search-gate.test.ts                |  79 +-
apps/api/src/routes/v1/adminSearch.ts                                  |  29 +-
apps/api/src/routes/v1/index.ts                                        |  18 +-
apps/api/src/routes/v1/pats.ts                                         |   8 +-
apps/api/src/routes/v1/search.ts                                       |   3 +-
apps/web/src/api/client.ts                                             |   8 +-
apps/web/src/features/search/EmbeddingAdminSections.test.tsx           |  53 +++
apps/web/src/features/search/EmbeddingAdminSections.tsx                |  22 +-
apps/web/src/features/search/search-admin-copy.ts                      |  23 +-
apps/web/src/features/search/search-m5.test.ts                         |   3 +-
apps/web/src/features/settings/CreatePatForm.tsx                       |  74 +-
apps/web/src/features/settings/PatListPanel.test.tsx                   |  57 +-
apps/web/src/features/settings/PatListPanel.tsx                        |  75 +-
apps/web/src/features/settings/pat-labels.test.ts                      |  20 +-
apps/web/src/features/settings/pat-labels.ts                           |  23 +-
apps/web/src/features/workspace/WorkspaceSettingsPage.tsx              |  21 +-
apps/web/src/features/workspace/WorkspaceSettingsSectionGating.test.tsx|  14 ++
apps/web/src/features/workspace/lib/nav-gate.ts                        |   7 +-
packages/shared-types/src/api.ts                                       |  10 +-
```
</details>

<details>
<summary>追加 `9cdc85a`（1 文件）</summary>

```
apps/web/src/features/workspace/lib/menu-sections.ts                   |  35 ---
```
</details>

**备注（Johan / Cockpit）**：任务书要求本表备注含「Johan `\n` 无关 Cockpit 信息」。对 `johan` 与 `cockpit`
两个关键词在 `*.ts`/`*.tsx`/`*.md`/`*.json` 全仓（排除 `node_modules`）做大小写不敏感检索，**零命中**，
`git log` 中亦无相关记录。该条目在本仓库内无可取证来源，记为 **【未实测】**，不在本表任何批次中认领。

---

## 三、验证与输出承诺

- 每批：typecheck 七包 + web/api 测试总数不低于基线 + 真机浏览器逐条点验（截图留证）。
- 全部完成后输出：**变更清单、逐条验证方式、丢失入口排查报告**（本文件 §一 B 即排查报告底稿，收尾时补齐"恢复/不恢复"裁决栏）。

**交付状态（2026-09-20）**：三份产出已落在 `docs/acceptance/2026-09-20-editor-nav-remediation-report.md`
（§一 变更清单 / §二 逐条验证方式 / §三 丢失入口排查报告 + 遗留与未闭环一节）。
同一份报告 §四「遗留与未闭环」列出了 4 项**未真正闭环**的条目，尚未决策，需主理人定夺。
