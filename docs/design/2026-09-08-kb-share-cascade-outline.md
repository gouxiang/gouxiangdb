# 知识库「文档 + 画布」产品设计方案

> 版本：v1.0 ｜ 日期：2026-09-08
> 范围：分享（内外两套权限）、侧边目录、跨文档引用（@人 / @文档 / 画布内嵌预览与弹窗编辑）、文档名称、多文档级联（拖拽树 + 级联分享）、菜单选项卡
> 约束：零新增第三方依赖；颜色/间距/圆角/字号全部走 Tailwind `gx-*` token；图标只用 `src/components/icons.tsx` 自建 SVG；数据层 SQLite + Prisma；前后端复用现有 `KbApi` / `api/client` / `components/ui`。

---

## 0. 现状基线（审计结论）

| 能力 | 现状 |
|---|---|
| 团队权限 | `KbMember.role`：owner/editor/commenter/viewer；`RANK` 4/3/2/1 |
| 单文档授权 | `KbDocAcl`（docId+userId+role），按邮箱把"已知用户"提权到单文档 |
| 内容访问判定 | `requireDocAccess`：`max(kbRole, aclRole)`，editor 及以上可编辑 |
| 文档 | `KbDoc`：kbId/kind(doc|canvas)/title/content/searchText/软删；无 `parentId`、无分享字段 |
| 编辑器 | WYSIWYG / 源码 / 预览三模式；块模型 `blocks.ts`；`/` 斜杠命令；无 `@` 引用 |
| 画布 | Drawnix 非受控组件 `DrawnixCanvas`，支持 `readonly`，内容整体替换用 `key` 重挂载 |
| 左侧导航 | `KbTree`：平铺、按 doc/canvas 分组、无层级、无选项卡、无拖拽 |
| 路由 | KB 全部在 `<RequireAuth>` 内；无公开/匿名访问路由 |

**核心缺口**：① 公开分享（无认证）端点与链接字段；② 文档父子层级；③ @引用与画布 embed 块；④ 树/拖拽/选项卡；⑤ 公开分享页。

---

## 1. 数据模型变更（Prisma）

### 1.1 `KbDoc` 新增字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `parentId` | `String?` | 父文档 id；`null` = 顶级。构成不限层级树 |
| `shareEnabled` | `Boolean @default(false)` | 外链分享总开关 |
| `shareToken` | `String? @unique` | 公开访问令牌（开启时生成，关闭时置空） |
| `shareRole` | `String @default("viewer")` | 外链权限：`viewer`(仅可见) / `editor`(可编辑) |
| `shareIncludeChildren` | `Boolean @default(false)` | 级联分享：本节点分享时是否连同整棵子树 |

索引：`@@index([kbId, parentId])`、`@@index([shareToken])`。

> **内部成员"仅可见/可编辑"不新增字段**：内部访问以知识库团队角色（+既有 KbDocAcl 提权）为准。分享弹窗里的"内部成员：仅可见/可编辑"是**对团队当前权限的说明与快捷调整入口**（可批量把团队成员设为 viewer/editor），不是第二套独立存储。见 §4.1。

### 1.2 树完整性约束（应用层维护）

- 一个 doc 的 `parentId` 必须：同 `kbId`、未删除、且**不是自己或自己的后代**（防循环嵌套）。
- 移动子树 = 更新单个节点的 `parentId`（后代随之外层继承，无需递归改）。
- 删除父文档（软删）→ 子树保留 `parentId` 悬空；回收站"彻底删除"时递归硬删整棵子树；恢复时若父仍在回收站，节点挂到顶级（`parentId=null`）并提示。

### 1.3 迁移

新增一个迁移：`ALTER TABLE kb_docs ADD COLUMN parentId ...` 等；历史文档 `parentId=null`（全部顶级，平铺，与现状一致）。

---

## 2. 信息架构与页面布局

### 2.1 编辑页 / 画布页顶栏（由右至左）

```
[返回] [类型图标] [文档名(原地重命名)]  ……  [保存状态] [保存] [分享] [版本历史]
```

- **「分享」按钮**：位于"保存"右侧、"版本历史"左侧。图标 `share`（新增 SVG）。仅 `canEdit`（owner/editor）可见可点；viewer/commenter 看到但点击提示"仅可编辑者可管理分享"（或直接只读展示当前链接）。
- **文档名**：头部显著位置，点击即原地编辑（已有 input，保留并在预览/分享页同步）。

