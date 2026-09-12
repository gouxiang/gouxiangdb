# KB 编辑器第四轮：画布关联系统全面排查与修复契约（v1.0）

> 日期：2026-09-10
> 状态：**已实现 + 已验收**（4/4 全部落地 + 浏览器实测通过）
> 来源：戴总第 4 轮反馈（基于 3 张截图）+ 3 个 Explore agent 并行深度审计 + 2 个 general-purpose agent 实施
> 浏览器验收：Explore Agent 25b6945a（含真实 CDP `Input.imeSetComposition` 40/40 EXACT_MATCH + DOM 层级几何检测）

---

## 排查总览（先看这个）

3 个 Explore agent 已逐一深读所有 canvas 增强层文件 + Plait/Drawnix 编译产物 + 项目记忆。**关键发现：3 个系统性问题（功能耦合、状态分散、UI 重复）远比表面 4 个 bug 严重**。本轮修复按"先治本"原则梳理执行顺序。

### 核心结论速览

| 类别 | 问题描述 |
|------|----------|
| **架构耦合** | 3 个 modal（DocEditModal/CanvasEditModal/EditorModal）各自独立 z-index + 各自 editing state，**没有任何 modal-stack 协调器** |
| **数据耦合** | `useDoc` 缓存刷新策略三套并存（EditorModal 用 `qc.invalidateQueries`，GxLinkBlockView 用 `internal.refetch()`，LinkBlockInserter 用"refresh 按钮兜底"） |
| **UI 重复** | GxLinkBlockView（独立块）与 DocRefCard（节点角标）布局相似但按钮集/样式不同——大量重复 JSX |
| **Drawnix 限制** | Drawnix 0.4.0-0 的 `<Drawnix>` props **无 toolbar 扩展点**，`BUTTONS` 是硬编码常量（plait-board.d.ts） |
| **Z-index 现状** | CanvasEditModal z-60、DocRefCard z-68、NodeBadges z-65、NodeStyleBar z-70、EditorModal/DocEditModal z-80、popovers z-72、toast z-100 |

### 用户描述偏差订正

1. "插入关联在右下角" → 实际是 **bottom-left** (`LinkBlockInserter.tsx:74`)，左下角而非右下角
2. "DocRefCard 也用于图片嵌入" → 实际**不渲染图片**，图片由 Drawnix 原生组件渲染；DocRefCard 仅服务 `gxDocRef` 文档/画布角标
3. "在画布中通过插入创建的文档输入中文丢字" → 该问题**同时影响** DocEditModal（DocRefCard → 编辑）和 EditorModal（LinkBlockInserter → 新建），因为都走同一个 WysiwygEditor 链路

---

## 问题 1：将"插入关联"移入顶部工具栏 + 统一 picker

### 1.1 根因

- **入口位置耦合**：`LinkBlockInserter.tsx:74` 三按钮工具条位于 `fixed bottom-4 left-4 z-50`，与画布的"插入关联"语义不匹配——既不在用户视线焦点（顶部工具栏）上，也不在画布编辑区附近
- **Drawnix 工具栏硬编码**：`@drawnix/drawnix@0.4.0-0` 的 `<Drawnix>` props **完全没有 toolbar 扩展 API**（核实：`DrawnixProps` 类型 `drawnix.d.ts` 只有 `value/onChange/afterInit/tutorial` 等），`BUTTONS` 是模块级硬编码常量，无法注入新按钮
- **左上角位置空出**：`kb.css:309` 在 enhance 态隐藏 `.app-toolbar`（Drawnix 原生左上角工具条）→ 左上角槽位（`top:36px; left:36px`）正好可放新按钮
- **Picker 重复**：`LinkBlockPicker`（LinkBlockInserter:245-347）与 `DocRefPickerPopover`（DocRefPickerPopover.tsx:16-111）列表 + 过滤逻辑重复实现

### 1.2 产品逻辑设计

#### 1.2.1 顶部"关联"入口位置

```
   ┌─────────────── Drawnix 顶部工具栏 ───────────────┐
   │ 手│选│脑│T│画│线│插图│插画布  ← Drawnix 原生       │
   └─────────────────────────────────────────────────┘
  📎关联  ← 新增在左上角（kb.css:309 隐藏 app-toolbar 留出的槽位）
```

- 位置：`absolute top-[36px] left-[36px]`（与原 `.app-toolbar` 槽位一致）
- 仅编辑态可见（沿用 `!canEdit` 守卫 + 只读态隐藏）
- 通过 `CanvasOverlayLayer` portal（继承 `.kb-canvas-wrap` 内 `position: relative`）→ 不受画布平移/缩放影响

