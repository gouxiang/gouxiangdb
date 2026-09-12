# KB 编辑器第五轮：关联嵌入架构统一（渲染 / 层级 / 公开分享 / 输入稳定性）

- 状态：已实现 + 已验收（typecheck 三包 0 错误；api 193 单测全绿；生产构建通过；真机回归通过）
- 日期：2026-09-08（实施与验收跨至 09-09 凌晨）
- 范围：`apps/web/src/features/kb/**`、`apps/web/src/components/ui.tsx`、`packages/design-tokens`、`apps/web/tailwind`、`apps/api/src/routes/public.ts`、`apps/web/src/api/client.ts`
- 前序：KB-EDITOR-ROUND-4（顶部关联入口 + LinkBlockPreview header 统一 + IME 5 守卫 + modal z-80）

---

## 0. 背景：为什么要做这一轮

第四轮把两类嵌入的 **header** 收敛到了 `LinkBlockPreview`，但 body、取数、弹窗层级、公开链路仍是分叉的，产生四个用户可感知缺陷。本轮要求"统一设计、定位根因，不打表面补丁"。

两种嵌入形态（ref 载荷完全同构，都是 `GxDocRef`，差异只在挂载位置）：

| 形态 | 数据字段 | 承载节点 | 渲染组件 | 尺寸来源 |
|------|----------|----------|----------|----------|
| A 独立块 | `geometry.gxLinkRef: GxDocRef` | 独立 rectangle 节点 | `GxLinkBlockView` | plait `points` |
| B 节点角标 | `geometry.gxDocRef: GxDocRef` | 任意几何节点上的字段 | `DocRefCard`（经 NodeBadges 展开） | localStorage |

---

## 1. 根因分析（均有文件/行号证据）

### 问题 1：两套 body 渲染，同文档呈现不一致

- `GxLinkBlockView.tsx:69-144` body 是把 markdown 用正则去格式后 `slice(0,200)` 的**纯文本摘要**；canvas kind 也只摘 `content`（对画布是 JSON 串，毫无可读性）。
- `DocRefCard.tsx:144-173` 才是完整渲染：doc → `renderMarkdown(content)`；canvas → `<DrawnixCanvas content readonly allowViewInteraction />`；含 loading / 404 / 无权限三态。
- 取数也分叉：`GxLinkBlockView.tsx:48` 是 `useDoc(publicToken ? undefined : docId)` —— **公开页直接传 undefined，查询被永久禁用**，body 永远停在"加载中…"（`:138-139`）。
- `DocRefCard.tsx:48-64` 有 internal/public 双通道，但 public query key 自带 `"ref-card"` 后缀；`CanvasEditModal`（`"embed-edit"`）、`DocEditModal`（`"ref-edit"`）各带后缀，**同一文档在卡/弹窗间不共享缓存**。
- 结论：应以 DocRefCard 的"完整内容 + 双通道 + 三态"为唯一基准，废弃 A 的摘要 body。

### 问题 2：分享弹窗被嵌入窗遮挡（z 值倒挂，非堆叠上下文隔离）

- ShareModal 用通用 `Modal`：`components/ui.tsx:447` 是 `fixed inset-0 z-50`，**无 createPortal**，DOM 停在组件树位置。
- 画布内编辑窗 `CanvasEditModal.tsx:60` / `canvas/DocEditModal.tsx:56` / `canvas/EditorModal.tsx:119` 均 `z-[80]`；关联卡 `DocRefCard.tsx:187` z-68、样式条 70/72、独立块 60、角标 65。
- `.kb-canvas-wrap`（kb.css:133-139）只有 `position:relative; overflow:hidden`，无 transform/filter/will-change/z-index → **不创建堆叠上下文**。画布增强层经 `canvas-context.tsx:168` portal 进该 wrap，与 ShareModal 同处根堆叠上下文，直接按 z-index 比拼 → 50 全员皆输。
- 野值：kb.css:164 只读遮罩 `z-index:9999`；drawnix.css 激光笔 `z-index:2022`。
- `packages/design-tokens/src/layout.ts:53-61` 已预留 `zIndex` token，但**全项目零引用**，Tailwind 未映射 zIndex，全部靠裸 `z-[68]`。

