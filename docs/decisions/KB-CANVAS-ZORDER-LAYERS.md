# KB 画布·统一图层（z-index / z-order）管理

> 日期：2026-09-11
> 范围：知识库 Drawnix/Plait 画布（主画布、公开分享画布、弹窗内嵌套画布）
> 关联：KB-CANVAS-MODAL-LAYERING-FOCUS（浮层裁剪/层叠 token）、KB-EDITOR-ROUND-5（z-index 两段制）

## 需求

1. 顶部悬浮工具条始终在画布内最高层级，任何嵌入的关联文档/画布卡片、节点样式条、设置弹层都不得遮挡它；嵌套场景同样成立。
2. 画布内全部对象统一支持图层调整：基础几何、思维导图整体、嵌入的关联文档/画布块、文字、箭头/线条、图片。
3. 每个对象支持四种操作：上移一层 / 下移一层 / 置于顶层 / 置于底层，有清晰入口与操作反馈。
4. 嵌套画布内的图层调整不得影响外层顶部工具条的最高层级。

## 决策 1：新增画布常驻 chrome 层（z=75）

- `packages/design-tokens/src/layout.ts` 在画布内部层新增 `canvasChrome: 75`（沿用 <800 约束）。层级：
  `block 60 < badge 65 < card 68 < bar 70 < popover 72 < chrome 75`，全部仍 < 应用层（drawer400/modal800/canvasModal820/popover900/toast1000）。
- `apps/web/src/features/kb/kb.css` 用作用域 CSS 给每个 `.kb-canvas-wrap` 内的 drawnix 常驻工具条
  （`.draw-toolbar/.zoom-toolbar/.theme-toolbar/.pencil-mode-toolbar/.creation-toolbar`）设 `z-index:75`。
  规则作用域限定在单个 wrap，因此**嵌套画布的工具条只与同一 wrap 内内容比拼，各自独立成立**——
  子画布内部无论如何重排，其工具条永远在子画布内容之上；外层工具条在外层 wrap 内同样恒置顶。
- 这是普通 CSS（不经 Tailwind JIT 缓存），与此前 `.gx-z-canvas-*` 兜底同理，长驻 dev 漏发 utility 也不影响。

## 决策 2：四层级操作统一走 plait ZIndexTransforms

- 所有画布顶层对象在 `board.children` 是兄弟节点，渲染顺序即数组顺序。直接复用 `@plait/core` 的
  `Transforms.moveUp / moveDown / moveToTop / moveToBottom(board)`（ZIndexTransforms）：重排 children 数组、
  进撤销栈（⌘Z）、触发 onValueChange 自动上云、不区分元素类型（无类型白名单），因此对自定义 `gxLinkRef`
  关联块同样生效。
- `canvas-ops.ts` 新增：
  - `canApplyZOrder(board)`：编辑态且选区中存在 `board.canSetZIndex` 允许的顶层元素（默认恒 true）。
  - `applyZOrder(board, action)`：执行四选一并比较移动前后下标，返回是否真正变化（到顶/底时 false，供反馈）。
  - `selectElementAtClientPoint(board, clientX, clientY)`：右键命中测试（视口坐标→toHostPoint→toViewBoxPoint）。
    ⚠️ **2026-09-11 已订正**：初版用 `getHitElementByPoint`（类型偏向裁决，空心/透明框误选下层填充框），
    现改为纯叠序命中 `hitTopElementAtPoint`，详见文末"修订（2026-09-11 收口）"。
    命中嵌套子节点（脑图内部节点）时退回顶层祖先，再清旧选区+addSelectedElement。
- 思维导图子节点嵌在根 mind 元素 children 内（非顶层），不单独调层级；选中根脑图调整的是整张脑图——
  与 plait `canSetZIndex` 语义一致。

## 决策 3：入口（右键菜单 + 样式条 + 快捷键）