#### 1.2.2 统一 picker 架构

```
┌─ CanvasLinkPicker（新组件，供 2 个场景复用）─────────────────────┐
│ [🔍 搜索文档或画布…]                                              │
│ [全部 | 文档 | 画布]   ← tab（来自 LinkBlockPicker:268-272）      │
│ ──────────────────────────────────────────────                    │
│ 📄 DocA              [+] 插入          │  🖼 CanvasB    [+] 插入  │
│ ──────────────────────────────────────────────                    │
│ [➕ 新建文档]  [➕ 新建画布]     ← 内联表单（合并 NewDocForm）       │
│ [预览类型: (•) 完整预览  ( ) 极简预览]   ← 仅独立块场景需要        │
└─────────────────────────────────────────────────────┘
```

- **文档/画布共享一个创建入口**：两者都走 `useCreateDoc(kbId, {kind, title})`（client.ts:514-515），差异仅 `kind`。无需双 tab，并排两个按钮即可
- **2 种消费端适配**：
  - **独立块**（原 LinkBlockInserter 场景）：`onPick → insertLinkBlock` + EditorModal
  - **节点角标**（原 DocRefPickerPopover 场景）：`onPick → setElementDocRef`，并保留"取消关联"按钮

### 1.3 实现要点

**新文件**：
- `apps/web/src/features/kb/canvas/CanvasLinkEntry.tsx` — 左上角"关联"按钮 + 打开 picker
- `apps/web/src/features/kb/canvas/CanvasLinkPicker.tsx` — 统一 picker（含 tab、内联新建、预览密度 radio）

**修改**：
- `CanvasEnhanceOverlay.tsx` — 替换 `<LinkBlockInserter />` 为 `<CanvasLinkEntry />`
- `DocRefPickerPopover.tsx` — 内部复用 `CanvasLinkPicker`（保留"取消关联"分支）
- `kb.css` — 确认 `.app-toolbar` 已隐藏，新增按钮挂在已有 CanvasOverlayLayer 无新样式

**删除**：
- `LinkBlockInserter.tsx` — 全部功能并入 `CanvasLinkEntry`/`CanvasLinkPicker`

---

## 问题 2：统一关联嵌入 UI 样式

### 2.1 根因

**直接对比 JSX**：

| 元素 | GxLinkBlockView（独立块） | DocRefCard（节点角标） |
|------|---------------------------|------------------------|
| 头部标题 | 图标 + 可内联编辑 input/span | 图标 + 不可编辑 span |
| 跳转 | 图标按钮（无文字） | 文字按钮"↗ 跳转" |
| 编辑入口 | ❌ **缺失**（独立块无"编辑源文档"按钮） | ✓ 蓝按钮"编辑" |
| 重命名 | ✓ edit 图标 | ❌ 缺失 |
| 刷新 | ✓ refresh 图标 | ❌ 缺失 |
| 删除 | ✓ trash 图标 | ❌ 用"关闭"代替 |
| 关闭 | ❌ 无 | ✓ close 图标 |
| 编辑器入口 | ❌（点击标题区跳转） | ✓ DocEditModal / CanvasEditModal |

**为什么看着像但不统一**：动作集不同 + 样式不同（图标 vs 文字）。

### 2.2 产品逻辑设计

#### 2.2.1 统一组件规格：`<LinkBlockPreview>`

```tsx
interface LinkBlockPreviewProps {
  kind: "doc" | "canvas";
  title: string;                           // 显示标题
  canEdit: boolean;
  canRename?: boolean;                     // 仅独立块
  onRename?: (newTitle: string) => void;   // 仅独立块（setLinkBlockDisplayTitle）
  onJump: () => void;                      // 统一 navigate
  onEdit?: () => void;                     // 统一打开 DocEditModal/CanvasEditModal/EditorModal
  onRefresh?: () => void;                  // 仅独立块（trigger refetch）
  onDelete?: () => void;                   // 独立块=removeLinkBlock；角标卡=null
  onClose?: () => void;                    // 角标卡=onClose；独立块=null
  previewType?: "full" | "minimal";
  body?: ReactNode;                        // 摘要/全文/minimal 内容
}
```

#### 2.2.2 Header 统一规则

```
┌────────────────────────────────────────────────────────────┐
│ [DocKindIcon] [Title（可内联编辑）] [edit]   [↗ 跳转] [✏️ 编辑] [🗑] [×] │
└────────────────────────────────────────────────────────────┘
```

- 跳转/编辑：文字按钮（统一成 DocRefCard 样式）
- 重命名 edit / refresh：仅独立块显示
- 删除：仅 canEdit && 独立块显示
- 关闭：仅角标卡显示
- "编辑"按钮：独立块场景**新增此能力**——以前只能"内联重命名"或"跳转"，现在可弹窗编辑源文档

