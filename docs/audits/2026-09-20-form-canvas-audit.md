# 表单设计器 / 文档 / 画布 —— UI 点验清单（只读调研产出）

> 调研范围：`apps/web/src`（前端）+ `apps/api/src`（后端落库路径）。
> 所有结论均带 `文件:行号`，未找到的一律写「未找到」。
> 调研时间：2026-09-20。仓库：`/Users/daijing/Desktop/GouXiangDB`。

---

## 0. 真源文件速查

| 主题 | 主文件 |
| --- | --- |
| 表单设计器（拖拽主体） | `apps/web/src/features/detail/FormDesigner.tsx`（1701 行） |
| 设计器宿主 / 布局渲染 | `apps/web/src/features/detail/DetailLayout.tsx`、`apps/web/src/features/views/ViewRouter.tsx:40` |
| 字段类型库（可拖控件清单） | `apps/web/src/features/designer/FieldEditorSheet.tsx:52`（`TYPE_GROUPS`） |
| 右侧字段设置 | `apps/web/src/features/detail/FieldSettingsPanel.tsx` |
| 文档编辑器壳 | `apps/web/src/features/kb/DocEditorPage.tsx` |
| 文档三态编辑器 | `apps/web/src/features/kb/MarkdownEditor.tsx` / `WysiwygEditor.tsx`（2711 行） |
| 文档/画布持久化 | `apps/web/src/features/kb/useDocPersistence.ts` |
| 画布壳 | `apps/web/src/features/kb/CanvasEditorPage.tsx` |
| 画布装配 | `apps/web/src/features/kb/canvas/GxCanvas.tsx`、`DrawnixCanvas.tsx` |
| 画布操作原语 | `apps/web/src/features/kb/canvas/canvas-ops.ts`（747 行） |
| 后端：视图配置 | `apps/api/src/routes/views.ts:135` |
| 后端：字段 | `apps/api/src/routes/fields.ts:100/170/232/244` |
| 后端：文档内容/移动 | `apps/api/src/routes/kb/docs.ts:188/224` |

---

# A. 表单设计器（FormDesigner）

## A1. UI 入口（3 条真实入口）

| # | 入口路径 | 实现 |
| --- | --- | --- |
| E1 | 左侧导航 → 数据表行 `⋮` → 「编辑表单」→ 跳 `/base/:baseId/table/:tableId?design=1` | `features/sidebar/Sidebar.tsx:45`（`openFormDesigner`）、`:193`（菜单项 label="编辑表单"） |
| E2 | 新壳二级导航 → 表行菜单 → 「编辑表单」 | `features/workspace/SecondaryNavTableOps.tsx:63`、`:141` |
| E3 | 详情视图顶栏齿轮 → 「编辑表单」（inline 模式，不弹全屏） | `features/views/DetailView.tsx:154-162`、`:114` |
| E4 | 记录抽屉内嵌布局编辑器 | `features/drawer/RecordDrawer.tsx:298` |

`?design=1` 由 `ViewRouter.tsx:102` 读取，`TableFormDesignerHost`（`ViewRouter.tsx:40`）挂载。

**关键事实**：设计器顶部 4 个 Tab 中只有「表单设计」有内容；「添加流程 / 拓展设置 / 应用发布」是占位文案（敬请期待）— `FormDesigner.tsx:1031-1033`。

## A2. 可拖拽元素清单

### A2.1 左侧「字段库」可拖入控件（30 个，6 组）

字段库渲染：`FormDesigner.tsx:1245`（`FieldPalette`），每个控件 `draggable`（`FormDesigner.tsx:1275`），`onDragStart` → `beginDragFromPalette`（`FormDesigner.tsx:850`，写入 `text/plain = "palette:<type>"`）。
类型清单真源：`features/designer/FieldEditorSheet.tsx:52-111`。

| # | 组 | 控件名 | fieldType | 默认宽度规则 |
| --- | --- | --- | --- | --- |
| 1 | 基础 | 单行文本 | `singleLineText` | 50% |
| 2 | 基础 | 多行文本 | `longText` | 100%（宽字段） |
| 3 | 基础 | 富文本 | `richText` | 100%（宽字段） |
| 4 | 基础 | 数字 | `number` | 25%（紧凑） |
| 5 | 基础 | 货币 | `currency` | 25% |
| 6 | 基础 | 百分比 | `percent` | 25% |
| 7 | 基础 | 时长 | `duration` | 25% |
| 8 | 基础 | 日期 | `date` | 50% |
| 9 | 基础 | 日期时间 | `datetime` | 50% |
| 10 | 基础 | 复选框 | `checkbox` | 25% |
| 11 | 基础 | 邮箱 | `email` | 50% |
| 12 | 基础 | 链接 | `url` | 50% |
| 13 | 基础 | 电话 | `phone` | 50% |
| 14 | 基础 | 评分 | `rating` | 25% |
| 15 | 基础 | 自动编号 | `autoNumber` | 25% |
| 16 | 基础 | JSON | `json` | 50% |
| 17 | 基础 | 附件 | `attachment` | 100%（宽字段） |
| 18 | 选择 | 单选 | `singleSelect` | 50% |
| 19 | 选择 | 多选 | `multiSelect` | 50% |
| 20 | 高级 | 关联 | `links` | 100%（宽字段） |
| 21 | 布局 | 选项卡分组 | `tabs` | 100% 全宽容器 |
| 22 | 布局 | 子表格 | `subtable` | 100%（宽字段） |
| 23 | 计算 | 查阅 | `lookup` | 50% |
| 24 | 计算 | 聚合 | `rollup` | 50% |
| 25 | 计算 | 计数 | `count` | 50% |
| 26 | 计算 | 公式 | `formula` | 50% |
| 27 | 系统 | 创建时间 | `createdTime` | 50% |
| 28 | 系统 | 最后修改时间 | `lastModifiedTime` | 50% |
| 29 | 系统 | 创建人 | `createdBy` | 50% |
| 30 | 系统 | 最后修改人 | `lastModifiedBy` | 50% |

宽度规则真源：`FormDesigner.tsx:79-84`（`WIDE_TYPES` / `COMPACT_TYPES` / `defaultW`）。

### A2.2 画布内可拖元素（2 类）

| # | 元素 | 实现 | 特殊约束 |
| --- | --- | --- | --- |
| C1 | 普通字段卡 | `FormDesigner.tsx:1383`（`draggable`），`beginDragFromRow`（`:842`） | 可落顶层行 / 选项卡内任意行 |
| C2 | 选项卡分组容器卡 | 顶层由 `FormDesigner.tsx:961-995` 渲染，`TabsDesignerCard:1538`；**容器自身不可拖**（未挂 `draggable`，只能点 ✕ 删除 `:986`） | **不可嵌套**：拖到 tab 内会被静默改落到顶层末尾（`FormDesigner.tsx:824-827`） |

