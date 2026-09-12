# KB 编辑器第三轮产品问题设计契约（v1.0）

> 日期：2026-09-10
> 状态：**已实现 + 已验收**（4/4 全部落地，含两处第二轮修复）
> 调研：4 个 Explore agent 并行 → 设计契约 → 2 个 general-purpose agent 实现 → 浏览器实测 → 2 处 P0 复修闭环

本契约锁定 4 个产品问题的根因、设计方案、实现要点、验收标准。实现阶段以本文件 + 引用源文件:行号 为唯一依据。

---

## 问题总览

| # | 问题 | 严重度 | 性质 | 预估代码改动 |
|---|------|--------|------|--------------|
| 1 | 缺少 Win/macOS 跨平台快捷键（尤其 Ctrl+S） | 🟠 P1 | 新功能（补齐） | DocEditorPage.tsx + WysiwygEditor.tsx + 新 hook |
| 2 | 锚点链接保存后退化为纯文字 | 🔴 P0 | 单点 bug（序列化丢字段） | blocks.ts 单 case 加 6 行 |
| 3 | 画布"插入关联"应改工具条 + 支持多预览 + 新建 | 🟠 P1 | UX 重做 + 数据模型轻微扩展 | canvas/ 7 文件 + types.ts |
| 4 | 思维导图样式条缺失 | 🔴 P0 | **真实代码 bug**（5 道闸门 + 类型串猜错 + 写操作占位） | canvas/ 5 文件 |

---

## 问题 1：Win/macOS 快捷键适配

### 1.1 根因分析

**调研结论**（Explore Agent 2a097422）：

- `apps/web/src/features/kb/WysiwygEditor.tsx` 全文 **2490 行，零 `metaKey`/`ctrlKey` 修饰键快捷键**（grep 仅命中 `shiftKey`）。
- 现有键盘处理全为"无修饰键"的块编辑导航（Enter/Backspace/方向键/Tab/Esc），且全部走 React `onKeyDown` 绑定在 `.kb-wy-scroll` 容器（WysiwygEditor.tsx:2183）。
- **IME 组词守卫**：用 `e.nativeEvent.isComposing`（WysiwygEditor.tsx:449）+ `e.isComposing`（:824），不是 keyCode 229。这是项目惯例。
- 画布编辑器 `DrawnixCanvas.tsx:223-239` 已经实现了 Ctrl/Cmd+S 的正确范式，可直接复用模式。

**根因**：从未设计"修饰键 + 跨平台"的快捷键体系，所有修饰键组合全部放行给浏览器默认行为 → Win 下 Ctrl+S 弹"另存为"、Ctrl+P 弹打印、Cmd+B/I 原生触发 `<b>/<i>` 但与 `htmlToInlineMd` 期望的 `<strong>/<em>` 序列化冲突。

### 1.2 产品逻辑设计

#### 1.2.1 快捷键总表（Win/macOS 一一映射）

| 动作 | Win | Mac | preventDefault | 现状 → 目标 |
|------|-----|-----|----------------|-------------|
| **云保存** | `Ctrl+S` | `Cmd+S` | **是（必须）** | ❌ 完全未处理 → ✅ 调 `persist.saveNow()` |
| 撤销 | `Ctrl+Z` | `Cmd+Z` | 是（建议） | ⚠ 仅原生（state 不同步风险）→ ✅ 调 `history.undo()` |
| 重做 | `Ctrl+Y` / `Ctrl+Shift+Z` | `Cmd+Shift+Z` | 是（建议） | ⚠ 仅原生 → ✅ 调 `history.redo()` |
| 加粗 | `Ctrl+B` | `Cmd+B` | 是 | ⚠ 原生 `<b>` → ✅ 调 `execInline("bold")` 输出 `<strong>` |
| 斜体 | `Ctrl+I` | `Cmd+I` | 是 | ⚠ 原生 `<i>` → ✅ 调 `execInline("italic")` 输出 `<em>` |
| 删除线 | `Ctrl+Shift+X` | `Cmd+Shift+X` | 是 | ❌ → ✅ 调 `execInline("strikeThrough")` |
| 行内代码 | `Ctrl+E` | `Cmd+E` | 是 | ❌ → ✅ 调 `execInline("insertHTML", <code>)` |
| 查找 | `Ctrl+F` | `Cmd+F` | 否（放行原生） | ⚠ 原生 → ✅ 保持原生（无定制需求） |
| 全选 | `Ctrl+A` | `Cmd+A` | 否（原生） | ✅ 原生可用，无需处理 |
| 复制/剪切/粘贴 | `Ctrl/Cmd+C/X/V` | 同左 | 否（原生） | ✅ 原生（粘贴已有锚点降级逻辑 WysiwygEditor.tsx:2248） |
| 取消选择 | `Esc` | `Esc` | 是 | ✅ 部分（斜杠菜单/原子块）→ ✅ 通用扩展 |
| **块类型循环** | `Ctrl+Alt+N` | `Cmd+Alt+N` | 是 | ❌ → ✅ `patchBlock(id,{type})` 循环 |
| 缩进 | `Tab` | `Tab` | 是 | ⚠ 仅斜杠菜单 → ✅ 列表缩进 |
| 反缩进 | `Shift+Tab` | `Shift+Tab` | 是 | ❌ → ✅ 列表退格 |
| 上移行 | `Alt+↑` | `Option+↑` | 是 | ❌ → ✅ `moveBlock(id, -1)` |
| 下移行 | `Alt+↓` | `Option+↓` | 是 | ❌ → ✅ `moveBlock(id, +1)` |
| 打印 | `Ctrl+P` | `Cmd+P` | 视需求 | ⚠ 原生 → ✅ 保持原生 |
| 全屏 | `F11` / `Ctrl+Cmd+F` | 同左 | 视需求 | ❌ → 可选（MVP 不做） |