- 新建 `canvas/CanvasZOrderMenu.tsx`：编辑态在 wrap 捕获阶段监听 `contextmenu`（点 .island 工具条放行默认），
  命中对象先选中，再弹复用 `components/ui` 的 `ContextMenu`（portal 到 body，z-900，**不进裁剪层**），
  菜单为「上移一层 ⌘] / 下移一层 ⌘[ / 置于顶层 ⌥⌘] / 置于底层 ⌥⌘[」，到顶/底时禁用；执行后 toast 反馈。
  另在 wrap 捕获阶段绑四个快捷键（输入框/contentEditable 内不拦截）。
- `NodeStyleBar.tsx` 工具条首位加常驻「图层(layers)」按钮 + 同样的四操作 ContextMenu，
  使图片/纯文字等"无样式按钮"对象选中后也有图层入口。工具条宽 470→506。
- `CanvasEnhanceOverlay.tsx` 的选中资格由 shape/line/mind 放宽为 `isStyleBarEligible`
  （新增 image/text 守卫，见 types.ts），关联块本就是 geometry 已覆盖。
- 图标：`components/icons.tsx` 新增 layers/bringForward/sendBackward/bringToFront/sendToBack 五个自绘描边 SVG
  （遵循无 emoji、统一图标集约定）。

## 隔离保证（需求④）

- 图层菜单 portal 到 body（应用层 z-900），不属于任何 `.kb-canvas-wrap` 裁剪层；
  chrome 的 75 只在各自 wrap 内比拼。嵌套编辑器（CanvasEditModal→GxCanvas→enhance）有独立 wrap、独立
  CanvasZOrderMenu 监听，子画布重排只改子 board.children，既不触碰外层工具条层叠，也不改外层数据。

## 修订（2026-09-08）：修复"关联卡与普通图形两套层级"导致的置顶失效

### 根因（用户反馈：背景正方形"置于顶层"仍在关联画布之下）

- 普通图形是 plait 原子 `<svg class="board-host-svg">` 内 `.element-host` 中按 `board.children`
  **文档顺序**绘制的 `<g>`；而关联卡此前渲染在增强 overlay，是一张独立的、**固定 z-index:60** 的
  positioned HTML。
- 实测 Chromium：SVG 内部 `<g>` 的 `position:absolute` computed 为 `static`、`z-index` 不生效，
  因此任何单个 `<g>` 都无法穿出原子 SVG，与 wrap 内 HTML 卡按 z-index 交错。
  `Transforms.moveToTop` 只重排 SVG 内 `<g>` 顺序，普通图形永远压不过固定 z60 的卡——两套体系。

### 修法：关联卡用 foreignObject 注入元素自己的 `<g>`

- 关联块在数据层本就是普通 geometry rectangle（带 `gxLinkRef`，透明 fill/stroke），SVG 里本就有
  自己的 `<g plait-data-id>`。新增 `canvas/LinkBlockForeignObject.tsx`：创建一个 SVG
  `foreignObject`（内含显式 HTML 命名空间包裹 div），挂到该元素的 `<g>`，卡片 React 子树
  portal 进该 div。卡片就此成为 SVG 文档绘制序列的一部分，与普通图形**共用 `board.children`
  这唯一层级真源**。
  - 命名空间：必须先在 FO 内显式创建 HTML 命名空间 div 再 portal，否则 React 把 div 当 SVG 节点创建。
  - 已实测：plait `move_node`（ZIndexTransforms）整体移动元素 containerG（mountOnItemMove），
    FO 随 `<g>` 重定位；`set_node` 重绘只更新 `<g>` 内矩形、`<g>` 不重建，FO 存活。
- `GxLinkBlockView.tsx` 改为纯几何适配：以 points（viewBox 坐标/尺寸，FO 随视口自动缩放）驱动 FO，
  保留 header 拖拽 / resize 手柄 / 双击跳转 / 重命名 / 删除。
- 事件隔离（卡片进 SVG 后成为 plait 容器事件后代）：
  - `DrawnixCanvas.afterInit` 新增 `installLinkBoardGuards`：包装 board 的
    `pointerDown/dblClick/globalKeyDown/keyDown`，事件 target 在 `[data-gx-link-fo]` 内时跳过
    外层板处理。**只短路板方法、不做 DOM stopPropagation**——React18 合成事件委托在根容器，
    原生阻断会连卡片按钮的 React 事件一起杀死。
  - wheel 是 viewport-container 上的原生监听（非板方法），由 LinkBlockForeignObject 在卡片根
    addEventListener 阻断冒泡（不 preventDefault），内嵌只读子画布的滚轮不带动外层板。
  - 右键图层菜单 / 快捷键监听挂在 wrap 捕获阶段，先于上述隔离，卡片上的右键菜单与 ⌘] 等照常。