### 2.2 分享弹窗（ShareModal）

居中 Modal（复用个人中心同款 `animate-pcdialog-in`），宽 520px，分区：

```
┌─ 分享「{文档名}」 ─────────────────────┐
│ ① 内部成员（知识库团队）                 │
│   团队成员权限：( ) 仅可见  (•) 可编辑    │
│   说明：以知识库成员角色为准，此设置批量调整 │
│                                         │
│ ② 外部链接                              │
│   [开关] 开启链接分享                     │
│   链接：https://host/s/{token}  [复制]   │
│   持链者权限：( ) 仅可见  ( ) 可编辑       │
│   ☐ 同步分享下级文档（本级及全部子文档）    │
│                                         │
│              [完成]                       │
└─────────────────────────────────────────┘
```

- 关闭外链分享 = `shareEnabled=false`、`shareToken=null`（旧链接立即失效）。
- 复制成功 toast "链接已复制"。

### 2.3 左侧导航（KbTree 升级为树 + 选项卡）

- 顶部**选项卡**：`文档` / `画布`（ segmented control）。切到"文档"只列 kind=doc 的树；"画布"只列 kind=canvas（画布为平铺列表，不参与父子级联——级联仅文档树）。
- 文档选项卡下：**缩进树状结构**，每行：展开/收起箭头（有子项时）、类型图标、标题、hover 出 `⋮` 菜单（新建子文档/重命名/删除/分享）。
- 拖拽：拖一个文档到另一个文档上 → 成为其子文档；拖到根区域 → 升为顶级。拖拽中目标高亮、"成为子文档/移到顶级"落点提示。
- 新建子文档：行内 `⋮ → 新建子文档`，直接以 `parentId=当前id` 创建并进入。

### 2.4 右侧悬浮目录（DocOutline）

- 仅文档（doc）有标题层级；画布不显示。
- 悬浮于正文右侧：`position: sticky`/`fixed`，宽 200px，`top` 跟随顶栏，不遮挡正文（正文区右侧预留 gutter，目录在 gutter 内）。
- 内容：解析 Markdown 标题（H1–H3）生成缩进树；点击平滑滚动（`scrollIntoView({behavior:'smooth'})`）；滚动时用 IntersectionObserver 高亮当前标题。
- **三种模式都显示**：编辑（WYSIWYG/源码）、预览、外链只读页。编辑态标题随内容增量更新（防抖重建）。

### 2.5 公开分享页（路由 `/s/:shareToken`）

- 独立布局，**不走 RequireAuth**（匿名可访问）。
- 顶栏：文档/画布图标 + 文档名 +（外链可编辑时）"编辑"入口 + "登录/在 GouXiangDB 中打开"。
- 内容区：文档 → 只读预览（viewer）或可编辑（editor，匿名编辑，保存走公开端点）；画布 → Drawnix 只读/可编辑。
- **左侧文档树**（仅当分享节点 `shareIncludeChildren=true` 或该 token 对应节点有可分享子树）：只列**被分享节点本级 + 其下级**，支持展开/收起/点击跳转（跳转到 `/s/{子token}` 或同 token 内切换——子文档通过级联分享用同一棵树的访问授权，见 §4.3）。

---

## 3. 核心交互流程

### 3.1 分享流程

1. 编辑页点「分享」→ 打开 ShareModal，拉取当前分享状态。
2. 内部权限：选"仅可见/可编辑"→ 调内部权限批量设置（见 §4.1）。
3. 外链：打开开关 → 后端生成 `shareToken`、返回链接；选 viewer/editor；可选"同步分享下级"。
4. 复制链接 → 剪贴板。
5. 持链者打开 `/s/:token`：
   - 后端按 token 找到根分享节点；校验节点未删除、分享开启。
   - 渲染根节点内容；若级联，左侧树列出子树，点击子文档 → 后端校验该子文档是否在"某开启了级联分享的祖先"之下，是则放行。
6. 外链 editor：匿名编辑后保存 → 公开 PUT 端点，按 `shareRole=editor` 放行，记 `updatedBy="anonymous:share"`。

### 3.2 侧边目录流程

