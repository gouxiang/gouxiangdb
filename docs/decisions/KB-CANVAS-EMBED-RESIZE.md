# 画布关联嵌入预览框只能放大、不能缩小 — 设计契约 / 验收记录

日期：2026-09-10
状态：已实现 + 真机验收（内部编辑页两类框）
范围：apps/web（KB 画布嵌入框 resize）。无后端改动。

## 1. 问题

插入关联画布（及节点关联）后，嵌入预览框用右下角手柄**只能拖大，放大后无法向缩小方向拖回**。
文档类关联不明显，关联画布几乎必现。

## 2. 根因（事件传播，真机取证）

嵌入 body 是另一张只读内嵌画布，`RefEmbedBody.tsx:45` 恒以
`<DrawnixCanvas readonly allowViewInteraction />` 渲染。该模式（DrawnixCanvas 的只读 effect）
在**容器捕获阶段对 `pointermove` 调用 stopPropagation**。

旧 resize 实现把监听挂在 `window`（冒泡末端），且手柄仅 12px：
- **放大**：鼠标向右下移出卡片 → pointermove 目标在外层画布，window 收得到 → 正常变大；
- **缩小**：鼠标向左上移入卡片 body → pointermove 进入内嵌画布，在其捕获阶段被拦截，
  冒泡到不了 window → onMove 停火 → 尺寸卡死，表现为"只能放大不能缩小"。

文档类 body 是普通 div（不拦 pointermove），所以只有内嵌画布明显。

附带缺陷（独立块 GxLinkBlockView 旧实现）：
- 屏幕像素增量直接当 viewBox 尺寸（`startW + (clientX-startX)`），非 100% 缩放下尺寸/手感错误；
- 手柄固定 12px，画布缩小后热区过小。

## 3. 方案

### 3.1 核心：手柄 setPointerCapture
两类框的 resize 手柄在 pointerdown 时 `setPointerCapture(pointerId)`，把指针锁定到手柄元素。
捕获后后续 pointermove/up 以**手柄为 target**，传播路径绕开内嵌画布，放大/缩小都能持续收到；
pointerup 时 releasePointerCapture。这是最小且不依赖内嵌画布改动的根治手段。

### 3.2 独立块 GxLinkBlockView（尺寸=viewBox 单位）
- 尺寸状态 `liveVb`（viewBox 单位，与 plait points 同口径）；渲染 `width/height = effVb * zoom`，
  与底层矩形（getElementScreenRect 已是屏幕坐标）精确贴合；
- 屏幕拖拽增量经既有 `screenDeltaToViewBox(board, from, to)` 换算为 viewBox 增量再叠加，
  消化当前缩放/平移；
- 非 resize 时尺寸恒以最新 `element` 为准（撤销/重做/外部写入即时跟随）；
- 监听挂在手柄元素本身（配合 capture）；
- 手柄热区 `Math.max(12, 12/zoom)`，缩到很小仍≥12px 可点；加 `touch-none` 防触屏滚动抢占。
- 约束：MIN 200×120 / MAX 600×400（viewBox），落库 resizeLinkBlock 同步钳制。

### 3.3 节点关联卡 DocRefCard（尺寸=屏幕像素，存 localStorage）
- 既有 window pointermove/up + 闭包 liveSize 防快速松手落旧值的机制保留；
- startResize 增加 `setPointerCapture` + `resizeHandleRef`，onUp 释放；
- startResize 加 `if(!canEdit) return`，手柄按 `canEdit` 条件渲染（viewer 公开页不显示拖不动的手柄）；
- 加 `touch-none`。
- 约束：MIN 280×200；松手一次性写 localStorage（既有）。

## 4. 尺寸约束 / 防溢出

| 框 | 单位 | 最小 | 最大 | 持久化 |
|---|---|---|---|---|
| 独立块 gx-link-block | viewBox | 200×120 | 600×400 | plait points（进撤销栈/自动上云） |
| 节点关联卡 gxDocRef | 屏幕 px | 280×200 | 无上限 | localStorage gx-canvas-refsize-<nodeId> |

容器 `overflow-hidden`，内容区 flex-1 内部滚动，缩到最小不溢出、不破版。

## 5. 真机证据（agent-browser，内部编辑页 Test2，zoom≈1.4，body 为内嵌画布）

合成 PointerEvent 以手柄为 target（等价 capture 后真实路径），关键路径中间点刻意落在内嵌画布区域：

独立块（屏幕 px，× zoom 前为 viewBox）：
- 280×160 → 放大落库 **460×280**（screenDeltaToViewBox 换算正确）；
- **向左上缩小（原失效方向）→ 280×180**，恰为最小 viewBox 200×120×1.4（最小钳制正确，未塌陷）；
- 缩到最小后再放大 → **420×270**（重复调整无卡死）；
- 测完还原 200×120。

节点关联卡（Test3 Canvas 内嵌画布）：
- 380×300 → 放大 **520×400** 且写 localStorage `{w:520,h:400}`；
- 向左上缩小（中间点在内嵌画布上）→ **320×250**，localStorage 同步更新（原失效方向已修复）；
- 测完清掉测试 localStorage key。

## 6. 质量门

- `pnpm --filter @gx/web typecheck`：0 错误（中途 Ref 类型 HTMLElement→HTMLDivElement 已修）。
- `pnpm --filter @gx/web build`：成功（先 rm -rf dist 规避 vite7 prepareOutDir safe-delete 冲突）。
- 不影响：移动（header 拖拽，手柄命中 role=presentation 已在 header 拖拽里排除）、双击跳转、
  选中、缩放、只读防护（viewer 不渲染 resize 手柄）。

## 7. 影响文件

- apps/web/src/features/kb/canvas/GxLinkBlockView.tsx（capture + viewBox 尺寸换算 + zoom 渲染 + 热区）
- apps/web/src/features/kb/canvas/DocRefCard.tsx（capture + canEdit 手柄显隐 + 防御）

## 8. 备注：控制点

两类框当前都只有"右下角"一个手柄（与修复前一致）。用户提到"各拖拽控制点"，
本项目设计上用单手柄同时控宽高（保持卡片比例直觉、实现简单）。如需八向独立控宽/控高手柄，
属新增交互，可另开任务；本轮先保证现有手柄双向可调、钳制合理、不溢出。