#### 2.2.3 Body 统一规则

- `previewType === "full"`：摘要（独立块）/ 全文 Markdown（角标卡）→ 由调用方注入
- `previewType === "minimal"`：仅标题 + 跳转引导
- 角标卡的 `previewType` 待 GxDocRef 扩展后支持（当前 DocRefPickerPopover 只写 `{docId,kind,title}`）

### 2.3 实现要点

**新文件**：
- `apps/web/src/features/kb/canvas/LinkBlockPreview.tsx` — 统一预览组件（含 LinkBlockHeader 子组件）

**修改**：
- `GxLinkBlockView.tsx` — 用 LinkBlockPreview 重写，补"编辑→弹窗编辑器"入口
- `DocRefCard.tsx` — 用 LinkBlockPreview 重写（保留 localStorage 尺寸 + 弹窗编辑）

---

## 问题 3：IME 输入丢失

### 3.1 根因（深度分析）

**完整链路**（来源：Explore Agent f50c0150）：

```
t0: 用户点击正文 → contenteditable.focus()
t1: 输入拼音 "z" → compositionstart
    → input 事件（isComposing=true）
    → onBlockInput(id) → syncBlock(id)
      → htmlToInlineMd(el) 读 DOM ← ❌ 正在 IME 期间，浏览器管 DOM
      → b.text = "z"（mutate ref）
      → historyRef.push(JSON.stringify(blocks)) ← 同步序列化
      → onChange("z") → MarkdownEditor.setMd("z") ← 整树重渲染
t2: 连打 "zho" → 重复 t1，每个字母都触发整树重渲染
t3: 按数字键/Space → compositionend
    → DOM 中 composition span 被替换为提交字符 "中"
    → input 事件（isComposing=false）
    → syncBlock 把 b.text 改为 "中"
    → onChange → setMd → 重渲染
t4: 立即敲下一个字 "w"
    → 如果 React 在 t3→t4 之间仍在提交 t3 的 setMd 重渲染
    → 期间 contenteditable focus 状态可能瞬时翻转为 false
    → Editable useEffect 看到 !focused=true，覆写 innerHTML ← IME 会话立即终止
```

**为什么慢速没事**：t1→t2→t3→t4 间隔大，React 重渲染在每个间隙内完成，focused 不会瞬时翻转为 false。

**根本缺失**：WysiwygEditor 的 IME 守卫**只在 keydown 上有**（`onKeyDown` + 原子块 window keydown），**input 事件链路上完全没有 isComposing 检查**。

**影响范围**：DocEditModal + EditorModal（都走 WysiwygEditor）。CanvasEditModal 用 DrawnixCanvas（Plait 自管 IME），本项目层面不受影响。

### 3.2 产品逻辑设计

#### 3.2.1 修复原则

- **最小改动 + 不破坏 undo/redo**：在 IME 期间跳过 DOM 读取和 innerHTML 覆写，IME 结束后**重放一次 syncBlock** 兜底
- **同步触发而非竞争**：用 `isComposingRef`（同步 ref，避免 React 状态延迟）跨 IME 周期传递信号

#### 3.2.2 守卫点（5 处）

1. `WysiwygEditor.syncBlock` (WysiwygEditor.tsx:340) — IME 期间跳过整个函数
2. `WysiwygEditor.applyHistoryState` rAF 刷新 (WysiwygEditor.tsx:310) — IME 期间跳过覆写
3. `Editable` useEffect (WysiwygEditor.tsx:185-190) — IME 期间保留现有 `!focused` 守卫，叠加 `!isComposingRef.current`
4. `detectSlash` / `detectMention` — 函数开头加 `if (isComposingRef.current) return;`（IME 期间不应弹斜杠菜单或 @ 面板）
5. `EditorModal.tsx:165-172` 内联 onChange — 改 `useCallback` 稳定引用，避免父级重渲染引发 useCallback 链重排

### 3.3 实现要点

**修改文件**：
- `WysiwygEditor.tsx` — 加 `isComposingRef` + 5 处守卫 + onCompositionEnd 重放 syncBlock + 根 div 挂 onCompositionStart/End
- `EditorModal.tsx` — `handleEditorChange` 改 useCallback

**测试要点**：
- macOS Chrome + 微软拼音/搜狗拼音
- 5 轮「中文测试 ABC」快速输入 → 0 次 IME 中断
- 中文夹杂 ASCII：「Hello 中文 World 你好」不丢字符
- 中文回车换行后继续输入：「中文」↵「测试」

