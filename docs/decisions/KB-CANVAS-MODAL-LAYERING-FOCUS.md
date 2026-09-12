# KB 画布·弹层层叠 / 焦点 / 快捷键作用域统一

> 日期：2026-09-10
> 范围：知识库画布（Drawnix/Plait）及其关联嵌入、所见即所得文档编辑器
> 关联：KB-EDITOR-ROUND-5（z-index token 两段制）、KB-CANVAS-PUBLIC-REF-EXPAND、KB-CANVAS-EMBED-RESIZE

## 背景

系统性排查并修复四个相互关联的问题，共同主线是**弹层与底层画布之间的层叠上下文、DOM 事件冒泡/拦截、焦点归属、键盘快捷键作用域**：

1. 画布浮层溢出可视框体（尤其嵌套进弹窗/分栏时）。
2. 关联**文档**弹窗内按 Cmd/Ctrl+S，却下载了 `.drawnix` 文件（保存事件穿透到背景画布）。
3. 弹窗内编辑**嵌套画布**只有最初始 drawnix 功能，后续画布增强全部缺失。
4. 文档中预览/原子块上下悬停热区插入空行后不显示闪烁 caret（实际能输入）。

## 决策 1：画布浮层从「浏览器视口系 fixed」改为「裁剪层本地系 absolute」

### 根因

- `.kb-canvas-wrap` 虽有 `overflow:hidden`，但画布浮层（block/badge/card/bar/popover）全部 `position:fixed`。
- 依据 KB-EDITOR-ROUND-5 的约束，wrap 被禁止加 transform/filter/will-change（那会让 Plait 视口坐标失配），所以 wrap **不是 fixed 后代的包含块**，其 `overflow:hidden` 对 portal 进来的 fixed 浮层无效。
- 浮层坐标来自 `getElementScreenRect`（浏览器视口系），钳制边界写死 `window.innerWidth/innerHeight`。当画布只是视口的一个子区域（左侧 240px 侧栏、弹窗内嵌 1152×491 小画布）时，浮层以整个浏览器窗口为界，必然溢出所在框体。

### 方案（双保险）

在 `canvas-context.tsx` 中：

- `CanvasBoardProvider` 新增对容器的几何测量：`viewport { origin:{x,y}, width, height }`，由 ResizeObserver + 每帧 `notify` + window resize 维护。
- 新增运行时换算：`toLocalX/toLocalY(clientX)`、`getLocalRect(element)`（元素视口包围盒 → 裁剪层本地包围盒）、模块函数 `clampToViewport(...)`。
- `CanvasOverlayLayer` portal 包裹层改为 **`.kb-canvas-overlay`：`position:absolute; inset:0; overflow:hidden; pointer-events:none`**，既是内部浮层的包含块（软钳制），又是硬裁剪兜底；交互浮层按语义类（`.gx-link-block/.gx-z-canvas-card/.gx-z-canvas-bar/.gx-z-canvas-popover/.gx-canvas-link-entry`）单独 `pointer-events:auto`，角标层 NodeBadges 自带 none+内层 auto 保持命中区最小。

浮层统一改造：

- `fixed` → `absolute`；坐标在总装出口（CanvasEnhanceOverlay）统一 `getLocalRect` 转本地系，子组件不感知。
- 所有钳制边界从 `window.innerWidth/innerHeight` 改为 `rt.viewport.width/height`（NodeStyleBar 工具条/PopoverWrap、PopoverShell、MindMapShapePopover、DocRefCard）。
- 全屏编辑弹窗（EditorModal/CanvasEditModal/DocEditModal）仍 portal 到 `document.body`、仍 `fixed inset-0`，不进裁剪层——它们本就需要覆盖整屏。
- CanvasPreviewToolbar（版本历史快照抽屉内）不在增强裁剪层，保持 fixed 不变。
- CanvasLinkEntry 下拉选择器复用通用 `Popover fixed`（portal 到 body），属临时菜单、允许脱离框体，不裁剪。

### 层级结论

