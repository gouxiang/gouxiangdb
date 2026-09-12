# GouXiangDB-v2 全量功能系统性深度排查报告

- 日期：2026-09-11
- 范围：画布与图层层级（重点）、文档/块编辑器与画布嵌入、智能表格/数据库、后端事务/鉴权、状态同步与公共组件
- 方法：源码逐行梳理（操作路径/事件绑定/渲染时序/层级计算/数据同步）+ agent-browser 真机暴力测试（快速连点、混合命令、空状态、切换交叉触发）+ node/API 数据实证
- 状态：**仅记录与定位，尚未改业务代码**（按要求先统一记录，随后统一修复）
- 严重度：P0=数据错误/越权/不可用；P1=功能错误/明显失真/数据竞态；P2=体验/性能/边界

---

## 一、总体结论

- 画布主链路（选择、样式、图层 4 命令、关联卡 FO 守持、选区双轨同步）在本会话前两轮修复后表现稳定：**图层命令确定性生效，未复现"偶发失效"**；8 个零延迟混合图层命令后无丢元素/重复 id/崩溃，顺序收敛为合法排列。
- 本轮新发现的问题集中在 4 类：
  1. **数据正确性**：日期筛选 gt/lt 等恒 false（P1，已实证）、多选按选项 id 存储但筛选用名称（P1）。
  2. **并发/竞态**：保存无版本号乱序覆盖（P1）、checkbox 单击与双击翻转重复 PATCH（P1）、SQLite 整 JSON 覆盖无重试（P1/P2）。
  3. **画布嵌入/预览一致性**：关联卡文档预览里的 `canvas-embed` 恒为空占位（功能缺失，P1）；MarkdownEditor 预览独立 root 泄漏（P1）；只读"增强板"仅靠事件拦截、无数据层只读（P1）；嵌入预览无 fit（P2）。
  4. **事务/健壮性/性能**：CSV 导入无事务、CSV 公式注入、多类多写操作无事务、全表加载+全量 hydrate 无分页（大数据量 P1）、NodeStyleBar 按钮 ref id 重复（P2）、render 期 setState（P2）等。
- 截图"三角形盖住文档正文 + 右侧游离极小图形"：现版本对【内嵌几何】有四层 `overflow:hidden`（`.kb-canvas-wrap`/`.plait-board-container`/`svg`/嵌入外层），编辑态实测几何无法外溢。最可能的真实出口是 **body 挂载/独立 root 的浮层或泄漏实例**（见 C-2/C-3），需在统一修复后按"编辑→切预览反复多次 + 关联卡预览"路径回归确认。

---

## 二、问题清单（按严重度）

### P0
- 本轮未发现可直接利用的越权/P0（鉴权 RBAC、bulk 写 first.tableId 收敛、link 目标校验、路径穿越拦截均在位）。下列 P1 中的"只读可写"在分享只读场景实质接近 P0，列为最高优先级。

### P1

#### D-1 日期/日期时间字段的 gt/lt/gte/lte 筛选恒为 false（数据错误，已实证）
- 位置：`packages/shared-types/src/filter.ts:43-50`（`toNumber`）、`:158-181`（gt/lt/gte/lte）。
- 根因：数值比较对字段值与字面量统一 `Number(text)`；`Number("2026-09-11")=NaN`、`Number("2026-09-11T08:00:00.000Z")=NaN`（node 实证两者均 NaN）→ toNumber 返 null → 四个比较运算符 `return false`。日期/日期时间字段的"晚于/早于/区间"筛选结果全错（被静默过滤为空）。
- 影响面：前端 grid 筛选与后端 `api/domain/filter.ts`（re-export 同一引擎）共用，所有 base 的日期筛选；同函数也影响"匹配字段"日期 vs 日期。
- 修复方向：比较前按字段类型把日期值与字面量规范为可比时间戳（date 用 UTC 当日 0 点，datetime 用 ms），不要走 `Number()`。