#### 1.2.2 关键决策

- **平台无关修饰键**：`const mod = e.metaKey || e.ctrlKey;`（沿用 `DrawnixCanvas.tsx:229` / `KbShell.tsx:17` 既有写法），无需 `navigator.platform` 判断。
- **Win/macOS 差异键位**：仅当组合键不同时（重做 `Ctrl+Y` vs `Cmd+Shift+Z`）做平台映射表；其余同字母键在两端一致。
- **作用域校验**：`editorAreaRef.current.contains(e.target)`（DocEditorPage.tsx:30 已有 editorAreaRef）。焦点在搜索对话框/版本历史/标题输入框时不应劫持。
- **IME 守卫**：首行 `if (e.isComposing) return;`（e.isComposing 兼容 React 的 SyntheticEvent 与原生事件）。
- **Ctrl+K 冲突**：项目已有 `KbShell.tsx:17` 用作全局搜索 → 在编辑器内禁止 Ctrl+K（不 preventDefault）；查找替换改用 `Ctrl+H` / `Cmd+Option+F`（标准约定）。
- **存盘策略**：Ctrl+S 调 `persist.saveNow()` 而非 `markDirty`，因为 `saveNow` 立即 flush（跳过 1200ms 防抖）→ "立刻保存到云端"语义对齐用户心智。

### 1.3 实现要点

#### 1.3.1 新增 `apps/web/src/features/kb/hooks/useShortcuts.ts`

```ts
type Platform = "mac" | "win" | "linux";
type KeyCombo = { key: string; meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean };
type Binding = { id: string; combos: KeyCombo[]; preventDefault?: boolean; allowInEditable?: boolean };

export function useShortcuts(
  bindings: Binding[],
  handlers: Record<string, (e: KeyboardEvent) => void>,
  options?: { rootRef?: React.RefObject<HTMLElement>; isComposingGuard?: boolean }
): void;
```

实现要点：
- 平台检测 `navigator.platform.toLowerCase().includes("mac")`（带 SSR 兜底）
- `mod = e.metaKey || e.ctrlKey` 通配
- 作用域校验 `rootRef.current?.contains(e.target)`
- IME 守卫 `if (e.isComposing) return;`
- 挂载方式：window 级 `keydown` 捕获阶段监听 + 卸载时移除
- **不**绑定在每个 `Editable` 上（散且重复）

#### 1.3.2 DocEditorPage.tsx：挂载 Ctrl+S/Cmd+S

```ts
// DocEditorPage.tsx 新增 useEffect
useShortcuts(
  [{ id: "save", combos: [{ key: "s", meta: true }], preventDefault: true }],
  { save: () => void persist.saveNow() },
  { rootRef: editorAreaRef }
);
```

- 不需要改三件套签名（DocEditorPage → MarkdownEditor → WysiwygEditor）。
- `editorAreaRef` 已有（DocEditorPage.tsx:30），直接复用做作用域校验。

#### 1.3.3 WysiwygEditor.tsx：在 `onKeyDown` (447) 扩展编辑类快捷键

```ts
const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
  if (e.nativeEvent.isComposing) return;  // IME 守卫（已有）

  // === 新增：修饰键快捷键 ===
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.altKey) {
    switch (e.key.toLowerCase()) {
      case "b": e.preventDefault(); execInline("bold"); return;
      case "i": e.preventDefault(); execInline("italic"); return;
      case "x": if (e.shiftKey) { e.preventDefault(); execInline("strikeThrough"); } return;
      case "e": e.preventDefault(); execInline("insertHTML", "<code>...</code>"); return;
      case "z": e.preventDefault(); e.shiftKey ? history.redo() : history.undo(); return;
      case "y": if (!e.shiftKey) { e.preventDefault(); history.redo(); } return;
      case "n": if (e.altKey) { e.preventDefault(); cycleBlockType(); } return;
    }
  }
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault(); moveBlock(e.key === "ArrowUp" ? -1 : +1); return;
  }

  // === 原有块编辑导航键（保留） ===
  // ... WysiwygEditor.tsx:460-535 全部不变
};
```

- `history` undo/redo 调用项目已有的 `kb-history.ts`（如已有）或 `EditorState` 的撤销栈；若无则 MVP 不实现 Cmd+Z 拦截（仅 Ctrl+S 等纯新功能）。
- `execInline` 已存在（WysiwygEditor.tsx:1642），直接复用。
- `cycleBlockType` / `moveBlock` 是新增函数（MVP 内）。

#### 1.3.4 MarkdownEditor.tsx：SourceEditor 模式加 Ctrl+S

`SourceEditor.onKeyDown` (MarkdownEditor.tsx:430) 增加一行：mod+s → preventDefault → `props.onSave?.()` 或通过 `DocEditorPage` 透传 `saveNow`。

#### 1.3.5 全局不破坏

- `KbShell.tsx:17` 的 `Ctrl+K` 全局搜索监听改用捕获阶段 + `stopPropagation`，避免编辑器拦截。
- 焦点在非编辑器（搜索对话框/版本历史抽屉）时，`editorAreaRef.current.contains(target)` 返回 false → 不触发。
- `CommandBar` / `SearchDialog` 等弹窗已有自己的 Esc 捕获监听，不受影响（我们的快捷键在捕获阶段先于弹窗的 React handler，但 Esc 不冲突因为我们仅 preventDefault 不 stopPropagation）。

### 1.4 验收标准