- wrap 仍是 `position:relative`，裁剪层不新建堆叠上下文（不设 z-index），内部 z-60~72 浮层与 drawnix 控件的既有比拼关系不变。
- 应用层 modal 800+/canvasModal 820/popover 900/toast 1000 维持 KB-EDITOR-ROUND-5 两段制。

### 回归（2026-09-10 当晚）：fixed→absolute 后"节点设置/关联/素材/脑图设置全消失"

**现象**：裁剪层改造落地后，选中几何/素材/思维导图节点，NodeStyleBar 样式条、各设置弹层看似消失、不可点；左上角关联入口亦被压。

**排查链（机器证据）**：
1. 组件/入口/引用**均未被误删**——真实 CDP 鼠标选中脑图根节点后，NodeStyleBar 实际已渲染（11 个按钮、display:flex、visibility:visible），DocRefCard 关联卡、CanvasLinkEntry 入口都在 DOM 中。
2. 样式条 `getComputedStyle().zIndex === "auto"`（应为 70），被 drawnix 自带 island 工具条 / 关联卡按绘制顺序压住。
3. 递归运行时样式表 + 直接读编译后 index.css 文本：Tailwind plugin `addUtilities` 注册的整批 `.gx-z-canvas-*` **一条都没产出**，而同 config 的 `theme.extend` 工具类（`.bg-gx-surface`/`.h-8` 等）正常。
4. `tailwindcss -c tailwind.config.ts` **全新编译正常产出** `.gx-z-canvas-bar{z-index:70}`；清 `apps/web/node_modules/.vite` 并重启 dev 后，运行时 CSS 恢复产出 → 根因是**长驻 vite dev 的 Tailwind/PostCSS 增量状态漏发 plugin utilities（陈旧缓存），非代码缺陷**。
5. 为何此前没暴露：旧浮层是 `position:fixed`，即使 z-index 缺失也靠 fixed 的绘制顺序天然压在普通内容之上；改成裁剪层内 `absolute` 后绘制顺序改由 DOM/层叠决定，缺失的 z-index 立刻暴露。

**修复（保留裁剪效果的前提下）**：
- 清 `.vite` 缓存并干净重启 dev，运行时恢复生成工具类。
- **代码层加固**：在 `kb.css`（普通 CSS，不经 Tailwind JIT 缓存）内，对 `.kb-canvas-overlay` 作用域显式再声明一次 block60/badge65/card68/bar70/popover72 的 z-index，特异性 (0,2,0) 高于工具类 (0,1,0)、同值不冲突，确保即便长驻 dev 再漏发工具类，画布内部层叠也永不退化。作用域仅限裁剪层，不触碰 portal 到 body 的应用浮层，故不影响决策 2 的快捷键隔离与决策 3 的统一装配。
- 生产构建 CSS 中可见工具类与兜底各一份，双保险成立。

## 决策 2：弹窗保存快捷键在 window 捕获阶段统一收口

### 根因

- `@plait-board/react-board` 用 ahooks `useEventListener("keydown")`（未指定 target → 绑 **window、bubble**），每个 `<Board>` 一份。
- Drawnix 插件的 `globalKeyDown` 无条件先执行、无焦点/只读守卫：mod+s → File System Access / `<a download>` 保存 `<时间戳>.drawnix`。
- 弹窗 createPortal 到 body，按键路径 window→document→body→modal，**不经过**底层 `.kb-canvas-wrap`，所以画布自身的 wrap 捕获拦截收不到弹窗里的按键。关联画布弹窗无此问题仅因其内部编辑器结构不同，属巧合而非正确隔离。

### 方案

`hooks/useModalKeyboardGuard.ts`：在 **window 捕获阶段**注册 keydown/keyup，判断 target 是否在 modal root 内：

- modal 内的 Cmd/Ctrl+S → preventDefault + stopPropagation + 调注入的 onSave（仅保存该弹窗文档）。
- modal 内可编辑目标的无修饰打印键 → stopPropagation 做打字隔离，防 Plait window 委托吞键。

DocEditModal / CanvasEditModal / EditorModal 统一接入第三参 onSave（带 saving/loading/权限禁用判断）。