### 问题 3：外部分享时元素节点关联（gxDocRef）展不开

- 后端公开授权 `resolveShare`（`public.ts:65-87`）对子文档只放行分享根的 **parentId 文档子树**（`subtreeIdSet`）。画布的 gxDocRef/gxLinkRef 指向同知识库**任意关联文档**，几何上几乎不在子树内 → `PublicApi.getDoc` 返回 **404**（公开接口本身不要 JWT，故不是 401）。
- 无"按引用图授权"的接口：public.ts 只有 根 / 子树文档 / 子树保存 三个接口。
- 前端观感差异根因：B（DocRefCard）真的发公开请求 → 404 → 落错误卡；A（GxLinkBlockView）公开页根本不发请求 → 永久"加载中…"。两者都拿不到正文，只是错误暴露方式不同。
- 错误文案误导：`DocRefCard.tsx:150-157` 把公开页越界 404 显示成"内容已被删除"。

### 问题 4：弹窗内快速 ASCII 连打丢字（Plait window 键盘委托越界）

- 弹窗 DOM 经 `CanvasOverlayLayer` portal 进 `.kb-canvas-wrap`（`canvas-context.tsx:162-168`），是 Plait board 宿主的**子树**；board 的 window keydown 委托仍活跃。
- Plait 守卫 `hasInputOrTextareaTarget` **只豁免 INPUT/TEXTAREA，不豁免 contentEditable**（@plait/core）。
- Drawnix 全局快捷键插件在 `isMovingPointInBoard`（鼠标在板矩形内即真，弹窗盖在板上恒真）且非输入态时，对裸键 `h/v/m/e/p/a/r/o/t` 直接 `preventDefault()` 并切换工具。
- `@plait/draw` 的 `withDrawHotkey`：**单个几何图形被选中**（关联块本身是 geometry，打开弹窗前处于选中态，`.plait-board-attached` 内点击不清选区）时，对一切非虚拟可打印键 `preventDefault()` 并进入 `editText` → 数字 1-0 与其余字母也被吞。
- 与用户键位完全吻合：a-l 行丢 a/e/h/…，q-p 行丢 e/o/p/r/t，z-m 行丢 m，1-0 全丢。普通文档页无 board，window 上无这些委托，故正常。
- 已排除：防抖回灌（弹窗未接 useDocPersistence）、IME 守卫误伤（ASCII 不触发 composition，且组件每次新开重挂载 ref 复位）、onChange 身份（只造成无谓重渲染，聚焦期 innerHTML effect 有守卫不会重置）。

---

## 2. 统一架构设计

### 2.1 单一解析 hook：`useResolvedDoc`

新建 `apps/web/src/features/kb/hooks/useResolvedDoc.ts`：

```
useResolvedDoc(docId, { publicToken? })
  → 内部态：useDoc(docId)               queryKey ["kb","doc",id]
  → 公开态：usePublicDoc(token, docId)  queryKey ["kb","public",token,"doc",id]（去掉一切后缀）
  返回 { doc?: {id,kind,title,content}, isLoading, error, status,
         canEditSource, refetch }
```

- 统一缓存键：卡 / 弹窗 / 未来其它嵌入共用同一份 react-query 缓存。
- 公开态 docId 若不在分享范围，后端经新引用接口返回，见 §2.4。

### 2.2 单一 body 渲染基元：`RefEmbedBody`

新建 `apps/web/src/features/kb/canvas/RefEmbedBody.tsx`，入参 `{ resolved, refKind, reloadKey }`：

- loading → Spinner；error → 按 status 区分 404（已删除）/ 403（无权限）/ 不在分享范围（403 + publicToken）三态文案与图标；
- `kind==="canvas"` → `<div key={reloadKey}><DrawnixCanvas content readonly allowViewInteraction /></div>`（不传 enhance，无嵌套 overlay）；
- doc → `renderMarkdown` 的 `.md-preview`（样式与 DocRefCard 现状一致）；
- minimal 由外层 LinkBlockPreview 隐藏 body，本组件不感知。

### 2.3 单一面板组件：`RefEmbedCard`