| AC | 验收方法 | 通过标准 |
|----|----------|----------|
| AC-1.1 | 编辑内容 → 按 Ctrl+S（Win） | 不弹"另存为"对话框；顶栏状态从"有未保存"→"保存中…"→"已保存到云端"；刷新仍在 |
| AC-1.2 | 同上 → 按 Cmd+S（Mac） | 同上 |
| AC-1.3 | 焦点在搜索对话框 → 按 Ctrl+S | 不触发云保存（对话框不应被劫持） |
| AC-1.4 | 选中文字 → Ctrl+B | 视觉加粗；切源码态为 `**x**` 而非 `<b>x</b>` |
| AC-1.5 | 选中文字 → Ctrl+I | 视觉斜体；切源码态为 `*x*` 而非 `<i>x</i>` |
| AC-1.6 | 输入后 Ctrl+Z | 撤销后源码态 Markdown 同步回退（非仅 DOM） |
| AC-1.7 | 中文输入法组词中按 Enter/方向键 | 候选词正常上屏/选词；编辑器不拦截 |
| AC-1.8 | 焦点在版本历史抽屉 → 按 Ctrl+S | 不触发云保存 |

---

## 问题 2：锚点链接保存后退化为纯文字

### 2.1 根因分析

**调研结论**（Explore Agent 4ddc0394）：

**3 步完整生命周期**：

1. **粘贴创建 span**（编辑态可点击）：`WysiwygEditor.tsx:2248-2289` `onPaste` 正则拆出 `path`+`anchor`，调 `insertAnchorPastedSpan(path, anchor, title)`（:2405），创建 `<span class="md-anchor-pasted" data-href="..." data-anchor="...">title</span>`。**编辑态点击走 B3 分支**（:2214-2233）只读 DOM dataset，从未经过 markdown。

2. **DOM → markdown 序列化**（保存，链接在此丢失）：
   - `syncBlock`（`WysiwygEditor.tsx:305-318`）调 `htmlToInlineMd(el)`（`blocks.ts:115-184`）。
   - `htmlToInlineMd` 的 `span` 分支（`blocks.ts:241-257`）：
     ```js
     case "span": {
       if (el.classList.contains("md-mention")) { /* 还原为 @[u:id|名] */ }
       const style = el.getAttribute("style");
       if (style) { /* 透传 style */ }
       return inner;  // ← .md-anchor-pasted 命中这里，data-href/data-anchor 静默丢弃
     }
     ```
   - 注释（`WysiwygEditor.tsx:2426-2428`）误写"现有 inlineMdToHtml/escape 路径会输出纯文本——OK"——**这是 bug 来源**：编辑态点击走 dataset 不假，但保存路径完全没保留。

3. **markdown → DOM 回读**（预览/重载/分享）：`mdToBlocks`（`blocks.ts:556`）+ `inlineMdToHtml`（:115-184）回读时只看到纯文本，无任何链接信息。

**真实存盘 markdown**（实测）：
```
第一章 概述
```
纯文本，无 `[text](url)`、无 `data-href`、无 `data-anchor`。

### 2.2 产品逻辑设计

#### 2.2.1 关键决策

- **统一用标准 GFM 链接 `[text](url#fragment)`**，不再用 `data-href/data-anchor` 双属性。原因：
  1. 三个渲染器（编辑器 `inlineMdToHtml`、预览/分享 `renderMarkdown`）全部已支持 `[text](url#frag)`（blocks.ts:129-138、markdown.ts:33-41）
  2. 现有 `makeLinkClickHandler`（internal-links.ts:69-73）已对 `/kb` 开头链接调 `navigate(href)`，含 fragment 时 `DocEditorPage.tsx:48-78` 的 hash 滚动逻辑会处理
  3. 选区探测 `resolveLink`（`useLinkResolve.ts:24`）的 `INTERNAL_RE = /^\/kb\/([^/]+)\/(doc|canvas)\/([^/?#]+)/` 不含 fragment（`[^/?#]+`），探测不受影响
- **slugify 前后端 round-trip 一致**：`WysiwygEditor` 生成 `h-<slug>`、`extractHeadingText` 反向找同一 slug（已修复：按 slugify + `-N` 后缀匹配）。
- **特殊 URL 处理**：保留 `path` + `#` + `anchor`，未来若支持外部 URL 再扩协议白名单（`isSafeUrl`/`isDangerousHref` 已就位）。

#### 2.2.2 渲染器现状

| 场景 | 渲染器（file:line） | 当前支持 `[text](url#frag)` |
|------|---------------------|-----------------------------|
| (a) 编辑器重载 | `inlineMdToHtml` (blocks.ts:115-184, 链接分支 :129-138) | ✅ 输出 `<a class="md-link md-link-internal" data-href>` |
| (b) 预览模式 | `renderMarkdown` (markdown.ts:120, 链接分支 :33-41) + `makeLinkClickHandler` (internal-links.ts:57-76) | ✅ |
| (c) 分享页（免登录） | 复用 (b) 同一组件 (PublicSharePage.tsx:184-190 → MarkdownEditor preview) | ✅ |

**三个渲染器零改动。**

### 2.3 实现要点

#### 2.3.1 唯一代码改动：`apps/web/src/features/kb/blocks.ts`

在 `htmlToInlineMd` 的 `span` 分支（:241）新增 `.md-anchor-pasted` case：

```ts
case "span": {
  // 修复 #2：锚点粘贴 span 序列化为标准 GFM 链接，避免保存后退化为纯文字
  if (el.classList.contains("md-anchor-pasted")) {
    const href = el.getAttribute("data-href") || "";
    const anchor = el.getAttribute("data-anchor") || "";
    if (!href) return inner;
    return `[${inner}](${href}${anchor ? `#${anchor}` : ""})`;
  }
  if (el.classList.contains("md-mention")) {
    const uid = el.getAttribute("data-user") || "";
    const label = (el.textContent ?? "").replace(/^@/, "");
    return `@[u:${uid}|${label}]`;
  }
  // ... 原 style 分支不变
}
```

#### 2.3.2 删除误导性注释

`WysiwygEditor.tsx:2426-2428` 的"现有 inlineMdToHtml/escape 路径会输出纯文本——OK"改为：