#### D-2 multiSelect 存选项 id，筛选 contains/isAnyOf 按名称输入，永远匹配不到
- 位置：存储 `records.fields[fieldId]=[option.id,...]`；筛选值来源 `apps/web/src/features/grid/FilterPanel.tsx:35`（仅 singleSelect 给 id，multiSelect 未做 id 映射）；匹配 `packages/shared-types/src/filter.ts:81-90,183-196`（arrayContains/arrayContainsAny 按 title/文本）。
- 根因：multiSelect 单元格存 id，筛选字面量是选项名称，两者永不相等/不包含。
- 影响面：多选字段的"包含/属于任一"筛选；前后端共用。
- 修复方向：FilterPanel 对 multiSelect 也用 option.id 作筛选值（或筛选引擎对多选字段把 id→name 归一后再比）。

#### S-1 保存无版本号/无在途互斥，自动+手动/多标签可乱序覆盖（last-write-wins）
- 位置：`apps/web/src/features/kb/useDocPersistence.ts:59-87,106-110`；后端 `PUT /api/kb/docs/:id/content`（apps/api/src/routes/kb.ts:403 起）无 ETag/版本字段。
- 根因：`saving` 标志只驱动状态，不阻止并发 `persist`；1200ms 自动 PUT 在途时 ⌘S 再发一个 PUT；两个响应乱序返回，旧 JSON 后到即覆盖新内容（多标签同理）。
- 影响面：文档与画布所有编辑（共用本 hook）。
- 修复方向：前端串行化（在途 PUT 合并 latest，结束后只发最新一次）；后端加 content 版本号/updatedAt 乐观锁（冲突 409）。

#### C-1 只读"增强板"只靠事件拦截，库层无只读；存在绕过写路径
- 位置：`apps/web/src/features/kb/DrawnixCanvas.tsx:220-258`（wrap 捕获拦 pointer/key）、`:327-335`（setReadOnly 调用全静默 catch，@plait/core 0.89.2 无只读 API）、`canvas/GxCanvas.tsx:65-71`（viewer 板 options.readonly 恒 false）。
- 根因：板实例本身可写，只读完全依赖"在 wrap 捕获阶段拦住手势/按键"。任何不经 wrap pointerdown 起手的路径（焦点在 body 时的板级 globalKeyDown 删除/快捷键、拖入文件、未来新增窗口级入口）都会真实改库并触发 onValueChange。
- 影响面：公开分享只读、历史版本预览、嵌入只读预览——只读一致性（用户重点关切"显示与交互失真"）。
- 修复方向：只读时在数据写入口统一拦截（封装 onValueChange/afterInit 后封板，或在 handleChange/onContentChange 只读态直接丢弃 + 还原），不只依赖 DOM 事件；并复核焦点在 wrap 外时的删除键。

#### C-2 关联卡/文档预览里的内嵌画布（canvas-embed）恒为空占位（功能缺失）
- 位置：`canvas/RefEmbedBody.tsx:46-51`（doc 分支 `dangerouslySetInnerHTML(renderMarkdown(content))`）；`kb/markdown.ts:148-150`（仅产出 `<div class="md-canvas-embed" data-canvas-doc>`）；增强器 `kb/enhanceEmbeds.ts` 只在 `MarkdownEditor.tsx:122-130`（mode=preview）调用。
- 根因：RefEmbedBody 的 HTML 字符串路径不经过 MarkdownEditor 的预览 effect，占位永不被挂载成 CanvasEmbed → 在画布里关联一篇"内含画布引用"的文档时，预览该处是空白 220px 块（kb.css:97 仅给 min-height）。
- 影响面：画布关联卡 A/B 两形态、画中画/文档中画布的递归引用预览。
- 修复方向：RefEmbedBody 渲染 markdown 后，对其容器补跑一次 enhanceCanvasEmbeds（或在 React 树内用组件而非 dangerouslySetInnerHTML 渲染嵌入块）。