新建 `apps/web/src/features/kb/canvas/RefEmbedCard.tsx`，组合 `useResolvedDoc` + `LinkBlockPreview`（壳保留）+ `RefEmbedBody` + 编辑弹窗（CanvasEditModal/DocEditModal）。

职责边界：
- 组件负责：取数、body 五态、标题优先级（`displayTitle > doc.title > ref.title 快照`）、编辑弹窗与保存后 `refetch + reloadKey`。
- 不负责：定位 / 尺寸 / 删除 / 关闭 / 重命名 —— 全部由调用点经 props 注入。

Props：

```
{
  ref: GxDocRef;                 // A/B 同构
  kbId?: string;
  publicToken?: string;
  canEdit: boolean;              // 来自画布 ctx（内部权限 / 公开 shareRole）
  // 容器（壳）
  containerClassName: string;    // 定位/z/圆角/阴影
  containerStyle: CSSProperties; // left/top/width/height
  dataAttrs?: Record<string,string>;
  onContainerPointerDown?; onContainerDoubleClick?;
  // header 能力（callback-present）
  canRename?; onRename?; onClose?; onDelete?; onRefresh?;
  jumpEnabled?; onJump?;
  // 尺寸调整
  trailingNode?: ReactNode;      // 右下角 resize 手柄（两调用点各自实现）
}
```

调用点收敛（`CanvasEnhanceOverlay.tsx`）：
- A：`flatten(board.children).filter(isLinkBlock)` → 渲染 `<RefEmbedCard ref={el.gxLinkRef} ...>`，定位用 `getElementScreenRect` + points 尺寸，resize 走 `resizeLinkBlock`，重命名 `setLinkBlockDisplayTitle`，删除 `removeLinkBlock`，双击跳转，z-60，dataAttrs `data-gx-link-block`。
- B：`DocRefCardNode` 解析 `readElementDocRef(el)` + nodeRect → 渲染 `<RefEmbedCard ref={...} ...>`，定位沿用"节点右侧、翻左兜底"，尺寸 localStorage + 现有 resize 手柄，onClose 退出 openRefNodeIds，z-68。

`GxLinkBlockView.tsx` 与 `DocRefCard.tsx` 两个文件**删除**（逻辑全部进入 RefEmbedCard；A/B 两调用点直接在 CanvasEnhanceOverlay 用 RefEmbedCard）。`LinkBlockPreview.tsx` 保留为纯 header+壳，不动其 API。

编辑弹窗内统一改用 `useResolvedDoc`，去掉 DocRefCard/GxLinkBlockView/两个 Modal 内 5 份重复双通道代码与各自 query 后缀。

### 2.4 公开引用图授权（后端）

`apps/api/src/routes/public.ts` 新增：

```
POST /api/public/s/:token/refs
  body: { docIds: string[] }          // 最多 50 个，去重
  resp: { results: Array<{ id, kind, title, content } | { id, status: "forbidden" }>, canEdit: boolean }
```

授权集合计算（只读）：
1. 起点集合 S = 分享根；若 `shareIncludeChildren`，并入 `subtreeIdSet(root)`。
2. 引用闭包：取 S 内所有 `kind="canvas"` 文档 content，JSON.parse 容错，递归遍历对象，收集任意 `gxDocRef.docId` / `gxLinkRef.docId`；新落入的 canvas 再展开一层，**深度上限 3、文档上限 50**（防图爆炸/越权枚举）。parse 失败的画布跳过（不致命）。
3. 请求 docIds ∩ 授权闭包 → 返回完整 `{id,kind,title,content}`；未命中给 `{id,status:"forbidden"}`，**不抛 404**（区分"已删除/不存在"与"不在范围"；不存在的 id 也统一回 forbidden，避免探测）。
4. 该接口永远只读，不开放子树外 content PUT；匿名编辑仍走现有 `:137` 子树接口。

前端：
- `PublicApi.resolveRefs(token, docIds)`；`useResolvedDoc` 公开态不直接调 getDoc，而走一个**按 docId 缓存的批量解析**：用 react-query `queryKey ["kb","public",token,"refs",docId]` + 一个模块级短窗口合并（同一 tick 内多个卡的 docId 合并成一次 POST）。为控制复杂度，首版可用每卡独立 `PublicApi.getRef(token, docId)` 的**单文档版**：