```
// 序列化为 [title](href#anchor) 由 blocks.ts 的 htmlToInlineMd 实现，
// 渲染器（编辑器/预览/分享）共享此格式，三处可点可跳。
```

#### 2.3.3 单元测试

新增 `apps/web/src/features/kb/__tests__/htmlToInlineMd.test.ts`：

```ts
test("md-anchor-pasted 序列化为 [title](href#anchor)", () => {
  const html = `<span class="md-anchor-pasted" data-href="/kb/x/doc/y" data-anchor="h-abc">第一章</span>`;
  expect(htmlToInlineMd(html)).toBe("[第一章](/kb/x/doc/y#h-abc)");
});
test("缺 data-href 时退化为纯文本（防御）", () => {
  const html = `<span class="md-anchor-pasted" data-anchor="h-abc">第一章</span>`;
  expect(htmlToInlineMd(html)).toBe("第一章");
});
```

### 2.4 验收标准

| AC | 验收方法 | 通过标准 |
|----|----------|----------|
| AC-2.1 | 粘贴锚点链接 → 立即点击 | 可跳（回归已通过的 B3 分支） |
| AC-2.2 | 粘贴锚点链接 → 等待 1200ms 自动保存 → 刷新 | 链接仍可点击（核心修复） |
| AC-2.3 | 同上 → 切"预览"模式 | 链接可点且跳到正确标题 |
| AC-2.4 | 同上 → 复制分享链接 → 免登录打开 | 链接可点（分享页走同一渲染器） |
| AC-2.5 | 切"源码"态查看 | 显示 `[第一章 概述](/kb/.../doc/...#h-第一章-概述)` 而非裸 `第一章 概述` |
| AC-2.6 | 重复标题（`### 重复标题` × 2） | 第二次粘贴仍能命中正确的那一个（依赖 `extractHeadingText` 的 `-N` 后缀） |
| AC-2.7 | 危险协议 `javascript:` 等 | 仍被 `isSafeUrl` 拦截（回归） |

---

## 问题 3：画布"插入关联"交互重设计

### 3.1 根因分析

**调研结论**（Explore Agent 51ab8a32）：

**当前实现**：
- F4 浮动按钮 = `LinkBlockInserter.tsx:36-48`，挂载 `CanvasEnhanceOverlay.tsx:124`
- 数据模型 `GxLinkBlock`（types.ts:39-52）= PlaitElement + type="geometry" + shape="rectangle" + gxLinkRef
- 插入链路：点击 → picker → `insertLinkBlock`（canvas-ops.ts:236-260）→ `Transforms.insertNode` → `onValueChange` 防抖 → `PUT /api/kb/docs/:docId/content`
- "1 canvas = 1 preview" **不是数据库约束**，是 UX 限制：
  1. `LinkBlockInserter.tsx:25` 每次插到固定中心 `[ox+400/zoom, oy+300/zoom]`，插多个会重叠
  2. `CanvasEnhanceOverlay.tsx:35` `openRefNodeId` 是单 string，`DocRefCard` 同一时刻只开 1 张

**关键发现**：本仓库 Plait 0.89.2 + Drawnix 0.4.0-0 **没有 Plait 官方 Toolbar 扩展 API**（`setToolbar`/`getToolbar`/`withFloatingToolbar`/`ToolbarItem` 全仓库搜不到）。现有"工具栏"全是自定义 React overlay：NodeStyleBar（选中样式条）、CanvasPreviewToolbar（右下缩放条）、LinkBlockInserter（左下插入按钮）。

### 3.2 产品逻辑设计

#### 3.2.1 关键决策

- **不能"注册到 Plait 工具栏"**：此版本 Plait/Drawnix 没提供扩展点。
- **整合到现有 overlay 体系**：左下角升级为"画布插入条"（与右下 `CanvasPreviewToolbar` 对称），F4 单按钮并入工具条作为第一个按钮。
- **不新建独立 `canvas_preview_block` 表**：关联块作为 Plait 节点天然获得"撤销栈 + 自动保存 + 版本历史"链路，新建表会破坏这条链路。
- **扩展 `GxDocRef` 节点自定义字段**（types.ts:15-20）：`displayTitle` / `previewType` / `order`。
- **错开坐标 + 多开 card**：解决重叠与多预览 UX 限制。
- **删除 F4 浮动按钮**：单一功能不要两个入口。

#### 3.2.2 新画布插入条（替代 F4）

位置：`fixed bottom-4 left-4`，与右下 `CanvasPreviewToolbar` 对称。

```
┌─────────────────────────────────────────┐
│ [🔗 插入关联] [📄 新建文档] [🖼 新建画布] │
└─────────────────────────────────────────┘
```

三个按钮，编辑态常驻，只读/分享态隐藏（沿用 `LinkBlockInserter.tsx:16` 的 `canEdit` 守卫）。

#### 3.2.3 增强 picker

点击"插入关联"按钮 → 弹出 popover：

```
┌─────────────────────────────────────────┐
│ [🔍 搜索文档或画布…]                      │
│ [全部] [📄 文档] [🖼 画布]    （tab 筛选）  │
│ ─────────────────────────────────────── │
│ 📄 文档A            ↗ 插入               │
│ 🖼 画布B            ↗ 插入               │
│ ...                                      │
│ ─────────────────────────────────────── │
│ 预览类型：(•) 完整预览  ( ) 极简预览      │
└─────────────────────────────────────────┘
```

- "全部/文档/画布" tab 过滤
- 搜索输入
- 列表项带 `DocKindIcon`（kb-ui.tsx:9-13）+ 标题 + 插入按钮
- 预览类型 radio（决定关联块的渲染密度）

#### 3.2.4 新建文档/画布按钮（独立入口，不走 picker + 弹窗编辑器模式）

点击"📄 新建文档" → 弹出最小化表单 popover：

```
┌──────────────────────────────────┐
│ 标题：____________________________ │
│ [取消]                            [创建并插入] │
└──────────────────────────────────┘
```