### A2.3 落点类型（4 类，`DropTarget` 联合类型 `FormDesigner.tsx:72-76`）

| 落点 | DOM 标记 | 落点计算 | 高亮实现 |
| --- | --- | --- | --- |
| 顶层字段卡（按左/右半插前/后） | `data-field-card`（`:1373`） | `computeDropTarget:751-763` | 无插入线，仅靠 `dropTarget` 状态（见 A3 视觉反馈缺口） |
| 顶层行间虚线带（新建独立行） | `data-row-gap`（`:1162`） | `:748-749`、`handleGapDragOver:805` | `RowGap active`（`:1170-1176`）蓝色虚线框 + 「放到此处新建一行」 |
| 选项卡内字段卡 | `data-tab-field/-container/-id/-row`（`:1366-1372`） | `:713-725` | 无插入线 |
| 选项卡内行间带 / 选项卡标题栏 / 选项卡空白区 | `data-tab-gap`（`:1156-1161`）、`data-tab-header`（`:1587`）、`data-tab-body`（`:1645`） | `:727-746` | `tabGapActive`（`:896`）+ tab body `bg-gx-accent-bg/40 ring`（`:1650-1651`） |

## A3. 拖拽能力矩阵

| 能力 | 是否支持 | 证据 |
| --- | --- | --- |
| 字段排序（列表内上下拖） | ✅ 支持（通过拖到行间带新建行实现「上下」） | `placeField:661-671`（`kind:"line"`） |
| 行内左右换位 | ✅ 拖到字段卡左/右半 | `:751-763`；另有按钮 `⇄`（`swapLeftField:202`） |
| 跨分组 / 跨 tab 拖 | ✅ 顶层 ↔ tab、tab ↔ 另一 tab 均可 | `placeField:642-658`（先从所有容器摘除再插入，`:617-630`） |
| 从字段库拖入画布（新建字段） | ✅ 拖入即调 `createField` 落库 | `createFieldFromPalette:676-707` |
| 拖出画布（删除） | ❌ **未找到**（无「拖到画布外删除」） | — |
| 拖到首尾边界 | ✅ 有首尾两条行间带（`rowIndex=0` 与 `rows.length`） | `:954`、`:1025` |
| 拖到自身位置 | ⚠️ 允许，先摘除后插入（`:617-630`），可能等价于「无变化」或位移一格 | 需点验 |
| 拖到非法落点 | ⚠️ **无「禁放样式」**：`dropEffect` 只在 `palette` 时 `copy`、否则 `move`（`:800`），任何落点都不拒绝 | 见缺陷 D1 |
| tabs 容器拖进 tab 内 | ⚠️ 静默改落顶层末尾，与高亮位置不一致 | `:824-827` |
| 拖拽中视觉反馈 | 部分：源卡 `opacity-40`（`:1392`）、画布边框高亮（`:931`）、行间带插入线（`:1170`）；**字段卡落点无插入线** | 见缺陷 D2 |
| 键盘操作（无障碍） | ❌ **不支持键盘拖拽**；仅 Esc 关闭（`:900-905`）。键盘可替代项：`▲` 并入上一行（`:1396`）/`▼` 向下拆行（`:1403`）/`⇄` 与左邻交换（`:1410`），但**跨行、跨 tab 无键盘路径** | 见缺陷 D3 |
| 移动端触屏拖拽 | ⚠️ 移动端预览下 `forceStack` 隐藏 ▲▼⇄（`:1396-1414`），且用 HTML5 DnD，触屏基本不可用 | 见缺陷 D4 |
| 乐观更新 / 回滚 | ❌ 无。布局是纯本地 `useState`（`:338`、`:340`），只在点「保存布局」时一次提交 | 见缺陷 D5 |

## A4. 每个拖拽/编辑动作的数据写入路径

> 「拖」本身**不写库**；只有下列 4 类动作会发请求。这是走查员判断「刷新后是否保持」的关键。

| 动作 | 前端 mutation | API | 后端处理 | 是否落库可持久化 |
| --- | --- | --- | --- | --- |
| ① 点「保存布局」（写顶层 `detailLayout`） | `m.updateView.mutate`（**非 mutateAsync**）— `ViewRouter.tsx:76-80`、DetailView `DetailView.tsx:125` | `PATCH /api/views/:viewId`（`api/client.ts:652`） | `routes/views.ts:135`；config 浅合并→`JSON.stringify`（`:170-173`）；**不影响 nav，走非事务** `prisma.view.update`（`:185`） | ✅ 刷新后保持 |
| ② 保存时先写各 tabs 容器的 `tabsConfig` | `m.updateField.mutateAsync`（`FormDesigner.tsx:877`） | `PATCH /api/fields/:fieldId`（`client.ts:473`） | `routes/fields.ts:170` → `updateField` service（`:202`） | ✅ |
| ③ 从字段库拖入 → 新建字段 | `m.createField.mutateAsync`（`FormDesigner.tsx:690`；复制字段 `:480`） | `POST /api/fields?tableId=`（`client.ts:468`） | `routes/fields.ts:100`（重名 409 `:111`、跨 Base 越权 `:120`） | ✅ **立即落库**（不等保存按钮） |
| ④ 删除整个选项卡分组 | `m.deleteField.mutateAsync`（`FormDesigner.tsx:584`）+ 软删撤销 toast（`:586-590`） | `DELETE /api/fields/:fieldId`（`client.ts:478`） | `routes/fields.ts:232` | ✅ 立即落库（软删除进回收站） |
| ⑤ 画布上 ✕「从表单移除」 | — | — | — | ❌ **仅改本地布局**，不删字段；要点「保存布局」才生效（`removeField:439`） |
| ⑥ 字段排序（后端 `/api/fields/:id/move`） | `m.moveField`（`hooks.ts:422`） | `POST /api/fields/:fieldId/move`（`client.ts:483`） | `routes/fields.ts:244` | ✅ **但设计器未调用它**——设计器的排序只存在 `detailLayout` 里，与 `field.order` 是两套独立顺序 |

**去哪看是否真的持久化**：
- 顶层行序/宽度 → `GET /api/views?tableId=...` 返回 `config.detailLayout`（`views.ts:61` 反序列化）。
- tab 内字段 → `GET /api/fields?tableId=...` 返回该 `tabs` 字段的 `tabsConfig`（`rows` + 双写 `fieldIds/widths`，`FormDesigner.tsx:235-244`）。

## A5. 已知限制与缺陷线索（A 部分）