#### C-3 MarkdownEditor 预览增强独立 root 泄漏（detached Drawnix 实例累积）
- 位置：`kb/MarkdownEditor.tsx:122-130`（effect 依赖含 md、无 cleanup）、`kb/enhanceEmbeds.ts:35-57`（只有 createRoot.render，WeakMap 防重但从不 unmount）。
- 根因：预览态 md 每次变化，dangerouslySetInnerHTML 整体替换占位节点；旧节点上的独立 React root 与其中 Drawnix 实例成为 detached 子树仍存活，window 监听/ResizeObserver/轮询不解绑；drawnix 的图片查看等浮层直接 append 到 body，detached 实例一旦弹出即表现为 body 上的游离 UI（与截图"右侧游离极小图形"同源可疑）。反复"编辑→预览"实例线性累积。
- 影响面：文档预览/公开分享；内存泄漏、游离浮层、潜在串扰。
- 修复方向：effect 加 cleanup 遍历 roots `root.unmount()`；节点替换前对旧占位 unmount；或改为受控的 React 内嵌渲染。

#### U-1 复选框单击即提交 + 双击挂载再翻转，快速连点产生重复 PATCH、终态错乱
- 位置：`grid/GridView.tsx:187-190`（点击 checkbox 单元格 commitValue(!rec.fields[id])）、`cells/CellEditor.tsx:193-198`（CheckboxEditor 挂载即 onCommit(!value)）、双击 `GridView.tsx:192-198`。
- 根因：单击走一条翻转提交；双击又会进入编辑态挂载 CheckboxEditor 再翻转；两次翻转都基于尚未刷新的 `records` 快照，快速连点发出多个相同方向的 PATCH，乐观值与服务端终态可能不一致。
- 影响面：所有 checkbox 字段的快速点击。
- 修复方向：checkbox 单元格双击不进入翻转型 editor（在 onCellDoubleClick 排除 checkbox），或把"进入即翻转"改为单一权威入口 + 提交期间禁用。

#### U-2 全表 findMany 无 take + 全量 hydrate + 内存分页，大数据量卡顿/内存峰值
- 位置：`api/src/domain/recordService.ts:59`（findMany 无 take）、`:148-152`（内存 slice 分页）、`hydrate.ts:63-66,379-403`（逐行串行、每个 links 字段每行多次 SQL；shallowCache 声明未用）、公式 AST 每行每字段重复 parse（:203,261,301）；每次单元格 PATCH/GET 详情 noPaging 全表重算（routes/records.ts:316,460,503）。
- 影响面：万行/多关联表的列表与编辑；附件 base64 存 fields JSON 时被整表读入（U-3）。
- 修复方向：SQL 层 limit/offset + 只 hydrate 当前页（关联标题批量查），公式 AST 按字段缓存，PATCH 不全表重算。

#### U-4 CSV 导入逐行 create+applyFieldWrites 无事务、无唯一校验
- 位置：`api/src/routes/records.ts:698-701`。
- 根因：中途失败产生半成品数据；绕过 assertUnique。
- 修复方向：整批包一个 DbTx，循环内唯一校验/冲突收集。

#### U-9 多类多写操作未事务化
- 建链双向字段配对 `fieldService.ts:167-206`、建表/删表/清表 `routes/tables.ts:72-121,180-183,361-369`、restore 表 `records.ts:851-864` 多语句无事务，中途失败留残。
- 修复方向：统一收 DbTx。

#### C-6 弹窗内编辑画布/文档直接关闭丢内容，无未保存确认
- 位置：`canvas/CanvasEditModal.tsx:80,83,102`、`canvas/DocEditModal.tsx:72,76,94`（Esc/遮罩/关闭直接 onClose，latest 不 flush）。
- 影响面：从关联卡/嵌入预览点"编辑"打开的弹窗；快速连点开闭丢画布编辑。
- 修复方向：关闭前检查 dirty → 二次确认或自动 flush。

### P2