```
GET /api/public/s/:token/ref/:docId
  → 命中闭包: { doc: publicDoc-like, canEdit:false }
  → 未命中: 403 { error:"not_in_share_scope" }
```

> 实施取舍：本轮采用 **GET 单文档版**（与现有 getDoc 调用点同构、改动最小、缓存键天然按 docId）；批量 POST 留作性能优化（OPEN-DECISIONS 登记）。注意：单文档版内部仍需计算引用闭包（第 2 步），该计算每次请求执行；用"仅查画布 content"的有限查询 + 深度/数量上限控制成本。
- 从引用接口拿到的关联文档 **canEdit 恒 false**（只读可见）；编辑按钮仅在该 docId 属于可编辑子树时出现（即现有 getDoc 返回 canEdit=true 的情况）。RefEmbedCard 的 `effectiveCanEdit = canEdit(画布ctx) && source.canEdit`。

错误文案修正：403 + publicToken → 锁图标"该关联内容未包含在本次分享范围内"；真 404（内部态/文档确实删除）才显示"内容已被删除"。

### 2.5 全局 z-index 规范

在 `packages/design-tokens/src/layout.ts` 重排 `zIndex`（两段：画布容器内部层 ≤799；应用浮层 ≥800，必须 portal 到 body）：

```
// 画布容器内部层（portal 进 .kb-canvas-wrap，彼此比拼，不参与应用层）
canvasBlock 60, canvasBadge 65, canvasCard 68, canvasBar 70, canvasPopover 72,
// 应用浮层（createPortal 到 document.body）
drawer 400, modal 800, canvasModal 820, popover 900, toast 1000
```

落地方式：
- `packages/design-tokens/tailwind.ts`（gxTailwindConfig）的 theme.extend 增加 `zIndex` 命名映射（如 `gx-z-modal` 或直接映射 key）。实施时先读该文件现有 token 命名风格（颜色走 gx-* 前缀），zIndex 工具类命名与之保持一致，并在 apps/web/tailwind.config 已透传 extend 的前提下自动生效。
- 通用 `Modal`（ui.tsx:447）改为 **createPortal 到 document.body + z-modal(800)**。这是 ShareModal 遮挡问题的直接修复。
- 三个画布编辑弹窗（CanvasEditModal/DocEditModal/EditorModal）改为 **createPortal 到 document.body + z-canvasModal(820)**，彻底脱离画布堆叠上下文（同时配合问题 4 仍需键盘隔离，portal 本身不解决 window 委托）。
- 画布内块/卡/角标/样式条/弹层的裸 `z-[60/65/68/70/72]` 替换为 token 类。
- kb.css:164 只读遮罩 9999 → 纳入画布容器内部层（该遮罩是 .kb-canvas-wrap 内局部层，给一个内部最高但 <800 的值；因其选择器限定在 wrap 内，不会与应用 modal 比拼）。drawnix 激光笔 2022：enhance 模式不用激光笔，kb.css 内 `.kb-canvas-wrap .laser-pointer{display:none}` 收编。
- Popover（ui.tsx:554 fixed 已 portal）归 popover(900)；absolute 模式保持容器内局部。ContextMenu(ui.tsx:742 内联 zIndex:60) 归 popover(900) 并 portal 到 body。toast(ui.tsx:982 z-[100]) 归 toast(1000)。
- 约定（写入本契约 + 代码注释）：禁止给布局容器加 transform/filter/will-change；应用浮层一律 portal 到 body；新增浮层禁止裸 z-[数字]，必须用 token。
- 非 KB 模块现有 z-40/50/60（RecordDrawer、SearchDialog、PersonalCenterDrawer、FormulaEditorModal 等）本轮**不强制全量迁移**，只把会与 KB 弹窗同屏冲突的通用 Modal/ContextMenu/Popover/toast 纳入 token；其余登记为后续技术债，避免扩大回归面。

### 2.6 弹窗键盘隔离（问题 4 首选修复）