成功 → 调 `KbApi.createDoc`（kb.ts:317）→ 拿到 doc.id → `insertLinkBlock` → **不跳转**，而是**弹出 `EditorModal`**（编辑器全屏弹窗）让用户立即编辑新文档。

```
┌─────────────────────────────────────────┐
│ EditorModal（弹窗编辑页）                  │
│ ┌─────────────────────────────────────┐ │
│ │ 标题（内联编辑）                    × │ │
│ ├─────────────────────────────────────┤ │
│ │ MarkdownEditor（readWrite 模式）    │ │
│ │                                     │ │
│ ├─────────────────────────────────────┤ │
│ │ [取消]                       [保存] │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

设计要点：
- **不跳转**（用户决策 D3）：保留画布上下文，适合"做设计图补充说明"场景。
- **Modal 而非 panel**：聚焦当前任务，关闭即返回画布。
- **保存后画布预览块实时更新**：`useCreateDoc` 拿到 id → `insertLinkBlock` → 打开 modal → 用户编辑 → 保存 → 关闭 modal → 画布上的 `DocRefCard` 通过 `useDoc(id)` 重新拉取显示新内容。
- "新建画布"同理，EditorModal 内换成 DrawnixCanvas。
- 复用现有 `DocEditorPage` 组件（WysiwygEditor + SourceEditor），传 `mode="modal"` prop 让其适配弹窗容器（去顶栏/标题改为内联编辑/保存按钮浮在底部）。

#### 3.2.5 渲染行为升级（每个 preview block）

| 行为 | 设计 |
|------|------|
| 点击跳转 | 单击标题区跳转（双击沿用）；单击 body 不跳（避免拖拽冲突） |
| 编辑标题（本地） | 标题旁 `edit` 图标 → 内联 input → `setLinkBlockDisplayTitle` |
| 缩放/移动/删除 | Plait 原生 + 头部 `trash`（已有 GxLinkBlockView.tsx:127-136） |
| 源标题实时更新 | 展示 `doc.title ?? displayTitle ?? gxLinkRef.title`；block 上 `refresh` 按钮触发 `refetch()` |

#### 3.2.6 多预览 UX 规则

- 插入时根据已有 link-block 数量做**级联偏移**（如 `offset = n * 24`），避免重叠。
- `openRefNodeId: string|null` → `Set<string>`，允许同时展开多张 `DocRefCard`。
- 单 canvas 理论无上限（受 Plait 节点总数限制）。

### 3.3 实现要点

#### 3.3.1 文件改动清单

| 文件 | 改动 |
|------|------|
| `apps/web/src/features/kb/canvas/types.ts` | `GxDocRef` 扩展 `displayTitle?` / `previewType: "full"\|"minimal"` / `order?` |
| `apps/web/src/features/kb/canvas/canvas-ops.ts` | `insertLinkBlock` 支持显式 position + 级联偏移；新增 `setLinkBlockDisplayTitle` / `setLinkBlockPreviewType` |
| `apps/web/src/features/kb/canvas/LinkBlockInserter.tsx` | 单按钮升级为 `CanvasInsertToolbar`（3 按钮）；`LinkBlockPicker` 加 tab 筛选 + 预览类型 radio；**新增 `NewDocPopover` / `NewCanvasPopover`** |
| `apps/web/src/features/kb/canvas/GxLinkBlockView.tsx` | 支持 `previewType`（full/minimal）、标题编辑、`refresh` 刷新源标题 |
| `apps/web/src/features/kb/canvas/CanvasEnhanceOverlay.tsx` | `openRefNodeId: Set<string>` 多开；`LinkBlockInserter` 新挂载方式 |
| `apps/web/src/features/kb/canvas/MindMapShapePopover.tsx` | （无关问题 4 修复，独立） |

#### 3.3.2 GxDocRef 扩展（types.ts:15-20）

```ts
export interface GxDocRef {
  docId: string;
  kind: "doc" | "canvas";
  title: string;
  /** 本地重命名（覆盖源标题） */
  displayTitle?: string;
  /** 预览类型：full=完整预览（带摘要/图片）；minimal=极简（仅标题+跳转） */
  previewType?: "full" | "minimal";
  /** 顺序（多预览时排序） */
  order?: number;
}
```

#### 3.3.3 insertLinkBlock 级联偏移（canvas-ops.ts:236）

```ts
export function insertLinkBlock(
  board: PlaitBoard,
  ref: GxDocRef,
  options?: { x?: number; y?: number; cascade?: boolean }
): void {
  // ... 现有逻辑构造 element ...
  // 计算位置：若 cascade=true 则按已有 link-block 数量错开
  let { x, y } = options ?? {};
  if (x === undefined || y === undefined) {
    const offset = options?.cascade ? board.children.filter(isLinkBlock).length * 24 : 0;
    const o = PlaitBoard.getRectangle(board);  // 视图原点
    x = o?.x + 400 / board.viewport.zoom + offset;
    y = o?.y + 300 / board.viewport.zoom + offset;
  }
  // ... Transforms.insertNode ...
}
```

#### 3.3.4 CanvasEnhanceOverlay 多开（CanvasEnhanceOverlay.tsx:35）

```ts
// 原: const [openRefNodeId, setOpenRefNodeId] = useState<string | null>(null);
const [openRefNodeIds, setOpenRefNodeIds] = useState<Set<string>>(new Set());
// 切换: openRefNodeIds.has(nodeId) ? set.delete(nodeId) : set.add(nodeId)
```

#### 3.3.5 新建文档 popover（独立组件，避免与 picker 耦合）

```ts
// apps/web/src/features/kb/canvas/NewDocPopover.tsx
export function NewDocPopover({ kbId, onCreated }: { kbId: string; onCreated: (docId: string) => void }) {
  const [title, setTitle] = useState("");
  const create = useCreateDoc();
  return (
    <Popover>
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="新文档标题" />
      <button onClick={async () => {
        const doc = await create({ kbId, title, kind: "doc" });
        onCreated(doc.id);
      }}>创建并插入</button>
    </Popover>
  );
}
```

#### 3.3.6 数据迁移

无需独立迁移脚本。旧节点的 `gxLinkRef` 缺 `displayTitle/previewType/order` → 用默认值兜底（`previewType ?? "full"`）。

### 3.4 验收标准

| AC | 验收方法 | 通过标准 |
|----|----------|----------|
| AC-3.1 | 画布编辑态左下角 | 出现 3 按钮工具条（插入关联/新建文档/新建画布），F4 浮动按钮已删除 |
| AC-3.2 | 点"插入关联" → picker | 搜索 + tab 筛选 + 预览类型 radio 全在 |
| AC-3.3 | 插 1 个 → 插第 2 个 | 第二个不与第一个重叠（级联偏移生效） |
| AC-3.4 | 同时点 2 个 block 的标题 | 2 张 `DocRefCard` 同时展开（多开生效） |
| AC-3.5 | 点"新建文档" → 输标题 → 创建 | 弹出 EditorModal 而非跳转 → 用户可在弹窗内编辑 → 保存关闭 → 画布预览块显示新内容 |
| AC-3.6 | 刷新页面 | 块数量与位置保持不变 |
| AC-3.7 | 选"极简预览"插入 | block 只显标题+跳转按钮，无摘要 |
| AC-3.8 | 块标题旁 edit 图标 → 改本地标题 | 立即生效，刷新仍在 |
| AC-3.9 | 只读/分享态访问 | 工具条不渲染 |
| AC-3.10 | 源文档改标题 → 点 block 上的 refresh | block 标题更新 |

---

## 问题 4：思维导图样式条缺失（真实代码 bug）

### 4.1 根因分析

**调研结论**（Explore Agent cb53c2da）—— **这是真实代码 bug，不是浏览器缓存也不是 Playwright 限制**。

**5 道闸门把 mindmap 元素过滤掉**：

| 闸门 # | 位置 | 问题 |
|--------|------|------|
| ① | `CanvasEnhanceOverlay.tsx:60` | `if (!el \|\| !(isShapeLike(el) \|\| isLineLike(el))) continue;` — mind 节点既不是 `geometry` 也不是 `arrow-line/vector-line`，被直接丢弃 |
| ② | `CanvasEnhanceOverlay.tsx:71-78, 110` | `selectedRects` 为空 → `barAnchor = null` → `<NodeStyleBar>` 根本不渲染 |
| ③ | `NodeStyleBar.tsx:76` | `style = readSelectionStyle(board)` 只找 draw 元素（canvas-ops.ts:150-166） |
| ④ | `NodeStyleBar.tsx:107` | `if (!style) return null;` — mind 选区 `readSelectionStyle` 返回 null → 直接 return |
| ⑤ | `types.ts:91-102` | `isMindMapNode` 匹配 `"mind" \| "mind-map-topic" \| "mind-map-root" \| "mind-map-node"`；**真实 Plait 0.89.2 类型是 `"mind" \| "mind_child" \| "mindmap"`**（@plait/mind/interfaces/element.d.ts） |

**附加 bug**：
- `setMindMapShape`（canvas-ops.ts:125-135）是**占位空实现**，写的是不存在的 `gxMindShape` 字段，且枚举值 `mind-topic/mind-branch` 写错（应为 `round-rectangle/underline` 对齐 `MindElementShape`）。
- `@plait/draw` patch（patches/@plait__draw@0.89.2.patch）全文 grep `mind` 结果 0，**与本 bug 无关**，已证伪假设 (c)。

**项目记忆错误**：`/Users/daijing/Desktop/GouXiangDB/.workbuddy/memory/2026-09-10.md:42` 此前结论"代码已就位…属 Playwright 合成事件限制，非代码 bug"**是错的**——只核对了 JSX 源码存在，从未验证上游管道是否真的把 mind 元素送进样式条。真实浏览器里用户也看不到，正好证伪该结论。

### 4.2 产品逻辑设计

#### 4.2.1 应存在的思维导图详细设置项

参考标准脑图工具（Xmind / MindNode / Whimsical / Miro）+ `@plait/mind@0.89.2` 真实能力：

| 分类 | 设置项 | 数据字段/API | Plait 支持 | 当前状态 |
|------|--------|--------------|------------|----------|
| **节点** | 形状：圆角矩形/下划线 | `shape` (`round-rectangle`/`underline`) → `setProperty({shape})` | ✅ | ❌ 按钮在但值写错 |
| | 填充色 | `fill` → `setFillColor` | ✅ | ✅（但被闸门挡死） |
| | 描边色 | `strokeColor` → `setProperty({strokeColor})` | ✅ | ⚠ 复用 hasShape 区段，mind 走不到 |
| | 描边宽度 | `strokeWidth` → `setProperty({strokeWidth})` | ✅ | ⚠ 同上 |
| | 描边线型（实/虚/点） | `strokeStyle` → `setProperty({strokeStyle})` | ✅ | ⚠ 同上 |
| | 文字颜色 | text marks → `setTextColor` | ✅ | ✅（被闸门挡死） |
| | 粗/斜/下划线 | text marks → `setTextMarks` | ✅ | ❌ 未对 mind 开放 |
| | emoji | `MindTransforms.addEmoji/removeEmoji/replaceEmoji` | ✅ | ❌ 缺失 |
| | 图片附件 | `MindTransforms.setImage/removeImage` | ✅ | ❌ 缺失 |
| | 手动宽度 | `manualWidth` → `setNodeManualWidth` | ✅ | ❌ 缺失 |
| **分支线** | 形态：贝塞尔/折线 | `branchShape` (`bight`/`polyline`) → `setProperty({branchShape})` | ✅ | ❌ 缺失 |
| | 颜色 | `branchColor` → `setProperty({branchColor})` | ✅ | ❌ 缺失 |
| | 宽度 | `branchWidth` → `setProperty({branchWidth})` | ✅ | ❌ 缺失 |
| **布局** | 方向：右/左/上/下 | `layout = "right"/"left"/"upward"/"downward"` → `setProperty({layout})` | ✅ | ❌ 缺失 |
| | 双侧（standard） | `layout = "standard"` | ✅ | ❌ 缺失 |
| | 缩进式布局 | `"right-bottom-indented"` 等 4 种 | ✅ | ❌ 缺失 |
| **画布级** | 主题 / 分支配色方案 | `MindThemeColors`（DEFAULT/COLORFUL/SOFT/RETRO/DARK/STARRY） | ✅ | ❌ 缺失 |
| | 折叠/展开 | `isCollapsed` | ✅ | ❌ 缺失 |
| **不支持** | 字号 / 字体族 / 文字对齐 | — | ⚠ 不支持逐节点 | — |
| **不支持** | 分支线线型 | mind 分支线无 strokeStyle 字段 | ⚠ | — |

#### 4.2.2 修复优先级

**先做 P0（让样式条在选中 mind 节点时出现并可填色/改形状）**，再做 P1（分支/布局/emoji/图片）：

| 优先级 | 改动 | 必要性 |
|--------|------|--------|
| **P0** | 4.1 类型识别修正（types.ts:91-102） | 必须 |
| **P0** | 4.2 上游过滤开放（CanvasEnhanceOverlay.tsx:60） | 必须 |
| **P0** | 4.3 样式读取扩展（canvas-ops.ts readSelectionStyle） | 必须 |
| **P0** | 4.5 形状弹层枚举值修正（MindMapShapePopover.tsx:17-20） | 必须 |
| P1 | 4.4 写操作实化（setMindMapShape 改为真写 + 新增 setMindMapBranch/Color/Width/Shape/Layout） | 高 |
| P1 | 4.6 思维导图区段扩展（NodeStyleBar.tsx:239-247 补分支/布局/emoji/图片） | 中 |

### 4.3 实现要点

#### 4.3.1 类型识别修正（types.ts:91-102）

```ts
// P0 修复：用 Plait 真实类型串替换猜值
export function isMindMapNode(el: PlaitElement | undefined | null): boolean {
  if (!el) return false;
  const t = (el as { type?: string }).type;
  return t === "mind" || t === "mind_child" || t === "mindmap";
}