- C-4 嵌入/关联只读小画布初始不 fit（`CanvasEmbed.tsx:98`、`RefEmbedBody.tsx:45` 未传 fitOnLoad），origin(0,0)/zoom1，内容偏离原点即预览空白；0 尺寸时 fitViewport 被 try/catch 吞（DrawnixCanvas.tsx:337-346）。
- C-5 NodeStyleBar 按钮 ref key 重复：`id="strokeColor"/"strokeWidth"/"strokeStyle"` 在形状组(:252-255)与线组(:273-275)重复，btnRefs 相互覆盖，`popupRect()`（NodeStyleBar.tsx:134-140）弹层可能锚到后渲染的同名按钮。
- C-7 `CanvasEnhanceOverlay.tsx:166-173` DocRefCardNode 在渲染期直接调 `onClose()`（元素删除/取消关联时每帧触发）→ React 渲染期 setState 告警/潜在循环。
- C-8 LinkBlockForeignObject：每个关联块一个全 svg subtree MutationObserver，任意拖拽帧触发全部 observer 各做 querySelector，N 块每帧 O(N²)（LinkBlockForeignObject.tsx:145-156）；g 缺失时 rAF 无限轮询（:133-139）。
- C-9 z-index 裸值/潜在互压：CanvasLinkEntry.tsx:53 `z-[50]` 违反 token 约定且低于 block60，关联块拖到左上(36,36)会盖"关联"入口；CanvasPreviewToolbar.tsx:87 fixed z-50 在版本抽屉内可能溢出抽屉；其 :42-77 window keydown 无条件拦截方向键/0/f、:32 200ms 轮询。
- C-10 mind 子节点：右键命中只遍历顶层（canvas-ops.ts:624），点子树任意位置都按根包围盒选中整根（:599），替换子节点选区，无法右键改子节点样式；⌘] 对不可重排子节点静默 return（CanvasZOrderMenu.tsx:76）无反馈。
- C-11 挂载即脏：库初始化 normalize 若补默认字段，序列化与服务端不一致即 markDirty/自动 PUT（DrawnixCanvas.tsx:157,301），版本预览/回滚重挂可能"无改动却保存"。
- U-3 附件以 base64 存 fields JSON（cells/CellEditor.tsx:543-558），叠加 U-2 整表读入内存；无大小上限。
- U-5 CSV 公式注入：导出 `escapeCell`（api/domain/csv.ts:84-87）与前端导出（grid/GridView.tsx:664-683）均未中和 `= + - @` 开头单元格；且前端只导已加载前 200 条、无分页控件。
- U-6 唯一/必填改设置不校验存量（fields.ts:199）；改 relationKind 不收敛存量 linkRow（fieldService.ts:336-352）；bt slice 静默丢多值（records.ts:123）。
- U-7 并发写 SQLite DEFERRED 事务 read-merge-write 整 JSON 覆盖（records.ts:188-190）无乐观锁/重试，异字段并发易 BUSY 500；bulk-update 唯一校验在事务外 TOCTOU（:589-597）。
- U-8 前端 grid：单元格 IME 组词 Enter 未判 isComposing 提前提交（CellEditor.tsx:99）；Esc 取消后 input 卸载触发 onBlur 仍提交草稿（:105-110）；Enter 提交与 blur 双发 PATCH；分组视图全量行无虚拟化（GridView.tsx:319-390）；空筛选结果误显"暂无记录"（:451）；列宽本地 state 不持久（:131）；键盘可移到未渲染虚拟行且不 scrollIntoView；grid 无撤销重做。
- U-10 restore field 不校验对端存活（records.ts:840-843）；purge field 不清理 link_row（:888，无 FK）；表格分享链接过期/删除后已加入 member 不回收（bases.ts:445-461）；JWT 改密不失效；头像扩展名信任客户端 file.type（auth.ts:236-247）；500 回传内部 message（guards.ts:105）；匿名公开写 content 无长度上限（public.ts）。
- D-3 CalendarView:79 `new Date("yyyy-MM-dd")` 按 UTC 解析，西半球时区错位一天；KanbanView.tsx:64-81 columns 每渲染重建致 useMemo 失效；LinksEditor 只能选关联表前 200 条（CellEditor.tsx:377）。
- E-1 文档块：align 设置不进 markdown 协议（blocks.ts:61-62），切源码/重开丢失；toggle/callout 正文仅单层不支持嵌套块（blocks.ts:692,748）；syncBlock 每次按键全量 JSON.stringify+blocksToMd，超长文档输入卡顿；PDF iframe src 未走 isSafeUrl（markdown.ts:225 vs 图片/链接 :28-35），可接受 data:/javascript: 串。
- E-2 内嵌只读小画布滚轮缩放松手边界（RefEmbedBody/CanvasEmbed 无 enhance，LinkBlockForeignObject 的 wheel 拦截不覆盖它们）。