在三个编辑弹窗最外层容器加**捕获阶段**键盘隔离，阻止事件冒泡到 window 上的 Plait 委托：

```
onKeyDownCapture={(e)=>{ if (e.key!=="Escape") e.stopPropagation(); }}
onKeyUpCapture={(e)=>{ if (e.key!=="Escape") e.stopPropagation(); }}
```

- capture(window→target) 阶段在容器处 stopPropagation，冒泡阶段 window 上的 ahooks 委托不再收到；contentEditable 浏览器默认插字在分发前已定，不受影响。
- Escape 放行，交给各弹窗自己的关闭逻辑（EditorModal 现有 window keydown 监听 Escape；DocEditModal/CanvasEditModal 用遮罩/按钮关闭——放行 Escape 不影响它们，可顺带补 Escape 关闭）。
- 因弹窗同时 portal 到 body（§2.5），target 不再是 board 子树，但 Plait 委托挂在 window 且 contentEditable 不豁免，**portal 不替代 stopPropagation**，两者都要。
- 深层兜底（防止未来其它画布内 contentEditable 弹层漏网，如 NoteEditorPopover）：在 Drawnix 封装 `handleAfterInit`（DrawnixCanvas.tsx:254 拿到 board）包一层 board 的 `globalKeyDown`/`keyDown` 不可行（插件已注册）；更稳妥是在 `.kb-canvas-wrap` 根上注册一个 **capture keydown/keyup**：当 `e.target` 是 `HTMLElement && e.target.isContentEditable` 且 target 不在实际可编辑的板内文本编辑态时放行……该启发式易误伤板内原生文本编辑，**本轮不做**，仅以弹窗容器隔离为准；库侧 contentEditable 豁免登记为 OPEN-DECISION（建议给 @plait 提 PR / pnpm patch，与现有 @plait/draw patch 同级评估）。

---

## 3. 实施顺序（避免文件争用）

1. **基线 A（后端 + 取数契约）**：public.ts 新增 `GET /s/:token/ref/:docId` 引用闭包授权；client.ts 增 `PublicApi.getRef`；新建 `useResolvedDoc`。独立文件，可先落地并单测。
2. **基线 B（z-index token + 通用浮层 portal）**：design-tokens layout.ts + tailwind 映射；ui.tsx Modal/ContextMenu/Popover/toast token 化；kb.css 遮罩/激光笔收编。
3. **核心重构（前端嵌入统一）**：RefEmbedBody + RefEmbedCard；CanvasEnhanceOverlay 两调用点收敛；删除 GxLinkBlockView/DocRefCard；CanvasEditModal/DocEditModal/EditorModal 改用 useResolvedDoc + portal body + token 类 + 键盘捕获隔离。
4. 全量 typecheck、api 单测、前端构建；真机回归。

> 步骤 1/2 文件不重叠，可并行；步骤 3 必须在 1、2 合入后由单一执行者完成（同批文件多）。

---

## 4. 验收标准（EARS）

| AC | 场景 | 期望 |
|----|------|------|
| AC-01 | 同一 doc 分别以 A 独立块、B 节点角标嵌入 | 两者 body 内容、样式、loading/错误态完全一致；doc 显示完整 markdown，canvas 显示可平移缩放的只读画布（非 JSON/非 200 字摘要） |
| AC-02 | A 独立块在公开分享页打开 | 能经引用接口取到正文并完整渲染（不再永久"加载中…"） |
| AC-03 | 公开页点开 B 节点角标关联（关联文档在引用闭包内） | 正常展开完整内容，只读，无编辑按钮（除非在可编辑子树） |
| AC-04 | 公开页打开不在分享范围的关联 | 显示锁图标 + "未包含在本次分享范围内"，不显示"已被删除"，不报错崩溃 |
| AC-05 | 画布页打开 ShareModal | 分享弹窗在最上层，不被 DocRefCard/样式条/任何 z-80 嵌入窗遮挡；点遮罩/关闭正常 |
| AC-06 | 弹窗内 contentEditable 快速连打 asdfghjkl / qwertyuiop / zxcvbnm / 1234567890 | 零丢字，逐字一致；`defaultPrevented` 对这些键为 false |
| AC-07 | 弹窗关闭后在画布按 h/v/r | 画布快捷键行为不变（隔离只在弹窗打开期生效） |
| AC-08 | 弹窗内 Cmd/Ctrl+B、I、Z、斜杠菜单、@提及、Enter 分块、Backspace 合并 | 全部正常；Esc 能关弹窗 |
| AC-09 | 引用闭包 3 层/50 文档上限 | 超出不报错、不泄露范围外内容；恶意构造环不致死循环 |
| AC-10 | 全仓 grep | 画布浮层无裸 z-[数字]（token 化）；GxLinkBlockView/DocRefCard 已删，无残留 import |
| AC-11 | 构建/测试 | 5 包 typecheck 0 错误；api 单测全绿（新增引用闭包用例）；web 生产构建通过 |