- 进入文档 → 解析当前 Markdown 的 H1–H3 → 渲染目录。
- 编辑中内容变更（防抖 300ms）→ 重新解析 → 更新目录；标题块带稳定锚点 id（slug）。
- 点击目录项 → 平滑滚动到对应标题；滚动 → IntersectionObserver 判定当前可视标题 → 目录项高亮（`text-gx-accent` + 左侧 2px 蓝条）。

### 3.3 跨文档引用流程

**插入（编辑态）**：
1. 在 WYSIWYG/源码中输入 `@` → 弹出选择面板（MentionPicker），两个分组：
   - **成员**：当前知识库成员（头像色点 + 名称）。
   - **文档/画布**：当前知识库内未删除内容（图标 + 标题，按类型分组，可搜索）。
2. 选中：
   - 选**成员** → 插入"提及块"：`@{成员名}`，存 `userId`，渲染为 chip。
   - 选**文档/画布** → 插入"引用块"，存 `targetDocId`：
     - 文档 → 渲染为名称跳转链接 chip（图标 + 标题）。
     - 画布 → 插入**画布内嵌预览器块**（见 3.4）。
3. `@` 面板键盘可达：↑↓ 选择、Enter 确认、Esc 关闭；输入文字过滤。

**跳转（编辑/预览/分享）**：
- 内部用户点文档引用 → 新标签/当前跳转到 `/kb/:kbId/doc|canvas/:id`（无权限则见 §5.1）。
- 分享页点引用：
  - 被引文档在**同一分享子树内** → 跳转对应 `/s/...`。
  - 不在分享范围 / 无权限 → 显示"无权限访问该内容"占位（见 §5.1）。
- 成员提及 → 点击展示成员名片 popover（姓名/邮箱/角色）；匿名分享页不暴露成员邮箱，仅显示姓名。