// 删除 isMindMapLine（或改为永远 false）—— mindmap 无独立线元素
export function isMindMapLine(_el: PlaitElement | undefined | null): boolean { return false; }
```

> 注：`@plait/mind` 是 drawnix 的传递依赖（apps/web/package.json 未直接声明），用类型串判断避免新增依赖（符合项目"禁止引入新依赖"约定）。

#### 4.3.2 上游过滤开放（CanvasEnhanceOverlay.tsx:60）

```ts
// 原：
if (!el || !(isShapeLike(el) || isLineLike(el))) continue;
// 新：
if (!el || !(isShapeLike(el) || isLineLike(el) || isMindMapNode(el))) continue;
```

#### 4.3.3 样式读取扩展（canvas-ops.ts readSelectionStyle :150-166）

```ts
export function readSelectionStyle(board: PlaitBoard) {
  const elements = getSelectedElements(board);
  const shapes = elements.filter(isShapeLike);
  const lines = elements.filter(isLineLike);
  const minds = elements.filter(isMindMapNode);

  // 至少要有一类元素才有"样式"概念
  if (shapes.length === 0 && lines.length === 0 && minds.length === 0) return null;

  const ref = shapes[0] ?? lines[0] ?? minds[0];
  if (!ref) return null;

  return {
    shapes, lines, minds,
    fill: (ref as any).fill,
    strokeColor: (ref as any).strokeColor,
    strokeWidth: (ref as any).strokeWidth,
    strokeStyle: (ref as any).strokeStyle,
    shape: (ref as any).shape,
    branchColor: (ref as any).branchColor,
    branchWidth: (ref as any).branchWidth,
    branchShape: (ref as any).branchShape,
    layout: (ref as any).layout,
    isCollapsed: (ref as any).isCollapsed,
  };
}
```

#### 4.3.4 写操作实化（canvas-ops.ts）

```ts
// 替换占位的 setMindMapShape（:125-135）
export function setMindMapShape(board: PlaitBoard, shape: "round-rectangle" | "underline") {
  PropertyTransforms.setProperty(board, { shape }, { match: isMindMapNode });
}