- `canvas-ops.ts` 新增 `selectLinkBlockAtPoint` 并在 `selectElementAtClientPoint` 前置调用：
  右键命中点落在 `[data-gx-link-fo]` 时，按 FO 上的 `data-gx-element-id`（拖拽期父 g 可能无 id，
  故写在 FO 自身）直接选中对应关联块（透明矩形不被 plait 几何命中测试识别）。
- 嵌套隔离：外层主工具条是 wrap 的直接 positioned 子元素(z75)，与 svg 互为兄弟；卡片内嵌子画布
  任何 z75 控件都被关在 FO 堆叠边界内，越不过 svg 去压外层主工具条（已实测）；且内嵌只读板工具条
  本就被 CSS 隐藏。编辑弹窗仍 portal 到 body（gx-z-canvas-modal），不受 FO 影响。
- 拖拽期**不**把 FO 移到 element-top-host：那会把 setPointerCapture 的 header 移出原位导致
  pointerup 丢失、拖拽无法结束。SVG 内无法 z-index 临时置顶，故拖拽期保持其持久绘制位置
  （=board.children 顺序），仅高亮——与 plait 原生拖拽语义一致。

## 验证（2026-09-11 真机）

- 顶部/缩放工具条 computed z-index=75；强制把一张关联块 transform 到工具条中心，elementFromPoint 仍命中工具条（toolbarOnTop=true）。
- 真实 CDP 右键脑图根节点 → 菜单 4 项全可用、z-900；点"置于顶层"，该 mind 在 board.children 中 index 3→9。
- 合成 ⌘[ 下移 index 9→8、⌥⌘[ 置底 →0，defaultPrevented 正确。
- NodeStyleBar 首位图层按钮真实点击弹同一菜单，5 个自绘图标渲染正常。
- 测试后用 board.apply(move_node) 将顶层顺序精确还原为测试前（matches=true），未污染数据。
- 5 包 typecheck 0 错；vite 全新 outDir 构建成功，产物 CSS 含 chrome z-75 规则。

## 修订（2026-09-11 收口）：图层操作的命中必须按"纯叠序"，不能用 plait 的类型偏向裁决

### 真正的用户症状

用户把一个框"置于顶层"后，重叠处仍被另一个框压住，toast 误报"已在最顶层"。早期"只是透明填充
透出底色"的解释被用户用**不透明灰框**截图证伪；逐帧真机复现后定位到根因不在重排本身，而在
**图层命令作用对象的命中选择**。

### 根因（源码取证，非推断）

- 数据层重排完全正确：`Transforms.moveToTop` 等走 `ZIndexTransforms → moveElementsToNewPath →
  NodeTransforms.moveNode`，ListRender 在 moved 分支调用 `mountOnItemMove`，对**同一个 containerG
  实例** `insertAdjacentElement` 重挂（只有 currentIndex===null 的删除才 destroy 重建）。
  重排收敛后 `board.children` 顺序 == `.element-host` 子 `<g>` 顺序 == 视觉叠序，三者一致
  （同步读可能滞后一帧，afterChange 后异步收敛）。**因此不需要也不应与库对抗去强制 appendChild。**
- 缺陷在旧 `selectElementAtClientPoint` 用的 `getHitElementByPoint`。其终点
  `@plait/draw getHitDrawElement` 的裁决**偏向元素类型而非叠序**：
  1. `getFirstFilledDrawElement` 沿命中列表找第一个"闭合且 `isFilled(fill)`"的元素并 `slice` 截断；
  2. 再在其中挑 text/line/image（无视层级）；
  3. 否则 `sortElementsByArea(...,'asc')` 取面积最小。

  矩形工具默认 `fill='none'`，关联卡承载几何更是 `fill/stroke=transparent`（视觉却是不透明 HTML 卡）。
  于是当一个空心/透明描边框或关联卡压在有填充的框之上时，在二者重叠内部右键，库会选到**下层填充框**，
  对它执行置顶——它本就在顶 → index 不变 → toast"已在最顶层"，用户视觉上瞄准的上层框纹丝不动。
  真机实锤（空心黑框 kxiAn 在填充红框 KKHGG 之上，重叠深处真实右键 → 选区=KKHGG 而非 kxiAn）。

### 修法：唯一叠序真源 + 逐元素几何命中（类型无关、可扩展）

`canvas-ops.ts` 新增并改用：

- `isTopElementHitAt(board, el, vb)`：只回答"该**顶层**元素是否覆盖此点"，不做多选裁决。
  draw 家族（geometry/image/arrow-line/vector-line/text）用库的 **非严格** `isHitDrawElement(board, el, vb, false)`
  ——非严格关掉了"空文本且未填充直接 false"，空心封闭框**内部**也命中；线仍走精确距离判定。
  脑图根（mind）及 draw 不认识/返回 null 的元素退回 `board.getRectangle` 包围盒包含判定。
  返回 `false` 表示明确判否，`null/undefined/异常` 才走包围盒兜底。
- `hitTopElementAtPoint(board, x, y)`：从 `board.children` **末尾向前**找第一个覆盖该点的顶层元素，
  即在所有命中者中取最大索引 = 视觉最上层。这是 Photoshop 式图层心智的唯一真源，对几何/文字/图片/
  箭头/矢量线/脑图整体/关联块统一生效；新增顶层类型只需让 `isTopElementHitAt` 能判定。
- `selectElementAtClientPoint` 改为：先 `selectLinkBlockAtPoint`（关联卡 HTML 走 data-gx-element-id），
  再 `hitTopElementAtPoint`；不再调用类型偏向的 `getHitElementByPoint`。
- **作用域刻意收窄**：纯叠序命中只用于图层命令的目标选择（右键菜单 / NodeStyleBar layers /
  ⌘ 快捷键，三者共用 `applyZOrder`）。**不改 plait 原生左键手势命中**——连线连接点吸附、resize 手柄、
  拖拽选择依赖库的几何命中，全局替换会破坏连线与手柄交互。

### 真机验证（agent-browser 端到端）

- 填充红框在上 / 空心黑框在上两种叠序，重叠深处真实右键 → 选区恒为 `board.children` 索引更大者
  （视觉/图层最上层），不再误选下层填充框。
- 快捷键 ⌥⌘] 派发到 `.kb-canvas-wrap` → 下层框正确翻顶，收敛后 data/DOM 顺序一致。
- 脑图根中心真实右键 → 包围盒兜底选中根 bCbpd（不再返回 null）。
- Test3 画布 7 张关联卡 FO 7/7 挂载、0 孤儿；右键卡面选中 FNCXf（原在最底）→ 置顶到末尾、FO 仍 7/7；
  测后 moveToBottom 还原，后端 content 数组顺序与原始逐 id 一致。
- 未命名画布清理测试矩形后持久化为 ccQfd/RYiHW/bCbpd。
- 5 包 typecheck 0 错；`rm -rf dist` 后 vite build 成功（10.44s）；dev 无 console error、无白屏。

---

## 修订（2026-09-11 收口②）：右键菜单与样式面板必须共用同一选区真源

### 症状

1. 右键图层菜单四项「有时」整体置灰、不可点。
2. 右键选中一个元素后，用浮动「元素设置」面板（NodeStyleBar，如填充色板）改样式**始终不生效**，
   或作用到了非所见元素；左键选中再改却正常。

### 根因：选区"双轨制"断裂

plait 有两套选区表示：

- **实时选区** = `BOARD_TO_SELECTED_ELEMENT` WeakMap。`getSelectedElements(board)` 纯读它；
  `addSelectedElement/clearSelectedElement` 经 `cacheSelectedElements` 写它，**不产生 op、不触发 onChange**。
  `PropertyTransforms.setProperty`、`applyZOrder`、`canApplyZOrder`、`readSelectionStyle` 全部读它。
- **React 快照选区** = canvas-context 的 `rt.selectedIds: string[]`，只在 `notify()` 的 rAF 回调里
  经 `syncSelection()` 从 WeakMap 同步；`notify` 由 DrawnixCanvas 的 onChange/onViewportChange 驱动。
  CanvasEnhanceOverlay 的 `selectedRects`（决定 NodeStyleBar **显隐/锚点/elements**）读快照。

右键 `selectElementAtClientPoint` 只调 `addSelectedElement`（写 WeakMap、不发 op、不 notify），
于是右键改选后 React 快照不更新：NodeStyleBar 不出现或仍锚在旧元素；而样式写入走实时选区——
两轨错位时"面板看着操作 A、实际写到 B 或无元素"。左键因 plait 手势会触发 onChange→notify，
快照能同步，所以左键路径正常。

「有时置灰」的真凶：在**画布空白处右键且当前无选区**时，`canApplyZOrder` 对空选区返回 false，
却仍弹出一个四项全灰的菜单。

### 修法（数据源 / 校验 / 状态更新三者统一）

- `canvas-ops.ts` 新增 `currentSelectedElements(board)`：统一从 WeakMap 读实时选区（容错），
  明确"实时选区是唯一真源，快照仅为重渲染版本号"。
- **NodeStyleBar 元素分组/计数/写入目标一律取实时选区**：`shapes/lines/mind*/noteCount/refCount/
  笔记 popover element` 改用 `currentSelectedElements(board)`（由 frame/selectedIds 驱动重算），
  不再用来自快照的 `elements` prop（该 prop 仅保留给 CanvasEnhanceOverlay 的显隐/锚点）。
  这使面板写入与 `readSelectionStyle`、`PropertyTransforms`、`applyZOrder` 严格同源。
- **CanvasZOrderMenu 右键选中后同一事件批次立即 `rt.refreshSelection()`**（= 立即 syncSelection），
  让样式面板显隐/锚点与本次右键选中同步出现，不必等下一次 onChange。
- **空白右键且无可重排选区时不再弹菜单**（`!hit && !canApplyZOrder(b)` 直接 return）——消除全灰菜单；
  命中顶层元素时 `canApplyZOrder` 必为 true（顶层兄弟默认可重排，仅脑图子节点 canSetZIndex=false，
  而右键只选顶层）。
- 删除两处临时探针（DrawnixCanvas 的 `window.__gxBoard`、CanvasZOrderMenu 的 `window.__gxRcLog`）。

### 真机验证（agent-browser CDP 真鼠标/真 contextmenu）

- 右键空心框 → 样式条**立即出现**（修复前 bar:false）、菜单四项 disabled=false/opacity=1；
  用面板把该框填充改为淡黄 `#FFF3CD`，精确落在该框，同区另两框不变。
- 再右键另一粉框 → 样式条跟随切换；面板改描边为蓝 `#1E90FF`，仅该框轮廓 path 变蓝（4px），
  前一框黄填充与第三框默认描边均不受影响（切换元素不串目标）。
- 画布空白右键且无选区 → 不弹菜单（菜单项计数 0）。
- 左键普通几何框 → 样式条照常出现（左键路径无回归）。
- 测试框删除并经防抖上云，API 回读顶层仅 ccQfd/RYiHW/bCbpd；5 包 typecheck 0 错；
  vite 生产构建 2131 模块成功（注：vite7 `emptyOutDir` 与本机 safe-delete shim 在 outDir>50 文件时
  冲突，属环境问题；用全新空 outDir 构建通过后再归位 `apps/web/dist`，tsc 阶段亦 0 错）。
