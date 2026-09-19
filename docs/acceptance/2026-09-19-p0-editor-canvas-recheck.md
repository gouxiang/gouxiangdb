# P0 编辑器/画布五处缺陷复验记录（2026-09-19）

> 来源：`docs/design/2026-09-19-editor-nav-remediation/PLAN.md` §一 P0（⑤①②④a④b）
> 范围：仅前端 `apps/web` + `packages/design-tokens`
> 环境：本地 dev（vite 5173 + api 3001），账号 `test@gx.dev`（owner），Chromium 1440×900

## 一、真机逐条结论（自动化脚本 21/21 通过，脚本已按纪律删除）

| # | 断言 | 证据 |
|---|---|---|
| ⑤ | 画布路由下 L2 停在「画布」tab（`aria-selected=true` 仅一处） | `editor-canvas-05-l2-canvas-tab.png` |
| ⑤ | 当前画布行带 `aria-current="page"`（选中态不再丢） | 同上，行高亮 = P0-②验收画布 |
| ②a | 前置：画布布局已稳定（两次采样一致，排除"沉降误读"） | — |
| ②a | 拖拽中（未松手）卡片 `data-dragging=true` | `editor-canvas-02-drag-follow-during.png` |
| ②a | 拖拽中 plait 几何 `g[plait-data-id]` 与卡片 FO 同步（x 差 1px），几何确实位移 120px（屏幕） | 同上一张：卡片与虚线选区框同址 |
| ②a | 中途帧（第一段位移）也同步 | — |
| ②a | 松手落点与拖拽中一致（无回跳） | `editor-canvas-02-drag-after.png` |
| ②a | 一次 Cmd+Z 回到拖拽起点（整段拖拽 = 一个撤销批次） | — |
| ④b | 抽屉 `z=400`(`gx-z-drawer`)、`parentElement === document.body` | `editor-canvas-04b-version-history.png` |
| ④b | 与画布工具条重叠区 `elementFromPoint` 命中抽屉（工具条不再压住） | 同上 |
| ① | 嵌入块紧贴正文时上下热区都渲染（before top=252/h=6，after top=402/h=6） | `editor-canvas-01-insert-zone.png` |
| ① | 上热区可命中（`elementFromPoint` 命中热区自身），点击后块数 3→4，插入的是可输入空段落 | 同上 |
| ① | 下热区点击后块数 4→5 | — |
| ②b | 文档内嵌画布预览已渲染；在预览里拖拽后 `selection-rectangle` 类残留数 = 0 | `editor-canvas-02b-preview-no-ghost.png` |
| ④a | 二次确认弹窗 `z=860`（`gx-z-modal-nested`），存在于编辑弹窗之上 | `editor-canvas-04a-confirm-above-modal.png` |
| ④a | 二次确认主按钮中心点 `elementFromPoint` = 该按钮本身（可见可点） | 同上 |
| ④a | 点「放弃改动」后画布编辑弹窗关闭（`.gx-z-canvas-modal` 计数归 0） | `editor-canvas-04a-after-discard.png` |

验收夹具（建在「统一测试知识库」，为可复现保留）：
- 画布 `P0-②验收画布`（内容 1:1 复制自既有 `关联插入测试画布`，含 6 张关联卡 + 脑图 + 连线）
- 文档 `P0-①验收文档`（正文段落 / ```js 代码块 / 正文段落）
- 文档 `P0-④验收文档`（正文段落 / ```canvas-embed 内嵌上述画布 / 正文段落）

## 二、数字基线

| 项 | 基线 | 本次 | 结论 |
|---|---|---|---|
| web 单测 | 639 passed / 50 files | **665 passed / 54 files** | 不回落（+26 例 / +4 文件） |
| api 单测 | 2243 passed / 209 files | **2243 passed / 209 files** | 不变 |
| `pnpm -w typecheck` | 七包 Done | **七包 Done** | 不变 |
| web lint | 0 error / 114 warning | 0 error / 114 warning | 无新增 |

## 三、逐处修法摘要

| # | 文件:行 | 改法 |
|---|---|---|
| ⑤ | `features/workspace/SecondaryNav.tsx:83-109,137-139,222` | kbTab 从纯本地 state 改为**路由派生**（canvas/doc 路由反推，手动点 tab 只在当前路由内生效）+ 数据源拉全量（`useKbDocs(kbId,"all")`）tab 本地过滤；`SecondaryNavSections.tsx` 二级行补 `aria-current="page"` |
| ① | `features/kb/wy-zones.ts`（新）+ `WysiwygEditor.tsx:2280-2310` + `kb.css:611-617` | 热区判据从"邻块是否占用型"改为"邻块是否已给可输入空位"：邻块是有内容的普通段落时保留热区（可命中），只有邻块本身是空段落才省；颜色改走 gx 令牌 |
| ② | `canvas/link-drag.ts`（新）+ `GxLinkBlockView.tsx:52-71,141-215` + `canvas/board-guards.ts`（新）+ `DrawnixCanvas.tsx:309-330` | ①拖拽期逐帧写 plait（`withNewBatch` 首帧 + `withMerging` 后续帧，松手补写最后一帧）→ 连线与卡片同步、一次拖拽一个撤销批次；②只读预览板安装 `installPreviewBoardGuards` 整体短路板手势 → 不再产生选区/拖拽残留态 |
| ④a | `packages/design-tokens/src/layout.ts:80-84`、`tailwind.ts:108,127`、`apps/web/src/components/ui.tsx:571-597,634`、`components/feedback.tsx:280-286` | 新增 z 档 `modalNested=860`（`gx-z-modal-nested`），Modal 增 `zClass` 覆写入口，`ConfirmHost` 用它；未调低 `canvasModal(820)` |
| ④b | `features/kb/VersionHistoryDrawer.tsx:128-133,305-312` | 裸 `z-50` → `gx-z-drawer(400)` 令牌 + `createPortal` 到 `document.body` |