**存储协议（Markdown）**：
- 提及：`@[u:userId|显示名]`
- 文档引用：`@[d:docId|标题]`
- 画布嵌入：独立块 ```` ```canvas-embed docId ```` （fenced code，预览/分享时替换为预览器；源码态显示为 code block）。
> 选 fenced code 存画布嵌入，保证 Markdown 源码可读、可版本 diff、不破坏既有块解析。

### 3.4 画布内嵌预览器 + 弹窗编辑

- 文档中画布引用块渲染为 `CanvasEmbed`：
  - **默认全尺寸展示有内容区域**：读取目标画布 JSON，计算元素包围盒（bounding box），自适应缩放到容器宽度，容器高度按宽高比（封顶 480px）。
  - **缩放**：
    - 快捷键：`Ctrl/Cmd + = / - / 0`（0 复位自适应）；Windows=Ctrl、macOS=Cmd。
    - 触控板：pinch 手势（wheel + ctrlKey）→ 缩放；两指滚动平移。
    - 鼠标滚轮：滚轮 = 平移/缩放按 Drawnix 原生；预览器内 `wheel` 按住 `?` 提示。
  - 预览器内工具条：「跳转至画布」（打开画布编辑页 `/kb/:kbId/canvas/:id`）、「编辑」（弹出画布编辑弹窗）。
- **画布编辑弹窗（CanvasEditModal）**：
  - 全屏 Modal（90vw × 86vh），内嵌 `DrawnixCanvas`（可编辑）+ 顶栏"保存/取消"。
  - 保存 → PUT 目标画布 content（走用户正常权限或外链 editor 权限）→ 关闭弹窗 → **文档内预览器用新 `key` + 新 content 重挂载，即时显示最新画布**。
  - 不离开当前文档即可编辑画布。

### 3.5 文档名称

- 编辑页头部 input（已有）保留，`onBlur`/Enter 提交重命名。
- 预览页、公开分享页顶部以同样字号/字重展示文档名（只读纯文本，外链无编辑权时不可改）。
- 重命名成功后同步左侧树标题（既有 rename mutation 已 invalidate docs 缓存）。

### 3.6 多文档级联

- 拖拽树：HTML5 drag/drop（或指针事件自绘）。拖动节点时记录 `draggingId`；落点：
  - 落在某行 → 目标 `dropTargetId`，显示"移动到「{目标标题}」下"；
  - 落在树顶部/空白 → `dropTargetId=null`，"移到顶级"。
- 提交 → `POST /api/kb/docs/:id/move { parentId }`，后端校验同库/非循环/权限，更新后返回；前端 invalidate 文档树。
- 展开/收起状态存本地（localStorage，按 kbId）。
- 级联分享：ShareModal 勾"同步分享下级"→ 保存时 `shareIncludeChildren=true`；后端在**访问判定**时让子树继承祖先的分享授权（不必给每个子文档生成 token；用"祖先存在开启级联的分享"判定）。关闭上级分享 → 子树外链访问随即失效（继承失效）。

### 3.7 菜单选项卡

- 左栏顶部 segmented：`文档` | `画布`。
- 文档 tab：树形（参与级联、可拖拽、可建子文档）。
- 画布 tab：平铺列表（复用现有分组渲染），不拖拽不级联。
- tab 选择持久化（localStorage）。

---

## 4. 权限判定规则（核心）

### 4.1 内部成员访问（已登录、走 `/api/kb/...`）

- **以知识库团队成员角色为准**（owner/editor/commenter/viewer），叠加既有 `KbDocAcl` 提权：`effective = max(kbRole, aclRole)`（沿用 `requireDocAccess`）。
- 分享弹窗"内部成员：仅可见/可编辑"：
  - "仅可见" = 把团队内 editor/commenter 成员对**该知识库**的角色不降低（不做降级，安全优先：不通过分享把已有编辑者降权）；该开关实际语义是**确保链接给内部 viewer 也只看不改**——内部人员点链接进入时，按其真实 kbRole 判定（viewer 自然只读）。
  - "可编辑" = 维持/确保团队成员可达 editor；若团队是 viewer-only 知识库，可一键把成员提为 editor（批量 upsert KbMember 或 KbDocAcl）。
  - **规则一句话**：内部访问永远取"知识库主权限 ∨ 单文档 ACL"的较高者，分享设置不削弱内部权限。

### 4.2 外部链接访问（匿名/持链，走 `/api/public/...`）

- **以分享设置为准**，与团队权限完全无关（持链者可能根本不是成员）。
- 判定：`shareEnabled=true` 且 token 有效且节点未删除 → 放行；
  - `shareRole=viewer` → 只读；
  - `shareRole=editor` → 可读可写（公开 PUT 端点，无需 JWT）。
- 公开端点**只暴露**：文档/画布 title/kind/content/updatedAt + 级联子树的 title/kind/id（不暴露成员邮箱、不暴露知识库其他文档、不暴露 searchText 之外的元数据）。

### 4.3 级联分享继承

- 节点 A `shareEnabled=true & shareIncludeChildren=true`：
  - A 及其整棵子树（任意深度）均可通过 A 的分享上下文被外链访问。
  - 访问子文档 D 时：后端判断 D 是否存在一个**祖先 A**（含自身）满足 `shareEnabled && shareIncludeChildren && 未删除`；是则按 A 的 `shareRole` 放行。
  - 子文档自身若也单独开了分享（有自己 token），取**较宽松**者（viewer<editor）。
- 未勾选级联：只有根节点本身可外链访问，子文档链接对外 404/403。
- 关闭 A 的分享 → A 与整棵子树外链立即失效（除非子文档另有独立分享）。

### 4.4 冲突规则总表

| 访问者 | 入口 | 判定来源 | 结果 |
|---|---|---|---|
| 团队成员 | 应用内打开 | kbRole ∨ docAcl（较高者） | 不受分享设置影响 |
| 团队成员 | 点分享链接 | 同上（已登录识别身份） | 按内部权限，不被外链降级 |
| 匿名/非成员 | 持分享链接 | 根节点 shareEnabled + shareRole | viewer/editor |
| 匿名 | 访问子文档 | 祖先级联分享 or 自身分享 | 命中则放行，否则 403 |
| 任何人 | 链接已关闭/删除 | token 失效 / 节点删除 | 404 失效页 |

---

## 5. 边界与异常场景（含提示文案方向）

| 场景 | 处理 | 文案方向 |
|---|---|---|
| 引用的文档/画布**无访问权限**（内部） | 引用 chip 渲染为禁用态 + 锁图标；点击 toast | "你无权访问该内容，如需查看请联系知识库所有者" |
| 引用目标在**分享范围外**（外链页） | chip 显示为"受限内容"占位，不可点 | "该内容未包含在本次分享范围内" |
| 引用目标**被删除** | chip 置灰 + 回收站图标 | "该内容已被删除" |
| 引用目标**被移动** | 引用按 docId 解析，移动不影响（docId 不变）；仅当移出可访问范围才按无权限处理 | 同无权限 |
| 分享**链接失效/关闭** | 公开页 404 态 | "分享链接已失效或被取消"，附"返回首页" |
| 文档**被删除**（含级联根） | 公开页/应用内 404 | "文档不存在或已被删除" |
| **循环嵌套**拖拽（把祖先拖到自己后代下） | 后端拒绝 + 前端拖拽时禁用非法落点 | "无法移动：不能将文档放到它自己的子级中" |
| 拖到**自己**上 | 视为无操作 | （落点不高亮、不提交） |
| 画布**空内容**嵌入 | 预览器显示空状态 | "空白画布"，仍可点编辑 |
| 外链 **editor 并发保存冲突** | 以最后写入为准（MVP 不做 OT）；updatedAt 乐观提示 | "已保存"；冲突罕见，后续版本加版本号 |
| 外链 **viewer 尝试编辑** | 编辑器只读，工具条无编辑按钮 | — |
| 目录**无标题** | 目录区显示空状态 | "暂无标题，使用标题样式后自动生成目录" |
| 提及成员**已退出知识库** | chip 保留姓名 + "已离开" | "该成员已不在知识库" |
| 重命名**为空/超长** | 前端拦截 + 后端 zod 校验 | "标题不能为空 / 标题最长 120 字" |
| 恢复文档时**父级仍在回收站** | 挂到顶级 + 提示 | "原父级仍在回收站，文档已移到顶级" |
| 级联分享下**子文档单独改权限** | 取较宽松；子文档关闭自身分享不影响祖先级联 | — |

---

## 6. UI 视觉设计要点

- **弹窗**：分享/画布编辑弹窗复用 `bg-gx-surface`、`rounded-gx-lg`、`shadow-2xl`、`animate-pcdialog-in`；蒙版 `bg-black/30 animate-pcdrawer-fade`。
- **分享开关**：用现有开关样式（accent 色 = 开启）；单选权限用 segmented/radio，选中态 `bg-gx-accent-bg` + 左蓝条。
- **树**：缩进每层 16px；展开箭头 12px、`text-gx-text-hint`；当前项 `bg-gx-accent-bg` + 左 3px 蓝条；拖拽目标行 `ring-2 ring-gx-accent`；chip 用 `bg-gx-bg rounded-gx-sm`。
- **目录**：`text-gx-12 text-gx-text-tertiary`；H1 常规、H2/H3 逐级缩进变淡；当前项 `text-gx-accent font-medium` + 左 2px 蓝条。
- **引用 chip**：文档 `text-gx-accent` + doc 图标；画布 `text-gx-warning`? 否——用 fieldColor 风格，画布用紫灰 token 或 accent；成员用头像色点（AVATAR_PALETTE）。无权限 chip：`text-gx-text-hint` + 锁图标。
- **画布预览器**：`rounded-gx-md border border-gx-separator bg-gx-bg`，工具条悬浮右上角 `bg-gx-surface/90 backdrop-blur`。
- **选项卡**：segmented `bg-gx-bg rounded-gx-md p-0.5`，激活项 `bg-gx-surface shadow-sm`。
- 全部图标自建 SVG（share/link/lock/chevronRight/dragHandle/maximize/edit 等），**不用 emoji**。

---

## 7. API 端点清单（新增/修改）

### 7.1 认证区（`/api/kb`，需登录）

| Method | Path | 说明 |
|---|---|---|
| PATCH | `/docs/:id` | 扩展：支持 `parentId`（移动）——或独立 move 端点 |
| POST | `/docs/:id/move` | **新增** `{ parentId: string \| null }`，校验同库/非循环/权限 |
| GET | `/docs/:id/share` | **新增** 返回 `{ shareEnabled, shareRole, shareIncludeChildren, shareUrl, internalRole }` |
| POST | `/docs/:id/share` | **新增** `{ shareEnabled, shareRole, shareIncludeChildren }`，生成/吊销 token |
| POST | `/docs/:id/share/internal` | **新增** `{ role: "viewer"\|"editor" }` 批量调整团队内部权限 |
| GET | `/:kbId/docs` | **修改** 返回字段增加 `parentId`；树由前端按 parentId 组装（或后端返回 tree） |
| POST | `/:kbId/docs` | **修改** 接受可选 `parentId`、`title` |

### 7.2 公开区（`/api/public`，匿名，按 shareToken）

| Method | Path | 说明 |
|---|---|---|
| GET | `/s/:token` | 返回分享根节点 `{ doc: {id,title,kind,content,canEdit,updatedAt}, tree: [...子树摘要] }` |
| GET | `/s/:token/doc/:docId` | 级联子树内某文档内容（后端校验祖先级联） |
| PUT | `/s/:token/doc/:docId/content` | 仅 `shareRole=editor` 放行；匿名保存 |

> 公开端点不挂 `requireUserId`；用独立 `requireShareAccess(token, docId?, needEdit?)` 守卫。

---

## 8. 前端文件规划

| 文件 | 动作 | 职责 |
|---|---|---|
| `prisma/schema.prisma` + 迁移 | 改 | KbDoc 加 5 字段 + 索引 |
| `api/routes/kb.ts` | 改 | move/share/internal；docs 返回 parentId；create 接受 parentId；级联/循环校验 |
| `api/routes/public.ts` | 新增 | 匿名分享访问 + 公开保存 + share 守卫 |
| `api/index.ts` | 改 | 挂载 `/api/public`（不挂认证中间件） |
| `api/client.ts` | 改 | KbApi 增 move/share/internal；新增 `PublicApi`；KbDocDTO 加 parentId/share 字段 |
| `features/kb/kb-hooks.ts` | 改 | useMoveDoc/useShareDoc/usePublicDoc 等 |
| `features/kb/KbTree.tsx` | 改 | 树组装、拖拽、展开收起、选项卡、子文档新建 |
| `features/kb/ShareModal.tsx` | 新增 | 分享弹窗（内外两套 + 级联勾选） |
| `features/kb/DocOutline.tsx` | 新增 | 右侧悬浮目录（滚动监听/高亮/平滑跳转） |
| `features/kb/MentionPicker.tsx` | 新增 | `@` 选择面板（成员/文档/画布） |
| `features/kb/CanvasEmbed.tsx` | 新增 | 画布内嵌预览器（包围盒自适应/缩放/工具条） |
| `features/kb/CanvasEditModal.tsx` | 新增 | 画布编辑弹窗（保存→预览刷新） |
| `features/kb/markdown.ts` / `blocks.ts` | 改 | @提及/引用/画布 embed 的序列化与解析 |
| `features/kb/WysiwygEditor.tsx` | 改 | `@` 触发、提及/引用 chip 渲染、画布 embed 块 |
| `features/kb/DocEditorPage.tsx` / `CanvasEditorPage.tsx` | 改 | 挂分享按钮、目录；画布 embed 编辑回调 |
| `features/kb/PublicSharePage.tsx` | 新增 | `/s/:token` 匿名页（预览/编辑 + 左树） |
| `App.tsx` | 改 | 加 `/s/:token` 公开路由（RequireAuth 之外） |
| `components/icons.tsx` | 改 | 新增 share/link/lock/dragHandle 等 SVG |

---

## 9. 落地顺序（里程碑）

1. **M1 数据层**：Prisma 字段 + 迁移；后端 move/share/internal + 公开端点 + 守卫；client/hooks。
2. **M2 分享**：ShareModal + 公开分享页（文档/画布只读 → 可编辑）+ 级联左树。
3. **M3 级联树 + 选项卡**：KbTree 树/拖拽/展开/选项卡；move 闭环；循环校验。
4. **M4 侧边目录**：DocOutline 三模式挂载 + 滚动高亮。
5. **M5 跨文档引用**：@mention 协议 + MentionPicker + chip 渲染 + 跳转/无权限态。
6. **M6 画布嵌入**：CanvasEmbed 包围盒/缩放 + CanvasEditModal 保存刷新。
7. **M7 收尾**：文档名三页同步、边界文案、typecheck + 单测 + 真机走查。

每个里程碑结束：`pnpm --filter @gx/web typecheck` + 后端 typecheck + 相关单测全绿，再进入下一个。