---

## 三、真机暴力测试记录（画布重点）

- 环境：verify@gouxiang.local，画布 cmtuuv230002dfmju86p7e5uo，基线顶层 [ccQfd(关联文档卡), RYiHW(text), bCbpd(脑图根)]。
- 图层命令：对 bCbpd 在 wrap 零延迟混合派发 8 次 front/back/forward/backward；同步读仍为旧序、rAF 收敛后为合法排列 [bCbpd,RYiHW,ccQfd]，无丢元素/重复/崩溃；多次单命令均确定性改序（未复现偶发失效）。测后已通过数据接口把顶层顺序还原为 [ccQfd,RYiHW,bCbpd] 并确认落库。
- 选区/样式条（上一轮修复回归）：左键选中普通几何样式条出现；右键改选后样式条即时跟随、填充/描边精确作用于所见元素；空白右键无选区不弹全灰菜单——本轮未回退。
- 合成 KeyboardEvent(isTrusted=false) 无法驱动 plait 原生撤销插件（已知自动化限制，真机 Cmd+Z 正常，move_node op 进撤销栈已在先前用真实验证）。
- 嵌入裁剪：编辑态文档内 canvas-embed 容器链 `.kb-canvas-wrap(overflow:hidden,858x320)`→`.h-80`→外层 `overflow-hidden`→`.kb-wy-doc`，大几何未测出 wrap 外溢（outside 列表为空）。

## 四、建议的统一修复批次（随后执行）

1. 批次 A（数据正确性，低风险高收益）：D-1 日期比较、D-2 多选 id/name、D-3 日历时区、U-5 CSV 注入、U-8 IME/Esc/blur。
2. 批次 B（画布/嵌入/只读，用户重点）：C-1 只读数据层兜底、C-2 关联卡 canvas-embed 增强、C-3 root 泄漏 cleanup、C-4 fit、C-5 ref id、C-7 render setState、C-6 弹窗未保存确认。

## 五、修复与验证回填

### 批次 A（2026-09-11 完成，已验证）

| 条目 | 修复内容 | 验证结果 |
|---|---|---|
| D-1 日期筛选恒 false | `shared-types/filter.ts` toNumber 增加 DATE_LIKE 形态识别，日期/日期时间按时间戳比较 | 新增单测 6 条（gt/gte/lte/lt/datetime/空值）全绿；全套 56 测试通过 |
| D-2 多选 id/name | `FilterPanel.tsx` 新增 multiSelect 分支，options value 用 `o.id`（与 MultiSelectEditor 存储一致） | 单测 contains/isAnyOf 用 option.id 命中；typecheck 通过 |
| D-3 日历时区 | `CalendarView.tsx:79` 纯日期 `YYYY-MM-DD` 按本地午夜解析 | typecheck 通过 |
| U-5 CSV 注入 | `api/domain/csv.ts` + `GridView.exportCsv` 对 `=+-@\t\r` 开头单元格前导单引号 | typecheck 通过 |
| U-8 IME/Esc/blur 双提交 | `CellEditor.tsx` 三文本编辑器 doneRef+isComposing 守卫 | typecheck 通过 |
| U-1 checkbox 双翻转 | 提前并入批次 A：`GridView` 双击排除 checkbox + 单击在途守卫；`CheckboxEditor` 改纯展示 | **真机验证**：建临时 checkbox 字段连点 5 次，在途守卫去重 1 次（4 PATCH），无反向错乱，UI 终态（勾选）与服务端（true）一致；临时字段已删除还原 |

- 5 包 typecheck 全绿；shared-types 56 单测全绿。
- 备注（P2 不阻断）：在途守卫窗口为「PATCH 返回」而非「invalidate 完成」，极端快速点击仍可能基于 stale 缓存提交同值 PATCH（幂等，终态不错乱）。