- 代码内**无 TODO/FIXME**（`features/detail/`、`features/kb/` 全目录 grep 无命中）。以下为结构性线索：
- **D1** 无「禁放样式/拒绝落点」：任何位置 `dragover` 都 `preventDefault`（`:798`），不存在 drop-reject 分支。
- **D2** 落点高亮缺失：只有行间带有插入线；拖到字段卡左/右半时**没有任何插入提示**（`:751-763` 只算 beforeIndex，无渲染分支）。
- **D3** 无键盘拖拽替代路径（无障碍缺口）。
- **D4** 移动端不可拖、且 ▲▼⇄ 被隐藏。
- **D5** 布局为本地 state，未保存即刷新/关闭 → 全部丢失；且 `updateView` 用 `mutate`（非 `mutateAsync`），失败不会被 `doSave` 捕获，但已在 `:889` 先 toast「已保存布局」并在 `:890` 关闭设计器。
- **D6** 「表单视图」（`type:"form"`）的 `formFields` / `formTitle` / `formDescription` **没有任何写入 UI**：`features/designer/ViewSettingsPanel.tsx` 只有「视图名称」(`:83`) 与「锁定模式」(`:95`)；`formTitle/formDescription` 全仓仅 `features/views/FormView.tsx:121/123` 读取。故 FormView 永远走 `autoGenerated` 分支显示「表单字段尚未配置」提示（`FormView.tsx:126-130`）。

---

# B. 文档与画布功能操作清单

## B1. 文档（知识库 Doc）

### B1.1 页面与顶栏操作（`DocEditorPage.tsx`）

| # | 操作 | UI 入口 | 实现 |
| --- | --- | --- | --- |
| D01 | 重命名标题 | 顶栏标题输入框，失焦/回车提交 | `:165-172` input；`commitTitle:97` → `useRenameDoc` |
| D02 | 手动保存（立即云端） | 顶栏「保存」按钮 | `:193-203` → `persist.saveNow()`（`useDocPersistence.ts:161`） |
| D03 | 快捷键保存 | Cmd/Ctrl+S（作用域限编辑区） | `:42-46`（`useShortcuts`）；源码态另有 `:449` 双触发保护 |
| D04 | 打开分享 | 顶栏「分享」 | `:204-211` → `ShareModal`（`ShareModal.tsx:96`） |
| D05 | 打开版本历史 | 顶栏「版本历史」 | `:212-219` → `VersionHistoryDrawer` |
| D06 | 保存状态指示 | 顶栏右侧（保存中/已保存/有未保存更改） | `:173-192` |
| D07 | 409 冲突就地二选一 | 顶栏下方 `ConflictNotice` | `:223-240`；`takeLatestVersion`/`keepMineVersion`（`useDocPersistence.ts:123/136`） |
| D08 | 本地草稿恢复 / 丢弃 | 顶栏下方提示条 | `:243-254`、`recoverDraft:110`、`discardDraft` |
| D09 | 返回知识库 | 顶栏 ← | `:156-163` |
| D10 | 右侧悬浮目录（H1–H3） | 编辑器右侧固定浮层，点击跳转 + 滚动高亮 | `DocOutline.tsx:43-167`（只扫 `h1,h2,h3` `:55`；`jump:110`） |
| D11 | 标题锚点跳转 | URL `#h-<slug>` → 滚动 + 闪烁高亮 | `DocEditorPage.tsx:60-90` |

### B1.2 编辑器三态与块操作

三态切换：`MarkdownEditor.tsx:149-159`（编辑/源码/预览；只读用户强制预览 `:139-142`）。三态共享同一份 Markdown，切换无损（`:7`）。

**块类型（WYSIWYG，`WysiwygEditor.tsx:100-130` CMDS；源码态 `MarkdownEditor.tsx:46-75` SLASH_CMDS）**：
正文 / H1-H4 / 无序列表 / 有序列表 / 待办 / 引用 / 代码块 / 表格 / 数学公式 / 分割线 / 分页符 / 折叠块 / 提示块（callout：note/tip/warning/important/警告）/ 图片 / 视频 / 音频 / PDF / 附件 / 内部链接（文档·画布·数据表）。

| # | 操作 | UI 入口 | 实现 |
| --- | --- | --- | --- |
| D12 | 斜杠命令插入（编辑态） | 行内输入 `/` | `WysiwygEditor.tsx:565-571`（↑↓ Enter/Tab Esc 导航） |
| D13 | 斜杠命令插入（源码态） | 空行输入 `/` | `MarkdownEditor.tsx:268-275`、`:507-526` |
| D14 | Markdown 快捷输入 | 行首 `# `/`## `/`### `/`#### `/`- `/`1. `/`[ ] `/`> ` | `WysiwygEditor.tsx:470-491`（正则→块类型转换） |
| D15 | 回车分裂块 | Enter | `:621-631`（`splitBlock`）；折叠块 summary 不分裂 `:603-607` |
| D16 | 退格合并 / 降级 | 行首 Backspace | `:632-642`（`mergeOrDemote`） |
| D17 | 块上移/下移 | **Alt+↑ / Alt+↓** | `:551-554` → `moveBlock:931-955` |
| D18 | 循环切换块类型 | **Cmd/Ctrl+Alt+N**（p/h1/h2/h3/ul/ol/task/quote 8 类） | `:545-549`、`:961-976` |
| D19 | 行内格式 粗/斜/删除线/行内码 | 右键菜单 或 Cmd+B / Cmd+I / Cmd+Shift+X / Cmd+E | 菜单 `:1124-1143`；快捷键 `:506-524` |
| D20 | 高亮 | 右键菜单「高亮」 | `:1139-1144` |
| D21 | 对齐（左/中/右） | 右键菜单「对齐」子菜单 | `:1147-1152` |
| D22 | 文字色 / 背景色 | 右键菜单 → ColorPicker 子菜单 | `:1155-1193` |
| D23 | 链接：编辑/复制/新窗打开/移除 | 右键点链接 | `:1390-1428`（空 URL=删除 `:1397`；不安全协议拒绝 `:1403`） |
| D24 | 表格：插入/删除行列、合并/拆分单元格、清空单元格 | 右键单元格 | `:1262-1387`（合并 `:1280-1317`、拆分 `:1319-1326`） |
| D25 | 折叠块：展开/收起、删除、空 summary 降级为正文 | 点击 summary / 右键 / summary 空时 Backspace | `:595-602`、`:1431-1435` |
| D26 | 提示块：切换 5 种类型、删除 | 右键提示头 | `:1438-1454` |
| D27 | 原子块（图/视频/音频/PDF/附件/分割线/分页符）：点击选中 → Delete/Backspace 删除、Enter 后插段落、Esc 取消 | 点击原子块 + 键盘 | 选中 `:1013-1018`；窗口级键处理 `:979-1010` |
| D28 | 原子块右键：新窗打开 / 下载 / 删除 | 右键原子块 | `:1231-1259` |
| D29 | 撤销 / 重做 | Cmd/Ctrl+Z、Cmd+Shift+Z、Ctrl+Y | `:525-541` → `editor-history.ts`（**仅前端内存栈**） |
| D30 | 上传图片/视频/音频/PDF/附件 | 工具栏按钮（源码态 `MarkdownEditor.tsx:486-495`）或斜杠命令；转 data URL 内嵌 | `MarkdownEditor.tsx:369-407`；`WysiwygEditor.tsx:44-68`（带进度 `:54`） |
| D31 | 上传体积校验 | 上传前 `validateUpload` | `features/kb/upload-limits.ts`（面板 `UploadLimitsPanel.tsx`） |
| D32 | @ 提及：成员 / 文档 / 画布（画布可选「内嵌预览块」） | 输入 `@` | `MentionPicker.tsx:59-77`；内嵌 `canvasEmbedFence` `mentions.ts` |
| D33 | 插入内部实体链接（文档/画布/数据表） | 源码态工具栏 🔗 或斜杠命令 | `MarkdownEditor.tsx:427-441`（`EntityPicker`） |
| D34 | 内嵌画布（只读预览 + 「编辑」弹窗） | `@` 选画布→内嵌预览块 | `CanvasEmbed.tsx:97-140`（只读 DrawnixCanvas `:122`；`CanvasEditModal`） |
| D35 | 块级拖拽（Notion 式把手） | — | **未找到**。`WysiwygEditor.tsx` 全文无 `draggable/onDragStart`（grep 无命中）。只有 Alt+↑/↓ 键盘换位（D17） |
| D36 | Tab 缩进 / 列表升级降级（层级） | — | **未找到**。`WysiwygEditor.tsx` 无 Tab 处理（Tab 仅在斜杠菜单里当确认键 `:569`）；源码态 Tab 插入两个空格（`MarkdownEditor.tsx:461-469`）。多级嵌套只能手写 Markdown 或靠 Backspace 降级（D16） |
| D37 | 块菜单（左侧 ⠿/➕ 悬浮按钮） | — | **未找到**；块操作全部走右键菜单（`:1039` 命中探测，优先级 链接>表格>折叠>提示头>原子块>文本） |