## 5. 回归检查范围

- 画布：插入/删除/拖拽/缩放独立块；节点角标开关、多开、跟随定位/翻左；minimal/full 切换；块重命名；跳转；refresh。
- 弹窗：DocEditModal/CanvasEditModal/EditorModal 三条入口（独立块编辑、角标卡编辑、新建即编辑）；保存后卡片 refetch + 画布 reloadKey；中文 IME 输入（回归第四轮守卫）。
- 分享：内部页 ShareModal；公开页 doc/canvas 根、子树文档、画布内 A/B 两类关联、越界关联、viewer/editor 两种 shareRole。
- 层级：ShareModal 与 NodeStyleBar/色板弹层/关联卡/编辑窗同屏；Popover/ContextMenu/toast/抽屉不被遮、不穿透；滚动锁定。
- 普通文档页 markdown 编辑、快捷键（确认全局 Modal portal 化无副作用）。

## 6. OPEN-DECISIONS

- `performance/public-refs-batch`：单文档 GET 引用闭包每次重算，画布上关联很多时可能 N 次请求 + 重复闭包计算。后续改 POST /refs 批量 + 服务端按 token 短缓存。触发条件：单画布关联 >15 出现可感延迟。
- `plait-contenteditable-exemption`：库侧给 hasInputOrTextareaTarget 增加 isContentEditable 豁免（提 PR 或 pnpm patch）。在落地前以弹窗捕获隔离兜底。
- `zindex-non-kb-cleanup`：非 KB 模块旧 z-40/50/60 全量迁移到 token，列入技术债，本轮不动。

---

## 7. 实施记录与偏差（落地后回填）

### 7.1 实际文件变更

后端 / 共享：
- `apps/api/src/routes/public.ts`：新增 `collectRefDocIds`、`buildShareReferenceClosure`（BFS，深 3、≤50 文档、防环、JSON.parse 容错）与路由 `GET /s/:token/ref/:docId`（子树内随 shareRole；仅引用闭包内只读 canEdit=false；皆不在 403；已删 404）。
- `apps/api/src/routes/__tests__/public.test.ts`：13 用例（全量 193 单测通过）。
- `apps/web/src/api/client.ts`：`PublicApi.getRef`。
- `apps/web/src/features/kb/hooks/useResolvedDoc.ts`：内部 useDoc / 公开 getRef 双通道，缓存键统一（去后缀）。
- `apps/web/src/features/kb/hooks/useModalKeyboardGuard.ts`：window 原生捕获监听，仅隔离"无修饰单字符可打印键"。
- `packages/design-tokens/src/layout.ts` + `tailwind.ts`：zIndex token；Tailwind 用 `plugin(addUtilities)` 注册真实 `.gx-z-*`（见 7.3）。

前端画布：
- 新建 `canvas/RefEmbedBody.tsx`（五态 body）、`canvas/RefEmbedCard.tsx`（唯一取数+header+body+弹窗）。
- `GxLinkBlockView.tsx` / `DocRefCard.tsx` 瘦身为纯几何/尺寸适配层（**未删文件名**，见 7.2）。
- `CanvasEditModal.tsx` / `canvas/DocEditModal.tsx` / `canvas/EditorModal.tsx`：useResolvedDoc + `createPortal(document.body)` + `gx-z-canvas-modal` + useModalKeyboardGuard；DocEditModal onChange 改 useCallback。
- `components/ui.tsx`：Modal/ContextMenu portal 到 body（z-800/900），Popover fixed z-900，toast z-1000。
- `kb.css`：只读遮罩 9999→780（容器内部层）；收编激光笔。