// 新增分支与布局写操作
export function setMindMapBranchColor(board: PlaitBoard, color: string) {
  PropertyTransforms.setProperty(board, { branchColor: color }, { match: isMindMapNode });
}
export function setMindMapBranchWidth(board: PlaitBoard, width: number) {
  PropertyTransforms.setProperty(board, { branchWidth: width }, { match: isMindMapNode });
}
export function setMindMapBranchShape(board: PlaitBoard, shape: "bight" | "polyline") {
  PropertyTransforms.setProperty(board, { branchShape: shape }, { match: isMindMapNode });
}
export function setMindMapLayout(board: PlaitBoard, layout: "right" | "left" | "upward" | "downward" | "standard") {
  PropertyTransforms.setProperty(board, { layout }, { match: isMindMapNode });
}

// 保留 setMindMapNodeFill / setMindMapTextColor（已正确转发到 PropertyTransforms.setFillColor / TextTransforms.setTextColor）
```

> 备注：若直接 `setNode({layout})` 对逻辑布局有位置归一化缺失，建议实测；如需精确归一化，走 `MindTransforms.setLayout`（需引入 `@plait/mind` 直依赖，违反项目约定；MVP 内直接 `setNode`）。

#### 4.3.5 形状弹层枚举值修正（MindMapShapePopover.tsx:17-20）

```ts
// 原：
{ value: "mind-topic", label: "圆角矩形" },
{ value: "mind-branch", label: "下划线" },
// 新：
{ value: "round-rectangle", label: "圆角矩形" },
{ value: "underline", label: "下划线" },
```

#### 4.3.6 思维导图区段扩展（NodeStyleBar.tsx:239-247）

```tsx
{hasMindMapNode && (
  <>
      <span className="mx-0.5 text-gx-10 uppercase tracking-wide text-gx-text-hint">思维导图</span>
      <Btn id="mindNodeFill" />        {/* 节点填充色（已有） */}
      <Btn id="mindStrokeColor" />     {/* 节点描边色（新增） */}
      <Btn id="mindStrokeWidth" />     {/* 节点描边宽度（新增） */}
      <Btn id="mindStrokeStyle" />     {/* 节点描边线型（新增） */}
      <Btn id="mindTextColor" />       {/* 文字颜色（已有） */}
      <Btn id="mindTextBold" />        {/* 粗（新增） */}
      <Btn id="mindTextItalic" />      {/* 斜（新增） */}
      <Btn id="mindTextUnderline" />   {/* 下划线（新增） */}
      <Btn id="mindShape" />           {/* 节点形状（已有，枚举已修） */}
      <Btn id="mindBranchColor" />     {/* 分支线颜色（新增） */}
      <Btn id="mindBranchWidth" />     {/* 分支线宽度（新增） */}
      <Btn id="mindBranchShape" />     {/* 分支线形态（新增） */}
      <Btn id="mindLayout" />          {/* 布局方向（新增） */}
      <Btn id="mindEmoji" />           {/* emoji（新增） */}
      <Btn id="mindImage" />           {/* 图片附件（新增） */}
      <Btn id="mindCollapse" />        {/* 折叠/展开（新增） */}
    </>
)}
```

P0 阶段先做：节点填充色 + 文字颜色 + 节点形状（已可点）。
P1 阶段补：描边 + 文字粗斜下划线 + 分支 + 布局 + emoji + 图片 + 折叠。

### 4.4 验收标准

| AC | 验收方法 | 通过标准 |
|----|----------|----------|
| AC-4.1 | 选中 mind 节点（人手点，因 Playwright 限制） | NodeStyleBar 出现（不是死代码） |
| AC-4.2 | 选中 mind 节点 → 看到「思维导图」区段 | 区段可见，至少有"节点填充"/"文字颜色"/"节点形状"按钮 |
| AC-4.3 | 改节点填充色 | 节点 fill 立即变化；Cmd+Z 可撤销；刷新仍在 |
| AC-4.4 | 改节点形状（圆角矩形 ↔ 下划线） | 节点外观切换正确（不再是占位实现） |
| AC-4.5 | 改文字颜色 | 节点文字色变化 |
| AC-4.6 | 选中普通 geometry 节点 | 原"描边/填充/连线"区段仍正常（回归） |
| AC-4.7 | 选中 arrow-line | 原"连线"区段仍正常（回归） |
| AC-4.8 | 画连线 | 不再误触延伸（patch 未受影响，回归） |
| AC-4.9 (P1) | 改分支线颜色/宽度/形态 | 分支线立即变化 |
| AC-4.10 (P1) | 改布局方向（右/左/上下/双侧） | 整棵分支方向重排 |
| AC-4.11 (P1) | 选根节点 → 折叠 | 子节点隐藏；再展开恢复 |

---

## 实施建议与排期

| 任务 | 工时预估 | 建议排期 |
|------|----------|----------|
| 问题 2（锚点持久化，单点修复） | 1 小时 | **第 1 天立即做**（P0 + 单点改动） |
| 问题 4 P0（让样式条出现并可填色/改形状） | 3-4 小时 | 第 2-3 天 |
| 问题 4 P1（思维导图区段扩展） | 4-6 小时 | 第 4-6 天 |
| 问题 3（画布插入 UX 重设计） | 6-8 小时 | 第 7-9 天 |
| 问题 1（跨平台快捷键体系） | 3-4 小时 | 第 10-11 天 |
| 全量回归 + 浏览器实测 | 2-3 小时 | 第 12 天 |

**总预估**：12-15 天可闭环。

---

## 待用户决策事项（已确认）

| # | 决策项 | 结论 |
|---|--------|------|
| D1 | 问题 1 的 MVP 范围 | ✅ **(c) 全套**（Ctrl+S+B+I+U+X+E+Z+Y+H+Esc+Tab+Shift+Tab+Alt+↑↓ 全覆盖） |
| D2 | 问题 1 的 Cmd+Z 策略 | ✅ **拦截 + history 栈**（若项目无 history 模块则新建；原生 contentEditable undo 与 state 不同步会导致保存跳变） |
| D3 | 问题 3 的"新建文档/画布"按钮 | ✅ **不跳转** → 弹窗编辑器 `EditorModal`（不离开画布即可编辑新内容） |
| D4 | 问题 3 的 F4 按钮 | ✅ **迁移后删除**（单一功能不要两个入口） |
| D5 | 问题 4 P1 范围 | ✅ **(b) 全套**（节点 + 分支 + 布局 + emoji + 图片 + 折叠 + 主题） |
| D6 | 实施方式 | ✅ **全做完再验收**（沿用此前"全部处理完后一起验收"惯例） |

---

## 引用调研报告

- 问题 1：[Explore Agent 2a097422] — 快捷键矩阵与实现设计
- 问题 2：[Explore Agent 4ddc0394] — 锚点序列化丢失根因
- 问题 3：[Explore Agent 51ab8a32] — 画布插入 UX 与数据模型
- 问题 4：[Explore Agent cb53c2da] — 思维导图样式条 5 道闸门