### 批次 B（2026-09-11 完成，已验证）

| 条目 | 修复内容 | 验证结果 |
|---|---|---|
| C-1 只读仅事件拦截 | `DrawnixCanvas` handleAfterInit 包装 board.apply：只放行 set_viewport，拒绝一切数据变更 op（DEV 下 console.debug 记录） | **真机**：嵌入只读画布 wheel 平移生效（y 403→241，set_viewport 通路无误杀）；拖拽节点 rect 不变、无选区装饰（编辑手势拦截） |
| C-2 关联卡 canvas-embed 空占位 | `RefEmbedBody` markdown 分支渲染后跑 enhanceCanvasEmbeds（kbId 透传，嵌套一律只读防无限嵌套编辑） | typecheck；与已真机验证的 MarkdownEditor enhance 路径同一函数同构 |
| C-3 enhance root 泄漏 | `enhanceCanvasEmbeds` 返回 cleanup（unmount 本次挂载的 root）；MarkdownEditor effect 挂 cleanup | **真机**：预览↔编辑往返切换重挂载正常（19 svg），console 无 React 警告 |
| C-4 嵌入预览沿用保存视口 | `CanvasEmbed`/`RefEmbedBody` 只读 DrawnixCanvas 传 fitOnLoad | **真机**：文档内嵌入画布打开即内容居中适配 |
| C-5 样式条弹窗锚错 | `NodeStyleBar` shape/line 分支重复 id 去重（line* 前缀），pop 记录触发按钮 id，popupRect 优先按它实时定位 | typecheck（多选 shape+line 场景真机难构造，逻辑直读可信） |
| C-6 弹窗关闭丢内容 | DocEditModal/CanvasEditModal/EditorModal 统一 requestClose：脏状态 Esc/遮罩/关闭按钮均弹确认 | **真机**：DocEditModal 输入脏内容后 Esc 弹出 window.confirm（同步阻塞 JS 执行，铁证）；取消/确定分支逻辑直读可信 |
| C-7 render 期 setState | `CanvasEnhanceOverlay` DocRefCardNode 节点消失/取消关联时改 useEffect 提交后 onClose | typecheck（行为等价、时机合规化） |

- 5 包 typecheck 全绿；api 193 测试全绿；vite 生产构建通过（2131 模块 7.87s）。

### 批次 C（2026-09-12 完成，已验证）

| 条目 | 修复内容 | 验证结果 |
|---|---|---|
| S-1 保存乱序覆盖 | kb_docs 加 contentVersion 列（迁移 20260911233000）；PUT content 带 baseVersion 条件更新、冲突 409+currentVersion；GET doc 返回版本；前端 useDocPersistence（含 keepalive flush）与三弹窗全链路携带/跟进版本，409 保留草稿+invalidate+提示 | **API 实证**：version 0→1 正常保存，旧 baseVersion 返回 409 VERSION_CONFLICT；5 包 typecheck + api 193 全绿 |
| U-4 CSV 导入半截记录 | 单行「建记录+写字段」包 $transaction，行级失败整行回滚（部分导入语义不变） | **真机**：临时表导入 2 行成功 0 错误；表已清理 |
| U-9 建表半截写 | 建表 5 步写（表+主字段+默认字段+视图）包 $transaction | **真机**：建表后 5 字段+主键+网格视图完整 |
| U-7 SQLite BUSY | db.ts 启动时 PRAGMA busy_timeout=5000 + journal_mode=WAL（queryRaw，executeRaw 对 PRAGMA 会静默失败） | **实证**：重启后 journal_mode=wal |
| U-2 全量 hydrate | 低风险子项落地：formula.ts AST 缓存（Map 上限 500 FIFO，hydrate N 条记录同公式不再重复 parse） | api 193 全绿 |

- **U-2 主项（SQL 分页）决策：本批不做**。records.fields 为 JSON、filter/sort/search 依赖 hydrate 后计算字段值，无法下推 SQL；真正分页需 filter 引擎 SQL 化或按视图类型分流，属架构改造，正确性回归面大、当前数据量下收益低。排期触发条件：单表记录数 >5000 或列表接口 P95 >800ms。
- 迁移运维备忘：`migrate dev` 非交互不可用 → 手写 migration.sql + `migrate deploy`；表名是 @@map 的 snake_case（kb_docs）；失败迁移需 `resolve --rolled-back` 后重放。