### B1.3 文档树 / 版本 / 分享 / 权限

| # | 操作 | UI 入口 | 实现 / 后端 |
| --- | --- | --- | --- |
| D38 | 文档树展开/收起、新建子文档 | 知识库左侧树 | `KbTree.tsx:105-115` |
| D39 | **拖拽建立父子级联**（拖到节点上=成为子级；拖到底部条=回到根） | 左树拖拽 | `KbTree.tsx:226-233`（dragStart/dragOver）、`:418-421`（root 落点）；前端防环 `:176-181`；`moveDoc.mutateAsync:199`。后端 `POST /api/kb/docs/:id/move` → `routes/kb/docs.ts:224`（画布拒绝 `:235`、自身 `:252`、后代 `:254`） |
| D40 | 版本历史：列表、预览（文档渲染/画布只读）、手动存版本、回滚 | 顶栏「版本历史」抽屉 | `VersionHistoryDrawer.tsx:184-192`（存版本）、`:257-264`（回滚）、预览工具条 `:41-58`。后端 `routes/kb/versions.ts:15/31/44/59` |
| D41 | 分享：内部成员仅可见/可编辑；外部链接开关+角色+级联分享；复制链接 | 「分享」弹窗 | `ShareModal.tsx:111-124`（内部）、`:147` 复制、`:158-168`（持链者权限）、`:183`（同步分享下级）。后端 `routes/kb/sharing.ts:14/41/85` |
| D42 | 文档级 ACL（企业权限同表视图） | 知识库首页文档行 → 权限 | `KbHomePage.tsx:304` → `DocAclModal.tsx:22`；后端 `routes/kb/acl.ts:18/35` |
| D43 | 软删除 / 回收站找回 / 彻底删除 | 树菜单删除；回收站页 | `routes/kb/docs.ts:270`（软删）、`:293`（找回）、`routes/kb/recycle.ts:15/48`；前端 `KbTrashPage.tsx` |
| D44 | 乐观锁（S-1） | 无显式 UI；保存带 `baseVersion`，冲突→409 | `useDocPersistence.ts:89`（`baseVersion`）、`:103-107`（409 置 conflict）；后端 `routes/kb/docs.ts:198`、`:216`（409 信封 `currentVersion`） |
| D45 | 自动保存 | 无开关；1200ms 防抖 + 本地草稿 + 卸载 flush | `useDocPersistence.ts:145-158`（debounce 1200ms `:155`）、`:168-196`（keepalive PUT `:175`）、`beforeunload:200` |

## B2. 画布（Canvas）

### B2.1 页面级操作（`CanvasEditorPage.tsx`）

| # | 操作 | UI 入口 | 实现 |
| --- | --- | --- | --- |
| V01 | 重命名画布 | 顶栏标题输入 | `:112-119`、`commitTitle:48` |
| V02 | 手动保存（立即云端） | 顶栏「保存」 | `:140-150` → `persist.saveNow()` |
| V03 | 保存状态 / 409 冲突 / 草稿恢复 | 顶栏及下方提示条 | `:120-139`、`:169-187`、`:189-201`（与文档共用 `useDocPersistence`） |
| V04 | 分享 / 版本历史 | 顶栏 | `:151-166`、`:215-221` |
| V05 | 自动保存机制 | 无显式提交按钮 | `onContentChange` → `persist.markDirty`（`:44`）；**1200ms 防抖自动保存**（`useDocPersistence.ts:155`）；离开/刷新 `flush`（`:168`） |

### B2.2 画布内元素与基础操作

引擎：开源 Drawnix（`@drawnix/drawnix@0.4.0-0`）包在 `DrawnixCanvas.tsx:174`（动态 import），底层 plait board。