---

## 问题 4：编辑关联画布弹窗层级

### 4.1 根因

**单点不一致**：`CanvasEditModal.tsx:60` 用 `z-[60]`，但 `DocRefCard`（z-68）、`NodeStyleBar`（z-70）、`EditorModal`/`DocEditModal`（z-80）都比它高。

```
DocRefCard(z-68) > CanvasEditModal(z-60) → 预览卡遮住弹窗上半部分
```

**触发链路**：
1. 用户点节点关联角标（NodeBadges）→ 展开 DocRefCard(z-68)
2. 用户在 DocRefCard 点"编辑"→ 内联渲染 CanvasEditModal(z-60)
3. DocRefCard(z-68) 覆盖 CanvasEditModal(z-60) → 用户看到错乱

**`.kb-canvas-wrap` 不是堆叠上下文创建者**（无 z-index，无 transform/filter/opacity），所以 modal z-index 在根堆叠上下文比较。**单点改动即可修复**。

### 4.2 产品逻辑设计

**统一 modal 层级约定**：所有画布/编辑器 modal 用 `z-[80]`（与 EditorModal/DocEditModal 对齐）。

```
< z-70: NodeStyleBar
z-72:  弹层（style-popups 等）
< z-80: DocRefCard / DocEditModal / CanvasEditModal / EditorModal（统一）
z-100: 全局 toast
```

### 4.3 实现要点

**单行改动**：
```diff
// apps/web/src/features/kb/CanvasEditModal.tsx:60
- <div className="fixed inset-0 z-[60] flex items-center justify-center p-6">
+ <div className="fixed inset-0 z-[80] flex items-center justify-center p-6">
```

CanvasEmbed.tsx 内的 CanvasEditModal 同病同修（同一组件复用，自动受益）。

### 4.4 验证

- DevTools 选中 `<div class="fixed inset-0 ...">` → Computed z-index = 80
- 测试场景 A-E（见审计报告 E.1）

---

## 修复顺序与依据

| 顺序 | 问题 | 估时 | 依据 |
|------|------|------|------|
| **1** | 问题 4（z-index） | 2 分钟 | 一行修复；不修则问题 2 实施后的统一预览卡会被遮（独立块场景打开 CanvasEditModal 不显示） |
| **2** | 问题 3（IME） | 30 分钟 | 功能性阻塞：中文用户无法在画布新建的文档中输入内容，且影响范围覆盖问题 1+2 涉及的 EditorModal/DocRefCard 弹窗 |
| **3** | 问题 2（统一 UI） | 2-3 小时 | UI 一致性重构，依赖问题 4 修复完毕（预览可正常显示）+ 问题 3 修复完毕（弹窗内可输入中文） |
| **4** | 问题 1（顶部入口） | 2-3 小时 | UX 整合，依赖问题 2 的 LinkBlockPreview 组件可复用（CanvasLinkPicker 的预览密度 radio 需要 LinkBlockPreview） |

**总估时**：6-9 小时

---

## 实施分工

| Task | 谁做 | 理由 |
|------|------|------|
| 问题 4 + 问题 3 | 我（直接） | 小而关键，避免并行风险 |
| 问题 2 + 问题 1 | general-purpose agent | 大且相互依赖（共用 LinkBlockPreview 组件），独立串行实现 |

---

## 验收标准（最终 EARS）

| AC | 验收方法 | 通过标准 |
|----|----------|----------|
| AC-1.1 | 画布编辑态左上角出现"关联"入口 | 按钮可见，仅编辑态 |
| AC-1.2 | 点"关联" → 统一 picker 打开 | 含搜索/tab/内联新建/预览密度 |
| AC-1.3 | picker 内可同时创建文档和画布 | 两个并排按钮 |
| AC-2.1 | 独立块（gx-link-block）预览 UI 与节点角标（gxDocRef）一致 | header/footer/body 风格统一 |
| AC-2.2 | 独立块新增"编辑"入口（弹窗编辑源文档） | 之前缺失 |
| AC-3.1 | 在 EditorModal 内快速输入中文（"中文测试 ABC"×5） | 0 次 IME 中断 |
| AC-3.2 | DocEditModal 同样测试 | 0 次 IME 中断（共享修复） |
| AC-4.1 | 节点关联画布 → 点角标 → 点编辑 | CanvasEditModal 完全覆盖 DocRefCard |
| AC-4.2 | 节点关联文档 → 点角标 → 点编辑 | DocEditModal 完全覆盖（已正确，回归验证） |
| AC-4.3 | 三 modal 同 z-[80]，toast(z-100) 仍可覆盖 | 全局提示优先级保留 |