### 7.2 偏差：保留两个适配层文件名（相对 §2.3"删除"）

不把两套定位/缩放逻辑搬进 CanvasEnhanceOverlay，而是保留 GxLinkBlockView / DocRefCard 为薄适配层、把取数+内容+弹窗收敛进 RefEmbedCard。达成"唯一渲染组件"目标且总装文件零改动、回归面更小。CanvasEnhanceOverlay 的调用点与 props 保持不变。

### 7.3 偏差：Tailwind 用 plugin 注册 `.gx-z-*`

`theme.extend.zIndex` 键会被 Tailwind 固定加 `z-` 前缀，只能生成 `.z-gx-z-modal`，无法产出契约要的 `.gx-z-modal`。保留 extend 映射外，另用 `tailwindcss/plugin` 的 `addUtilities` 注册同名真实 utility（值仍取自 zIndex 常量），web tailwind.config 透传 plugins。

### 7.4 P0 坑（真机首屏即崩，必须留档）

初版 RefEmbedCard 的 prop 命名为 `ref`。**普通函数组件（非 forwardRef）上的 `ref` 会被 React 特殊拦截、不进 props**，导致解构出的关联载荷恒 undefined、`ref_.docId` 抛错，所有含关联块的画布首屏整页被 ErrorBoundary 接管（typecheck 不报错，只能真机暴露）。已将 prop 改名为 `gxRef` 并在类型处加注释。教训：自定义数据 prop 禁止用 `ref`/`key` 等保留名。

### 7.5 偏差：键盘 guard 从 React capture 改为原生 window-capture

原方案在弹窗 div 用 `onKeyDownCapture/onKeyUpCapture` 无条件 stopPropagation，会连带阻断编辑器挂在 contentEditable 上的 React 合成按键处理（斜杠菜单/@提及等）。改为 `useModalKeyboardGuard`：在 window **原生捕获**阶段，仅当 target 在本弹窗内且为可编辑元素、且按键是无 Ctrl/Meta/Alt 的单字符键时 stopPropagation；Enter/Backspace/Delete/方向/Tab/Esc 与一切快捷键组合放行。原生 window-capture 早于且独立于 React root 委托，故只挡住 window 链上更后的 Plait 委托，不影响编辑器自身 React 处理，也不 preventDefault（默认插字照常）。

### 7.6 真机 / 端到端验收（agent-browser + curl，账号 verify@gouxiang.local）

- 打开含关联的画布：修复前整页"渲染失败 / reading 'docId'"；修复后 `.kb-canvas-wrap` 正常，6 个独立块全渲染，正文为**完整 markdown**（非 200 字摘要）。
- ShareModal：portal 到 body、z-800，视觉与命中测试均盖在关联块(z-60)之上。
- 弹窗输入：聚焦 contentEditable 后派发 h/v/m/e/p/a/r/o/t/1/0 等裸键，`defaultPrevented` 全为 false（修复前被 Plait 拦截即丢字）；guard 不影响带修饰键。
- 公开引用闭包（临时开 Test2 匿名 viewer 分享，验完已还原 shareEnabled=0/shareToken=''）：
  - 旧 `GET /doc/:id` 取非子树关联 → 404（语义保留）；
  - 新 `GET /ref/:id` 取关联 doc → 200 完整正文 canEdit=false；取跨画布引用 Test3 → 200；未被引用文档 → 403；
  - 匿名浏览器打开 `/s/:token`：6 块全部经引用闭包取到真实正文，无"加载中"/无权限态。
- 门禁：design-tokens/web/api 三包 typecheck 0 错误；api 193 单测全绿；`rm -rf dist && build` 成功，产物 CSS 含 `.gx-z-canvas-modal` 与 `z-index:800`。
- 运维注意：dev API 是常驻 tsx（非 watch），新增路由需重启后端（参照 scripts/dev-up.sh restart）。