| # | 操作 | UI 入口 | 实现 |
| --- | --- | --- | --- |
| V06 | 元素类型：几何图形（矩形/椭圆/菱形…）、箭头、线、文字、图片、思维导图、自由画笔、橡皮 | 左侧/底部 Drawnix 自带工具条 | `DrawnixCanvas.tsx:351-366` 整体渲染 `Drawnix`；工具条 CSS 恒置顶 `kb.css:184-188`。包内确认含 `draw-toolbar/creation-toolbar/pencil-mode-toolbar/zoom-toolbar/theme-toolbar`（`kb.css:184-188` 引用；`index.mjs` 含 `Mind/Freehand/Eraser/Ellipse/Diamond/Arrow/Line/Image/Text`） |
| V07 | 我方自建元素：**关联块**（gx-link-block，可关联文档/画布） | 左上角「关联」按钮（替换 Drawnix app-toolbar 槽位） | `canvas/CanvasLinkEntry.tsx:57-71` → `CanvasLinkPicker` → `insertLinkBlock`（`canvas-ops.ts:362`）；插入后自动弹 `EditorModal`（`:47`） |
| V08 | 选中 / 框选 / 多选 | Drawnix 原生（点击 / 拖框） | plait 内部；我方读取 `rt.selectedIds`（`canvas-context.tsx`，`CanvasEnhanceOverlay.tsx:71-82`） |
| V09 | 拖拽移动元素 | Drawnix 原生 | — |
| V10 | 缩放 / 平移 | 滚轮/触控板；只读预览另有一套工具条（缩小/放大/还原100%/适配/手形平移） | 命令式句柄 `DrawnixCanvas.tsx:128-166`（`zoomBy/setZoom/fit/panBy`）；只读工具条 `canvas/CanvasPreviewToolbar.tsx:99-136` |
| V11 | 连线（箭头/线）与连线形态（直线/曲线/折线） | 选中连线 → 悬浮样式条 | `canvas-ops.ts:90` `setArrowShape`；UI `NodeStyleBar.tsx:291` |
| V12 | 连线端点样式（起点/终点箭头） | 样式条 | `canvas-ops.ts:99` `setArrowMarker`；UI `NodeStyleBar.tsx:298-299` |
| V13 | **图层 z 序**：上移一层 / 下移一层 / 置于顶层 / 置于底层 | 画布内右键菜单；或快捷键 ⌘] / ⌘[ / ⌥⌘] / ⌥⌘[；或样式条「图层」入口 | `canvas/CanvasZOrderMenu.tsx:93-99`（菜单）、`:64-80`（快捷键）、`NodeStyleBar.tsx:254`；`applyZOrder`（`canvas-ops.ts:558+`）走 plait `ZIndexTransforms` |
| V14 | 撤销 / 重做 | Drawnix 自带工具条（包内 `index.mjs` 含 undo/redo 各 11 处） | **我方未自实现**，依赖 Drawnix |
| V15 | 删除元素 | 选中 + Delete（Drawnix 原生）；关联块另有 `removeLinkBlock` | `canvas-ops.ts:509` |
| V16 | 元素样式：描边色/填充色/线宽/线型 | 选中 → 悬浮样式条 | `canvas-ops.ts:41/60/53/47`；UI `NodeStyleBar.tsx:263-266` |
| V17 | 文字样式：粗/斜/下划线/对齐/文字色 | 样式条 | `canvas-ops.ts:72/78/84`；UI `:268-276` |
| V18 | 节点内插图 | 样式条 🖼 | `canvas-ops.ts:332` `insertImageIntoShape`；UI `NodeStyleBar.tsx:278` |
| V19 | 思维导图：布局方向（右/左/上下/双侧）、节点形状/填充/描边/文字色、分支线颜色/宽度/形态 | 选中 mind → 样式条「脑图」分区 | `canvas-ops.ts:134-235`；UI `NodeStyleBar.tsx:310-335` |
| V20 | 节点注释（角标气泡，hover 查看/直接编辑/删除，maxLength 500） | 节点右上角 💬 角标 | `canvas/NodeBadges.tsx:89-149`；`setElementNote`（`canvas-ops.ts:302`） |
| V21 | 节点关联文档/画布：角标点击 → 预览卡（可多开） | 节点右上角文档图标角标 | `NodeBadges.tsx:71-88`；卡片 `canvas/DocRefCard.tsx`；`setElementDocRef`（`canvas-ops.ts:309`） |
| V22 | 关联预览卡：拖拽右下角调尺寸（持久化 localStorage `gx-canvas-refsize-<nodeId>`）、关闭 | 卡片右下角手柄 / 卡上关闭 | `DocRefCard.tsx:65-113`（手柄 setPointerCapture 绕开内嵌画布拦截 `:109`）；尺寸持久化 `:45-54/84` |
| V23 | 关联块：换关联目标 / 改尺寸 / 移动 / 本地重命名 / 切换预览密度（完整·极简）/ 删除 | 关联块卡片内操作 | `canvas-ops.ts:456/463/496/516/532/509`；UI `GxLinkBlockView.tsx`、`LinkBlockPreview.tsx` |
| V24 | **画布 → 文档/画布跳转** | 关联卡「跳转」按钮 | `DocRefCard.tsx:124-129`（`navigate(/kb/:kbId/doc|canvas/:docId)`） |
| V25 | **文档 → 画布**（内嵌只读预览 + 弹窗编辑） | 文档内 `@` 选画布→内嵌预览块 | `CanvasEmbed.tsx:97-140`；只读渲染 `:122` |
| V26 | 只读态：滚轮/触控板缩放平移放行，编辑手势全拦截 | 公开分享页 / 文档内嵌 | `DrawnixCanvas.tsx:188-226`（capture 阶段拦截 pointerdown/dblclick/contextmenu/pointermove/keydown，放行 overlay 与 wheel）；数据层兜底 `board.apply` 只放行 `set_viewport`（`:314-327`） |
| V27 | 编辑态屏蔽 Drawnix「保存为文件/导出」下载 | 无 UI；主动拦截 | `DrawnixCanvas.tsx:231-242`（拦截 `a[download]`）+ `kb.css:360`（隐藏 app-toolbar）+ `:247-263`（Cmd/Ctrl+S 改走云端） |
| V28 | **画布 ↔ 记录/数据表 双向跳转** | — | **未找到**。`features/kb/canvas/` 全目录 grep `recordId|/base/|tableId` 无命中；`CanvasLinkPicker` 只列文档/画布 |

### B2.3 画布落库路径

- 唯一写入：`PUT /api/kb/docs/:docId/content`（`client.ts` → `routes/kb/docs.ts:188`），body `{content, baseVersion}`，内容上限 **10MB**（`docs.ts:195`），带乐观锁（`:198`），冲突 409（`:216`）。
- 触发：每次编辑 `onValueChange` → `handleChange`（`DrawnixCanvas.tsx:269-275`）→ `GxCanvas` → `CanvasEditorPage.onContentChange:44` → `persist.markDirty` → 1200ms 防抖 PUT。
- 非受控组件：`value` 只在挂载读一次（`DrawnixCanvas.tsx:169`），外部内容替换靠 `key` 重挂载（`CanvasEditorPage.tsx:205`）。

---

# C. 必须点验清单（给 UI 走查员）

格式：**进哪个页面 → 点/拖哪里 → 期望看到什么 → 异常分支怎么触发**

## C-A 表单设计器（18 条）

| # | 步骤 | 期望 | 异常分支 |
| --- | --- | --- | --- |
| FA-01 | 左侧数据表 `⋮`→「编辑表单」（或二级导航表行菜单）→ 进入设计器 | 全屏设计器：左字段库（30 控件/6 组）/ 中画布 / 右字段设置 | 无 schema 权限账号：拖字段应 toast「无表结构管理权限」（`FormDesigner.tsx:677`；删除容器 `:562`） |
| FA-02 | 字段库搜索框输入「文本」 | 只剩「单行文本/多行文本」 | 输入「zzz」→ 全组消失，列表空 |
| FA-03 | 拖「单行文本」到画布空白（rows 为空时） | 「创建字段中…」遮罩 → 新字段卡出现在第 1 行；右侧设置面板自动选中 | 立即刷新页面 → 字段仍存在（因为 `createField` 已落库），但**布局丢失** |
| FA-04 | 拖字段到第 1 行与第 2 行之间的虚线带 | 显示蓝色虚线框「放到此处新建一行」；松手后新建独立一行 | 松手在画布区域外（浏览器外/地址栏）→ 不应产生新字段（`endDrag:833` 清状态） |
| FA-05 | 拖字段到已有字段卡的**左半 / 右半** | 插到该字段前 / 后，同行宽度自动压缩（50/50 或 50/25/25） | ⚠️ 观察：**是否有插入线提示**（预期无，见 D2） |
| FA-06 | 拖字段到自身位置（拖起后原地松手） | 位置不变，字段不丢失 | 连续快速拖 5 次 → 每次落点应与高亮一致，不串位 |
| FA-07 | 拖到第一行**上方**行间带（首边界） | 成为新的第 1 行 | 拖到最后一行**下方**带（尾边界）→ 追加到末尾 |
| FA-08 | 拖「选项卡分组」进画布 | 生成全宽容器 + 默认 1 个「基本信息」tab，自动打开 EditorModal？→ 实际不开；selected 新字段 | 拖 **tabs 容器**到另一个 tabs 内部 → ⚠️ **应落到顶层末尾**（不在你松手的 tab 内）（`:824-827`）——重点核对「高亮 vs 实际落点」是否不一致 |
| FA-09 | 拖普通字段进 tab 内容区 / tab 标题栏 / tab 内行间带 | 分别落到：末尾新行 / 末尾新行 / 指定新行；右侧设置可改宽度 | 拖「子表格」进 tab → 允许（`:822` 注释明确允许） |
| FA-10 | 跨 tab 拖：tab1 的字段 → tab2 | 从 tab1 消失，出现在 tab2 当前行 | 拖到**非当前激活** tab 的标题栏 → 落到该 tab 末尾（需先切过去看） |
| FA-11 | 点字段卡 `▲` | 并入上一行（上一行 <4 字段时按钮才出现） | 上一行已有 4 个字段 → `▲` 不显示（`canJoinUp:166`） |
| FA-12 | 点 `▼` | 向下拆成独立一行 | 本行仅此一个字段 → `▼` 不显示（`:999`） |
| FA-13 | 点 `⇄` | 与左邻交换 | 行内第 1 个字段 → `⇄` 不显示（`canSwapLeft={ii>0}` `:1008`） |
| FA-14 | 点右上角复制 / ✕ | 复制：立即 `createField`（落库）并插在源字段后；✕：仅从布局移除（**不删字段**） | 复制 tabs 容器 → 落顶层末尾（`FormDesigner.tsx:501-503`） |
| FA-15 | 删除整个选项卡分组（容器右上角 🗑） | L2 确认弹窗「分组内的字段会退回表单末尾，不会被删除」→ 确认后字段退回末尾 + 字段**物理软删** + toast 带「撤销」 | 只有 1 个 tab 时点 tab 的 ✕ → toast「至少保留一个选项卡」（`:526`） |
| FA-16 | 点「保存布局」 | toast「已保存布局」+ 设计器关闭 | ⚠️ **关掉网络（DevTools offline）再点保存**：仍会 toast 成功并关闭（D5）→ 刷新后布局回退 |
| FA-17 | 刷新后回到同一表 | 行序/宽度/tab 内字段全部保持 | 若未点保存就刷新 → 全部回退（预期行为，但需确认是否被误认为 bug） |
| FA-18 | 切「移动端」预览 | 画布变 420px 单列，`▲▼⇄` 隐藏，字段库与设置收到底部抽屉 | 此时尝试拖字段 → 触屏/鼠标 HTML5 DnD 行为；`▲▼⇄` 消失导致无法调整（D4） |

## C-B 文档（22 条）

| # | 步骤 | 期望 | 异常分支 |
| --- | --- | --- | --- |
| FB-01 | 知识库 → 新建文档 → 标题输入后失焦 | 标题更新，无 toast 异常 | 清空标题失焦 → 变成「未命名文档」（`DocEditorPage.tsx:103`） |
| FB-02 | 编辑态输入 `# ` / `## ` / `- ` / `1. ` / `> ` | 实时变为 H1/H2/圆点/编号/引用 | 在**列表项中间**输入 `# ` → 不应误转（正则要求行首，`WysiwygEditor.tsx:470-479`） |
| FB-03 | 输入 `/` → 选「表格」 | 插入 3×3 表格 | `/` 后立刻按 Esc → 菜单关闭且**不留 "/" 字符**；中文输入法组词中按 Enter → 不触发命令（`isComposing` 早退 `:497`） |
| FB-04 | 光标在段落中间按 Enter | 分裂为两块 | 块尾是 @成员/内链 chip 时按 Enter → 不应把隐藏协议 `data-user` 泄到新块（`:678` 注释） |
| FB-05 | 行首 Backspace | 与本行合并/降级 | 空段落连续 Backspace → 逐级合并，不崩 |
| FB-06 | Alt+↑ / Alt+↓ | 整块上/下移，焦点跟随 | 首块按 Alt+↑ / 末块按 Alt+↓ → 无反应（`:942`） |
| FB-07 | Cmd/Ctrl+Alt+N | 块类型在 8 类间循环 | 在**表格/代码块**上按 → 不生效（`CYCLE_TYPES` 不含这些 `:961`） |
| FB-08 | Cmd+Z / Cmd+Shift+Z | 撤销/重做 | **刷新页面后 Cmd+Z 无效**（历史栈仅内存，`editor-history.ts`）——确认是否被误认为 bug |
| FB-09 | 右键选中文字 → 加粗/斜体/删除线/高亮 | 选中态才可用，否则置灰 | 未选中文字右键 → 四项全灰（`:1126-1136` `disabled: !hit.hasSelection`） |
| FB-10 | 右键 → 对齐 / 文字色 / 背景色 | 生效并序列化回 Markdown | 切到「源码」态核对生成的是否合法（`<span style>` 等） |
| FB-11 | 右键单元格 → 插入行/列、向右/向下合并、拆分、删除行列、清空 | 表格结构变化正确，合并后 DOM 与 spans 一致 | 已是最右列时「向右合并」置灰（`:1328`）；只有 1 行时「删除当前行」置灰（`:1368`）；**合并区内有第三个合并区挡道 → 静默不合并**（`:1291-1297`） |
| FB-12 | 右键链接 → 编辑链接，输入 `javascript:alert(1)` | 弹「链接协议不安全，已拒绝保存」 | 输入空 → 链接被移除（`:1397`） |
| FB-13 | 插入折叠块 → 点 summary 展开/收起；summary 清空后 Backspace | 折叠/展开正常；空 summary 时 Backspace 降级为正文 | summary 按 Enter → 不换行、直接跳到正文（`:603`） |
| FB-14 | 插入提示块 → 右键提示头切 5 种类型 | 类型切换生效 | — |
| FB-15 | 点击图片/视频/附件 → 变蓝色选中 → 按 Delete | 块被删 | 焦点在侧栏搜索框时按 Backspace → **不应**误删原子块（`:986-989` 有守卫，重点验） |
| FB-16 | 工具栏上传超大图片 | `window.alert` 体积超限提示 | 上传中切走页面 → 不应产生半截 data URL |
| FB-17 | 输入 `@` → 选成员 / 文档 / 画布（选「内嵌预览块」） | 分别插入 chip / 链接 / 画布内嵌块 | 选**本文档自己** → 应被排除（`docId` 传参 `MarkdownEditor.tsx:264`） |
| FB-18 | 文档内嵌画布 → 点「编辑」→ 改几笔保存 → 关闭 | 内嵌预览 `reloadKey++` 重新加载显示最新（`CanvasEmbed.tsx:133-138`） | 嵌套层级过深 → 应出现 `EmbedDepthFallback`（`embed-depth.ts`） |
| FB-19 | 右侧目录：写几个 H1–H3 → 点目录项 | 平滑滚动 + 当前项高亮跟随滚动 | 只有 H4 → **目录不显示**（`DocOutline.tsx:55` 只扫 h1-h3） |
| FB-20 | 顶栏「保存」 / Cmd+S | 状态变「已保存到云端」 | 手动连点 5 次保存按钮 → 观察是否并发 PUT（D14：`persist` 无 in-flight 互斥） |
| FB-21 | 开两个标签页同时编辑同一文档 | 后保存方出现 409 → 顶部 `ConflictNotice`「查看最新版本 / 保留我的版本」 | 点「查看最新版本」→ 本地未保存内容丢弃；点「保留我的版本」→ 以服务端版本号覆盖写回（`useDocPersistence.ts:136-142`） |
| FB-22 | 编辑中不保存直接刷新 / 关标签页 | 应触发 `beforeunload` 提示；重进出现「检测到本地草稿 → 恢复草稿/丢弃」 | 选择「恢复草稿」→ 内容回来且自动保存（`:110-117`） |
| FB-23 | 顶栏「版本历史」→ 手动存版本 → 回滚 | toast「已回滚，回滚前状态已自动备份为新版本」（`VersionHistoryDrawer.tsx:136`） | 画布版本预览可缩放/适配（`:41-58`） |
| FB-24 | 左树拖拽文档到另一文档上 / 拖到底部条 | 成为子级 / 回到根；层级即时重算 | 拖到**自己的子孙**上 → 前端 `isDescendant` 静默取消（`KbTree.tsx:176-181`）；后端也会 400（`docs.ts:254`） |
| FB-25 | 拖**画布**到文档上建立层级 | 应被拒绝 | 后端 `docs.ts:235`「画布不支持层级嵌套」；前端是否置灰待验 |
| FB-26 | 「分享」弹窗：内部仅可见/可编辑、外部链接开关、持链者权限、同步分享下级 | 设置生效 | 关闭外部链接后**原链接立即失效**（`ShareModal.tsx:192`） |

## C-C 画布（20 条）

| # | 步骤 | 期望 | 异常分支 |
| --- | --- | --- | --- |
| FC-01 | 知识库 → 新建画布 → 进入 | 画布加载，左侧 Drawnix 工具条可见，左上角我方「关联」按钮可见 | 空白画布无任何提示语；`app-toolbar` 被 CSS 隐藏（`kb.css:360`），不应看到「保存为文件」 |
| FC-02 | 画矩形/椭圆/菱形/线/箭头/文字 | 元素生成 | 双击文字元素进入 slate 编辑（依赖三层 CSS 顺序 `DrawnixCanvas.tsx:27-31`） |
| FC-03 | 插入图片（工具条） | 图片元素 | — |
| FC-04 | 框选多个元素 | 多选包围盒；悬浮样式条出现在包围盒上方（`CanvasEnhanceOverlay.tsx:88-95`） | 多选后样式条取首元素状态作为高亮（`canvas-ops.ts:236-240`） |
| FC-05 | 拖动元素 / 拖动连线端点 | 元素移动 / 连线跟随 | 快速连续拖动后松手 → 位置正确，无残影 |
| FC-06 | 滚轮/触控板缩放 | 缩放生效 | 缩放 <40% 时**角标自动隐藏**（`NodeBadges.tsx:40`） |
| FC-07 | 选中元素 → 右键 → 上移一层/下移一层/置于顶层/置于底层 | toast 成功提示 | 已在顶层再「上移」→ toast「已在最顶层，无法再上移」（`CanvasZOrderMenu.tsx:23-28`）；**在空白处右键（无选区）→ 不弹菜单**（`:60`） |
| FC-08 | 快捷键 ⌘] / ⌘[ / ⌥⌘] / ⌥⌘[ | 同上 | 焦点在输入框/contentEditable 内 → 不触发（`:68-69`） |
| FC-09 | 选中几何 → 样式条改描边色/填充/线宽/线型 | 立即生效 | 对**连线**改「填充」→ 库内部无效（`canvas-ops.ts:59` 注释） |
| FC-10 | 选中连线 → 改形态（直线/曲线/折线）+ 起点/终点箭头 | 生效 | 选中非连线时这些按钮不出现（`NodeStyleBar.tsx:284` 分支） |
| FC-11 | 插入思维导图 → 改布局方向/节点形状/分支线 | 生效 | 未选中 mind 时不显示该分区 |
| FC-12 | 选中节点 → 样式条（或角标）加注释 | 右上角出现 💬 角标，hover 显示浮卡 | 角标里点「删除」→ 注释清空、角标消失（`NodeBadges.tsx:140-147`）；注释 >500 字被 `maxLength` 截断（`:185`） |
| FC-13 | 左上角「关联」→ 选/新建文档或画布 | 画布插入关联块 + 自动弹 `EditorModal`（`CanvasLinkEntry.tsx:47`） | **直接关闭弹窗** → 可能留下标题为「未命名」的块（D10） |
| FC-14 | 点关联角标 → 展开预览卡；再点一次 | 展开/收起；**可同时展开多张** | 删掉关联节点 → 卡片自动关闭（`CanvasEnhanceOverlay.tsx:172`） |
| FC-15 | 拖预览卡右下角手柄调大小 | 尺寸变化，可放大也可缩小 | 向内（缩小）方向拖 → 必须能缩小（`:109` setPointerCapture 就是为此）；刷新后尺寸保持（localStorage `:84`） |
| FC-16 | 预览卡「跳转」 | 跳到该文档/画布页 | 公开页（无 kbId）→ 跳转按钮不可用（`DocRefCard.tsx:140` `jumpEnabled={!!kbId}`） |
| FC-17 | 关联块：换目标 / 重命名 / 切极简预览 / 删除 | 全部生效 | 删除后角标消失 |
| FC-18 | Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z | Drawnix 自带撤销/重做生效 | 我方增强写入（注释/关联/z 序）是否进撤销栈需实测 |
| FC-19 | 顶栏「保存」/ Cmd+S | toast「已保存到云端」，状态变已保存 | **绝不能触发浏览器下载 .drawnix 文件**（`DrawnixCanvas.tsx:231-263` 三重拦截） |
| FC-20 | 编辑后立刻刷新页面 | 内容保持 | 若在 1200ms 防抖内刷新 → 靠 `flush`（keepalive PUT）+ 本地草稿兜底，重进提示恢复草稿 |
| FC-21 | 两个标签页同时编辑同一画布 | 后保存方 409 → 冲突二选一 | 同 FB-21 |
| FC-22 | 打开只读/公开分享画布 | 只能滚轮缩放平移，不能画/拖/删；注释与关联角标**仍可看**，关联块内点击可展开 | 点角标无反应 = 回归 bug（历史上因遮罩吞事件，`DrawnixCanvas.tsx:194-199` 有 `inOverlay` 放行逻辑） |
| FC-23 | 版本历史 → 选旧版本 → 预览画布快照 | 只读 DrawnixCanvas 展示快照，可缩放/适配 | 快照内不应可编辑（`readonly && !allowViewInteraction` → 全屏遮罩 `DrawnixCanvas.tsx:394`） |
| FC-24 | 画布内尝试关联一条**数据表记录** | — | **未找到该能力**（V28），确认是「无此功能」还是「入口没露出来」 |

---

# D. 【存疑】单独列一节

1. 【存疑】**`formFields` / `formTitle` / `formDescription` 是否有隐藏入口**：`features/views/FormView.tsx:28/121/123` 读这三个 config 字段，但全仓 grep 无任何写入点（`ViewSettingsPanel.tsx` 只有名称+锁模式）。判断为「表单视图配置 UI 缺失」，但需走查员在真实界面确认是否有别的入口（例如视图设置抽屉的二级页）。
2. 【存疑】**Drawnix 自带工具条在真实界面上的最终可见项**：`kb.css:184-188` 只列了 draw/zoom/theme/pencil-mode/creation 五个工具条的 z-index，未列 undo/redo 所在条；包内 `index.mjs` 确认含 undo/redo 关键词（各 11 处），但**具体落在哪个工具条、图标长什么样未在代码层面确认**，需真机看。
3. 【存疑】**画布多选时的样式条行为**：`canvas-ops.ts:236-240` 注释说「多选取首个元素的状态」，但 `setStrokeColor` 等对多选是否全部应用未在源码中逐条确认（只在 `toggleTextMark` 注释里写了「多选全部应用」`canvas-ops.ts:71`）。
4. 【存疑】**`m.moveField`（`POST /api/fields/:id/move`）是否有 UI 调用**：`hooks.ts:422` 定义了该 mutation，但全仓只在 hooks 中定义；表单设计器不调它。**可能是死代码，也可能是网格视图字段列拖拽在用**——本次未扫 `features/grid/`，需补验。
5. 【存疑】**文档块拖拽**：`WysiwygEditor.tsx` 全文无 draggable，但 `wy-zones.ts`（行间插入热区）与 `insertParagraphAfter` 暗示有「行间插入」交互；是否存在非 DnD 的拖拽入口未在代码层确认，需真机在块左侧空白区按住试。
6. 【存疑】**`CanvasPreviewToolbar`（只读预览工具条）在哪些场景挂载**：组件存在（`canvas/CanvasPreviewToolbar.tsx:99-136`），但 grep 未见 `VersionHistoryDrawer` 以外的挂载点；`VersionHistoryDrawer.tsx:41-58` 自带一套同功能预览工具条。**两套是否重复/哪套生效**未在代码层确认。

---

# E. 疑似缺陷线索汇总（15 条）

| # | 线索 | 位置 |
| --- | --- | --- |
| 1 | 布局本地 state 未保存即丢失；且 `updateView` 用 `mutate`（非 await），失败仍 toast「已保存布局」并关闭 | `FormDesigner.tsx:868-891`；`ViewRouter.tsx:76`；`DetailView.tsx:125` |
| 2 | tabs 容器拖进 tab 内被静默改落到顶层末尾，与高亮落点不一致 | `FormDesigner.tsx:824-827` |
| 3 | 字段卡落点（左/右半插入）没有任何插入线/占位提示 | `FormDesigner.tsx:751-763`（无对应渲染分支） |
| 4 | 无键盘拖拽替代；跨行/跨 tab 无键盘路径（无障碍缺口） | 全文仅 `FormDesigner.tsx:900-905` Esc |
| 5 | 移动端预览隐藏 ▲▼⇄ 且用 HTML5 DnD，触屏不可排版 | `FormDesigner.tsx:1396-1414` |
| 6 | 表单视图 `formFields/formTitle/formDescription` 无写入 UI，FormView 永远显示「尚未配置」 | `ViewSettingsPanel.tsx:83/95`；`FormView.tsx:126-130` |
| 7 | 设计器 3 个 Tab（流程/拓展/发布）为占位 | `FormDesigner.tsx:1031-1033` |
| 8 | 字段顺序有两套（`detailLayout` vs `field.order`），设计器只写前者，`moveField` API 无人调用 | `FormDesigner.tsx:868` vs `hooks.ts:422` |
| 9 | 文档无块级拖拽把手（Notion 式） | `WysiwygEditor.tsx` 无 `draggable` |
| 10 | 文档无 Tab 缩进/列表层级升级降级（仅 Backspace 降级、源码态 Tab 插空格） | `WysiwygEditor.tsx`（无 Tab 分支）；`MarkdownEditor.tsx:461-469` |
| 11 | 文档撤销栈仅前端内存，刷新即失效，与自动保存/版本快照不联动 | `features/kb/editor-history.ts` |
| 12 | `persist` 无 in-flight 互斥：连点保存可能并发 PUT | `useDocPersistence.ts:161-165`（`saving` ref 只写不读） |
| 13 | 画布插入关联块后自动弹 EditorModal，直接关闭可能留下「未命名」空块 | `canvas/CanvasLinkEntry.tsx:47` |
| 14 | 画布无「记录/数据表」关联，画布↔记录双向跳转缺失 | `features/kb/canvas/` 全目录无 `recordId/tableId` |
| 15 | 画布内容 10MB 硬上限（超限 400 且只落本地草稿，用户不易察觉） | `apps/api/src/routes/kb/docs.ts:195` |

---

# F. 统计

- 表单可拖拽控件：**30 个字段库控件**（6 组）+ **2 类画布内可拖元素** + **4 类落点**
- 文档可执行操作：**46 条**（D01–D45 + 三态切换；其中 3 项「未找到」：块级拖拽、Tab 缩进、块菜单）
- 画布可执行操作：**28 条**（V01–V28；其中 1 项「未找到」：画布↔记录跳转）
- 点验脚本：**18（表单）+ 26（文档）+ 24（画布）= 68 条**
- 疑似缺陷线索：**15 条**
- 存疑项：**6 条**