### 批次 D（2026-09-12 完成，已验证）

| 条目 | 修复内容 | 验证结果 |
|---|---|---|
| E-1 媒体 URL 白名单 | renderMarkdown 视频/音频/PDF 的 src 过 isSafeUrl，javascript:/data:text/html 降级为转义文本 | typecheck + round-trip 脚本 |
| E-1 align 持久化 | Block.align 序列化为 `<!-- align:X -->` 注释行；blocksToMd/mdToBlocks/renderMarkdown 三端识别 | **round-trip 脚本实证**：解析→序列化→再解析 align 保持 [center,null,right]，渲染带 style 且注释不泄漏 |
| C-8 FO observer 风暴 | MutationObserver 回调 rAF 合帧（每帧每 FO 最多一次 findElementG 检查） | typecheck（守持语义不变） |
| C-9 z-index 裸值 | design-tokens 加 canvasEntry=50（entry50<block60），tailwind.ts 映射 + kb.css 兜底，CanvasLinkEntry z-[50] 收编 | typecheck + 生产构建 |
| U-3 附件容量 | AttachmentEditor 单文件 ≤2MB、单格 ≤20 个，超限 toast 跳过（dataURL 入 JSON 的容量守卫） | typecheck |
| U-10 内容长度上限 | 公开写 2MB（zod max）、内部写 10MB | api 197 全绿 |
| U-10 500 信息泄漏 | errorResponse 500 不再回传内部 message（仅 development 附带） | api 197 全绿 |
| U-10 purge 孤儿 | field 物理删除连带 deleteMany linkRow（linkFieldId）；table 端经 Record→Table Cascade 链天然无孤儿 | typecheck |
| U-10 DATEADD 时区 | 纯日期输入按 UTC 日历日加减并回纯日期形态（不再跨日/升级形态） | **新增 4 条单测全绿**（加减/跨月跨年/零天/非法值） |
| U-10 defaultNow 墙钟 | records 新建默认值改本地墙钟（原 UTC，UTC+8 凌晨记成昨天，且与 datetime-local 存储形态对齐） | typecheck |
| U-6 bt 静默丢值 | bt 正向写多目标改明确 400（原 slice(0,1) 静默丢） | **API 实证**：2 目标 400 报错、1 目标正常写入；临时字段已清理 |

- 5 包 typecheck 全绿；api 197（+4 DATEADD）、shared-types 56 全绿；vite 生产构建通过（8.68s）。

### 遗留（不阻断，排期触发）

- U-2 主项 SQL 分页：单表 >5000 记录或列表 P95 >800ms 时启动（filter 引擎 SQL 化或视图分流）。
- U-3 架构项：附件独立表/对象存储（当前 dataURL 内嵌 JSON，2MB 上限是过渡）。
- U-6 余项：唯一/必填改设置时的存量校验、relationKind 变更时的存量 linkRow 收敛——涉及产品决策（拒绝 or 迁移）。
- U-10 余项：restore field 对端存活校验、分享 member 回收、JWT 改密失效、头像扩展名信任 file.type。
- 批次 A 备注：checkbox 在途守卫窗口为 PATCH 返回（非 invalidate 完成），极端连点可能发同值幂等 PATCH（终态不错乱）。
3. 批次 C（并发/事务/性能）：S-1 保存串行化+乐观锁、U-1 checkbox 单入口、U-4/U-9 事务化、U-2 hydrate/分页、U-7 BUSY 重试。
4. 批次 D（健壮性收尾）：E-1 align 持久化/PDF URL 白名单、C-8/C-9 性能与 z-index、U-3/U-6/U-10 边界与回收。
- 每批：同步检查公共组件/状态/事件/同步/调用方 → 5 包 typecheck → 针对性真机/单测回归 → 生产构建 → 更新契约与记忆。