## 决策 3：GxCanvas 统一画布装配入口

### 根因

各调用点各自拼 `<DrawnixCanvas>` props；主画布传了 `enhance`（关联块/注释角标/样式条/插入入口全套），而嵌套编辑弹窗 CanvasEditModal 漏传 → 嵌套画布只剩最初始 drawnix。

### 方案

新增 `canvas/GxCanvas.tsx` 作为「完整能力画布」唯一推荐入口，把身份上下文（kbId/publicToken/currentDocId）+ 交互模式（canEdit）→ `readonly/allowViewInteraction/enhance` 的拼装收敛一处。

- 主画布（CanvasEditorPage）、公开分享画布（PublicSharePage）、嵌套编辑（CanvasEditModal）全部改走 GxCanvas。
- `DrawnixCanvas` 仍负责「一块画布如何初始化/只读手势」；`CanvasEnhanceOverlay` 是「我方画布能力」唯一来源。
- 纯只读小预览（RefEmbedBody 卡片内嵌、文档 CanvasEmbed、历史快照）刻意仍用裸 `DrawnixCanvas readonly allowViewInteraction`（不带 enhance），避免「卡片里再开卡片」的递归浮层。
- 未来新增画布能力只需加进 CanvasEnhanceOverlay/canvas-ops，所有 GxCanvas 实例自动获得。

## 决策 4：空段落程序化聚焦的可渲染锚点

### 根因

悬停热区 `.kb-wy-prev-zone/.kb-wy-next-zone` 是 `contentEditable=false + mousedown preventDefault`，点击后 `insertParagraphBefore/After` 在 rAF 里对新空段落 `placeCaretStart`。但空 contentEditable 零子节点（无 `<br>`、无文本节点），`selectNodeContents+collapse` 把 Range 锚到元素节点(offset 0)而非文本节点；从编辑器外部程序化 focus 时 Chrome 不建立活跃编辑会话、不绘制 caret（selection 有效，故敲键能写）。

### 方案（WysiwygEditor.tsx）

- `ensureCaretAnchor(el)`：空元素先 `appendChild(<br>)` 作为可渲染锚点（contenteditable 空行标准占位）。
- `placeCaretStart/End` focus 后补锚再落 Range，并经 `reaffirmCaret` 在连续两帧二次确认——第一帧可能早于 React 提交 focused 状态（Editable 同步 effect 尚未放弃 innerHTML 覆写），第二帧 focus 引发的重渲染已落地、effect 已因 focused=true 跳过，再校准一次稳定显示 caret；若用户已开始打字（出现文本节点）则不打断。
- 一次性收敛所有「外部→空段落」入口：热区插入、appendParagraph、方向键跳块、删除邻居落焦等。
- 不污染保存：`htmlToInlineMd` 中 `<br>`→`"\n"`，外层 `.trim()` 把孤立 `<br>` 归一为 `""`；失焦后 Editable DOM 同步 effect 用空 html 自愈回零子节点。

## 验证（真机，verify@gouxiang.local）

- 问题1：主画布 overlay 与 wrap 几何完全重合（1040×584，origin x=240=侧栏宽），7 张关联块全部 absolute 且无溢出；嵌套编辑器 overlay（1152×491，origin 64,97）与框体重合，越界关联卡被 overflow:hidden 硬裁剪。
- 问题2：文档弹窗内对编辑区派发 Cmd+S，File System Access 与 `a[download]` 探针均为 0，弹窗走云端保存后关闭并提示「已保存」。
- 问题3：嵌套编辑器 wrap 为 `readonly=0 / data-enhance=1 / overlay / 关联入口` 全 true，与主画布一致；卡片内只读小预览（242×106）仍刻意无 enhance。
- 问题4：热区 mousedown 后新空段落成为 activeElement、selectionType=Caret 落入其中、childNodes 含 BR；输入落点正确。
- 门禁：5 包 typecheck 0 错误；vite build 2129 模块成功（dist prepareOutDir 的 safe-delete 拦截为已知环境限制，改用全新 outDir 验证通过）。
