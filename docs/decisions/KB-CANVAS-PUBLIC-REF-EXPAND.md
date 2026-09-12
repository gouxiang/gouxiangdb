# 画布节点关联在公开分享只读页无法展开 — 设计契约 / 验收记录

日期：2026-09-10
状态：已实现 + 真机验收（viewer 公开分享页 + 内部编辑页回归）
范围：apps/web（KB 画布增强层）。无后端改动。

## 1. 问题

图形节点通过 `gxDocRef` 关联的画布/文档，在**公开分享只读页**（`/s/:token`，viewer / 仅可见）：
- 节点右上角的关联角标可见，但**不可点击、无法展开**；
- 独立插入块（gx-link-block）内容"看得见"但同样不可交互；
- 内部编辑页正常 → 问题只在只读分享页。

## 2. 根因（真机取证，非推测）

`PublicSharePage.tsx` 的 `PublicCanvas` 渲染：
```tsx
<DrawnixCanvas readonly={!canEdit} enhance={{ canEdit, publicToken, currentDocId }} />
// 未传 allowViewInteraction（默认 false）
```
而 `DrawnixCanvas.tsx` 在 `readonly && !allowViewInteraction` 时铺一层：
```tsx
<div className="kb-canvas-readonly-mask" />
```
该遮罩在只读态经 kb.css 提升到 **z-index:780 全屏拦截指针**（`inset:0; cursor:not-allowed`，背景透明）。
我方增强 overlay（节点角标 gx-z-canvas-badge=65、展开卡 gx-z-canvas-card=68）portal 进同一个
`.kb-canvas-wrap`，层级远低于遮罩 → 点击全被遮罩吃掉。遮罩透明，所以内容仍可见但点不到——
与截图"角标存在、点不开"完全吻合。

为什么不能简单传 `allowViewInteraction` 了事：该开关原本的实现（DrawnixCanvas 的只读 effect）
在**容器捕获阶段无差别拦截所有 pointerdown/dblclick/contextmenu/keydown**（为禁止编辑），
而角标/卡片也是 wrap 内后代，会被一起吞掉。文档内嵌入预览（RefEmbedBody）用此开关时
**不带 enhance**、内部没有可点 overlay，所以历史上没暴露这个矛盾。

## 3. 方案（三处改动，最小且分层精确）

1. `canvas/canvas-context.tsx` — `CanvasOverlayLayer` 的 portal 包裹层增加专属标记
   `data-gx-overlay="1"`（保留原有 `.plait-board-attached`）。这是我方增强层的稳定身份，
   不借用 `.plait-board-attached`，以免误放 plait 自带浮动控件。

2. `DrawnixCanvas.tsx`（只读 + allowViewInteraction effect）— 区分事件来源：
   - `pointerdown / dblclick / contextmenu / keydown`：目标落在 `[data-gx-overlay='1']`
     之内则**放行**（角标展开/收起/跳转、卡片内交互、弹窗），否则拦截（禁止画布结构编辑）。
   - `pointermove`：仍全局拦截（无"点击目标"语义，防止只读时悬停触发延伸/连线幽灵预览）。
   - `wheel` 本来就不拦 → 滚轮/触控板缩放平移继续可用。
   判定用 `target instanceof Element && target.closest("[data-gx-overlay='1']")`。

3. `PublicSharePage.tsx`（PublicCanvas）— 只读分享画布显式传 `allowViewInteraction`。
   去掉全屏遮罩，改由第 2 步精确策略：能看（缩放/平移/点角标展开关联）、不能改（画布本体编辑全拦）。

## 4. 多开 / 视觉关联增强

- 节点角标（NodeBadges）新增 `isRefOpen`：对应卡片展开时角标切换为
  蓝实心 + 2px accent 描边高亮，紧贴卡片左缘；多开时每张卡属于哪个节点一眼可辨。
- `CanvasEnhanceOverlay` 用已有的 `openRefNodeIds: Set<string>` 把展开状态传给对应 NodeBadges。
- 卡片定位/收起/多开沿用既有实现（DocRefCard：跟随节点右侧、翻左兜底、× 手动收起、
  节点/关联消失自动关闭），本轮不改其布局算法。

## 5. 行为矩阵（验收基线）

| 场景 | 角标点击 | 卡片展开内容 | × 收起 | 缩放/平移 | 画布结构编辑 |
|---|---|---|---|---|---|
| 内部编辑页 (canEdit) | 可 | 完整（内部 API） | 可 | 可 | 可 |
| 公开 viewer 页 | **可（修复）** | **完整（PublicApi，闭包 /ref/）** | **可** | 可（wheel） | **禁止（拦截）** |
| 公开 editor 页 | 可 | 完整 | 可 | 可 | 可（匿名可编辑） |
| 内嵌预览 RefEmbedBody | 无 enhance | — | — | 可 | 禁止（行为不变） |

## 6. 真机证据（agent-browser，独立匿名会话 /s/:token，viewer/canEdit=false）

- 初始：`data-readonly=1`、遮罩 `mask=false`、角标 1、独立块 6、overlay 标记存在。
- 点角标 → `.gx-z-canvas-card` 出现，标题 "Test3 Canvas"，内嵌 `svg.board-host-svg` 真实渲染
  （跨画布引用，走第五轮 PublicApi `/ref/` 闭包）；卡片定位节点右侧 380×300。
- × 收起 → cards=0；展开态角标 `text-white` 实心高亮 = true（截图确认蓝点紧贴卡片左缘）。
- 只读防护：空白处合成 dblclick 被 preventDefault、无 contenteditable 文字框；拖拽不改结构。
- 临时分享（token r6badge10sep / r6v2）测完已 SQL 还原 shareEnabled=0/shareToken=''。

## 7. 质量门

- `pnpm --filter @gx/web typecheck`：0 错误（中途 Node→Element 收窄已修）。
- `pnpm --filter @gx/web build`：成功（先 rm -rf dist 规避 vite7 prepareOutDir safe-delete 冲突）。
- 内部编辑页走 `readonly=false` 分支，不进入改动的只读 effect，逻辑隔离，无回归面。

## 8. 影响文件

- apps/web/src/features/kb/canvas/canvas-context.tsx（overlay 包裹层加 data-gx-overlay）
- apps/web/src/features/kb/DrawnixCanvas.tsx（只读拦截按 overlay 来源精确放行）
- apps/web/src/features/kb/PublicSharePage.tsx（公开画布传 allowViewInteraction）
- apps/web/src/features/kb/canvas/NodeBadges.tsx（角标 isRefOpen active 高亮）
- apps/web/src/features/kb/canvas/CanvasEnhanceOverlay.tsx（透传展开态）
