# 权限体系现状盘点（PERMISSION-MATRIX）

> ## ✅ 2026-10-06 状态更新（先读这条，正文为历史快照）
>
> 下方盘点正文冻结于 **2026-09-20 / 基线 `ca2a530`**，其中「总门、三态开关、shadow 对拍、READY 门」等描述的**机制已被整体删除**。截至 2026-10-06：
>
> - **引擎永久单一化**：M4 引擎（`engine.decide()`，读 `auth_policies` + `nav_nodes`）是唯一、无条件、永久生效的执法路径（ADR-0057）。三态开关 `GX_AUTHZ_ENGINE`、三个 READY 门（`AUTHZ_ENFORCE_READY` / `FIELD_MASK_ENFORCE_READY` / `NAV_PRUNE_ENFORCE_READY`）、shadow 对拍/drift 账本**全部物理删除**（`configAuthz.ts`、`shadow.ts` 文件已删）。
> - **fail-closed**：引擎抛错 → 503 `权限服务暂不可用`（记 `authz_engine_error`，不回落旧决策）；资源无活 nav 节点 → 403（记 `authz_engine_unresolved`）。删库/删知识库仍走 conjunction（只减不增）。
> - **恒定执行**：字段掩码五出口、行级条件、tree/menu/面包屑剪枝随引擎永久生效，无开关。
> - **能力层保留**：`libraryPolicy` 为引擎之上的能力/UI 形状层；`authzManage` 与执法正交；`share_link` 建链位已落地。第一代旧三表仅为台账、不参与放行。
> - 权威结论以 **ADR-0057** 与 README 文首为准。
>
> 正文（§0 起）作为时点证据原样保留，行号均对应 2026-09-20 基线，**勿据其当前值操作**。

> **本文性质**：现状盘点，**不含任何已拍板决策**，也不修改任何业务代码。
> 所有结论须可凭 `文件:行号` 复核；无证据处一律写「未核实 / 代码中未见」，不凭印象补写。
> **最关键的现状（务必先读 §0.1）：新权限引擎（M4）默认完全不生效**。任何「收缩权限」方案若不先翻这个闸门，改了也不生效。

- 盘点日期：2026-09-20
- 代码基线：`ca2a530`
- 取证纪律：**只认 import 证据与实际代码，不认注释**（本项目有过注释过期先例）。凡引用注释处均标注「注释，非代码证据」。
- 关联文档：`docs/decisions/AUTHZ-LEGACY-GUARD-CLEANUP.md`（旧守卫退役清单，M4 不执行）、`docs/runbooks/`（引擎翻门禁清单与命令，见 runbook 索引）

---

## 0. 三条必须先看的前提

### 0.1 新权限引擎（M4）默认完全不生效 —— 本次收缩方案的总前提

`apps/api/src/configAuthz.ts` 里有三个独立的「就绪门」，只有门为 true **且** `GX_AUTHZ_ENGINE=on` 才真正生效：

| 门 | 位置 | 当前值 | 生效条件 | 控制范围 |
|---|---|---|---|---|
| 节点守卫总门 `AUTHZ_ENFORCE_READY` | `configAuthz.ts:17` | **false** | `=true` 且原始模式 `on` | 七守卫 / kb 两守卫的**决策是否以引擎为准** |
| 字段掩码门 `FIELD_MASK_ENFORCE_READY` | `configAuthz.ts:64` | true | `=true` 且**原始**模式 `on`（`fieldMaskEnforceEffective`，`configAuthz.ts:66-69`） | 字段级读投影 / 写键校验 / 物理缺席 |
| 导航剪枝门 `NAV_PRUNE_ENFORCE_READY` | `configAuthz.ts:82` | true | `=true` 且**原始**模式 `on`（`navPruneEnforceEffective`，`configAuthz.ts:85-87`） | tree / menu / 面包屑的服务端剪枝 |

证据链：

1. `GX_AUTHZ_ENGINE` **默认 off**：`configAuthz.ts:22-26`（`resolveAuthzEngineMode`，缺省/未知/空值一律回 `"off"`），`config.ts:341` 用同函数解析出 `authzEngine`。
2. 即使显式设 `on`，在 `AUTHZ_ENFORCE_READY=false` 时会被**降级为 shadow**：`configAuthz.ts:32-45`（`effectiveAuthzMode`，命中时 `return "shadow"` 并 warn 一次）。
3. shadow 态下七守卫与 kb 守卫**仍以旧决策为准返回**，引擎只做对拍分类计数、不改响应、不抛错：`guards.ts:79-88`（`shadowBase`，`authzShadowActive()` 为假时直接 return）；kb 侧无独立对拍缝，由 `enforceKbAuthority`（`routes/kb/shared.ts`）经 `enforceOrLegacy` 在 shadow 态内部正向对拍。
4. off 时 `authzShadowActive()=false` → Base 对拍缝为空操作；kb 侧 `enforceOrLegacy` off 态零引擎 IO 直接返回 legacy，**零新增 SQL**。

**结论**：当前任何角色/成员数据来源都是**旧三表**（`members` / `kb_members` / `kb_doc_acls`），由 `guards.ts` 的五个守卫判定。`auth_policies` / `nav_nodes` 这套新模型只在两处真正参与判定（见 §0.3 例外）。

### 0.2 并存的两套权限模型（不是一套）

| 模型 | 权限单位 | 数据来源 | 生效与否 | 主要门点 |
|---|---|---|---|---|
| **旧角色模型（实际生效）** | 五枚 `PermissionSet` 位 + 知识库四档 + 文档三档 | `members` / `kb_members` / `kb_doc_acls` | **生效** | `guards.ts:48-172`、`routes/kb/shared.ts:15-98` |
| **组织动作模型（部分生效）** | 五枚 `OrgAction`（`manage_departments` / `manage_members` / `manage_roles` / `manage_menu` / `manage_share`） | `roles` / `role_assignments` / `departments` | **生效**（仅 v1 企业面） | `middleware/authActive.ts:31-42`、`domain/org/authorization.ts:113-120` |
| **资源动作模型 M4（未生效）** | 七枚 `ResourceAction`（`r/c/u/d/comment/manage_share/manage_schema`） | `auth_policies` / `nav_nodes` | **不生效**（见 §0.1） | `domain/authz/evaluate.ts:96-108` |

两套模型互不相通，各自独立判定。注意 `manage_share` 在两套里**同名不同命名空间**：`packages/shared-types/src/org.ts:5-24` 明确注释第五枚组织动作与资源空间 `manage_share` 是两个概念；`domain/authz/policyAccess.ts:41-55` 用取或把它们连起来（详见 §3.6）。

### 0.3 例外：新模型数据已在写、且两处**不看 flag 直接用引擎**

- **策略双写投影**：旧三表写点会向 `auth_policies` 同步写（`domain/authz/projection.ts` 的 `syncBaseMemberTx` / `syncKbMemberTx` / `syncDocAclTx`，调用点如 `routes/bases.ts:176/404/438/534`、`routes/kb/members.ts:67`、`routes/kb/acl.ts:71`）。即**新表已经有数据**，只是没人读它做决策。
- **不看 `GX_AUTHZ_ENGINE` 的新模型使用点**（这些端点默认可达）：
  - `GET/PUT /api/v1/nodes/:id/policies`、`GET /api/v1/nodes/:id/effective` —— 授权判定直接调引擎 `decide`（`routes/v1/policies.ts:58/73/115/119` → `domain/authz/policyAccess.ts:17-55`），注释与代码均无 `effectiveAuthzMode` 判断（`domain/authz/policyAccess.ts:1-15` 只 import `decide` / `resolveSubject`）。
  - `GET /api/v1/authz/visible-scope` 等探针同理（`routes/v1/index.ts:32-34`，注释明写「不受 GX_AUTHZ_ENGINE off/shadow 影响」——注释，非代码证据；但其挂载无条件，是真）。
- **挂载默认开**：`config.ts:327` `enterpriseOrg: env.GX_ENTERPRISE_ORG !== "off"` → **默认 on**；`config.ts:329` `enterpriseNav` 同理默认 on；二者任一 on 即挂载整个 `/api/v1`（`app.ts:155-165`）。所以上述端点在出厂配置下**可达**。

---

## 1. 权限位总表

### 1.0 五枚权限位与五档角色的映射

定义：`packages/shared-types/src/permissions.ts:24-30`（接口）/ `:33-69`（矩阵）/ `:71-73`（`permissionsForRole`，未知名角色回落 `viewer`）。

| 权限位 | owner | creator | editor | commenter | viewer |
|---|---|---|---|---|---|
| `canManageBase`（管理 Base 设置/成员/分享/删除） | ✅ | ❌ | ❌ | ❌ | ❌ |
| `canManageSchema`（增删字段、改表结构） | ✅ | ✅ | ❌ | ❌ | ❌ |
| `canEditData`（增删改记录） | ✅ | ✅ | ✅ | ❌ | ❌ |
| `canComment`（发表评论） | ✅ | ✅ | ✅ | ✅ | ❌ |
| `canView`（查看） | ✅ | ✅ | ✅ | ✅ | ✅ |

后端取值唯一入口：`guards.ts:56-62`（`permissionsOf` → `roleOf` → `permissionsForRole`）；**无 `members` 行时返回全 false**（`guards.ts:58-60`），语义等价于「非成员即全部拒绝」。

前端拿到的就是这份 DTO：`GET /api/bases/:baseId` 返回 `permissions`（`routes/bases.ts:204,227`），列表 `GET /api/bases` 同理（`routes/bases.ts:149`）。

> 注：`canView` 五档全为 true，因此**它不是真正的闸门**；真正的「能不能看」由 `members` 表里有没有这一行决定（`guards.ts:48-53` + `:58-60`）。

---

### 1.1 `canManageBase`

| 项 | 内容 |
|---|---|
| 含义 | 管理 Base：改名/改图标、删除库、成员增删与改角色、分享链接增删改 |
| 后端判定点 | `guards.ts:146-158`（`requireCanManageBase`）。另 `permissionsOf` 用于**只产出 DTO、不拦截**的场景（`routes/bases.ts:204`） |
| 覆盖路由 | `PATCH /api/bases/:baseId`（`bases.ts:235`）、`DELETE /api/bases/:baseId`（`bases.ts:263`）、`POST /api/bases/:baseId/members`（`:389`）、`PATCH /api/bases/:baseId/members/:memberId`（`:424`）、`DELETE /api/bases/:baseId/members/:memberId`（`:448`）、`GET /api/bases/:baseId/share`（`:464`）、`POST`（`:481`）、`DELETE /share/:linkId`（`:510`）、`DELETE /api/records/trash/:id` 永久删（record/field/table 三分支：`records.ts:930/949/957`） |
| 知识库等价物 | **不是同一枚位，是另一套 owner-only 内联判断**：改库名 `routes/kb/index.ts:133-137`、删库 `routes/kb/index.ts:182-185`、加成员 `routes/kb/members.ts:47-50`、移除成员 `routes/kb/members.ts:84-87`、团队权限批量调整 `routes/kb/sharing.ts:95-96`、彻底删除 `routes/kb/recycle.ts:21-22` |
| 前端入口 | 库设置名称只读/可编辑 `SettingsPage.tsx:269,283,296,304`；危险操作区 `SettingsPage.tsx:343`；左侧 tab 过滤 `SettingsPage.tsx:152,154`；成员行角色下拉与移除 `MembersPanel.tsx:126,137`；邀请区 `MembersPanel.tsx:155`；分享面板 `SharePanel.tsx:72`；顶栏「分享」`TopBar.tsx:168` |
| 无权限表现 | **隐藏（不渲染）**：`SettingsPage.tsx:152/343`、`MembersPanel.tsx:126/137/155`、`SharePanel.tsx:72`。<br>**例外（待裁决）**：`TopBar.tsx:168` 顶栏「分享」是 `disabled={!canManageBase}`，属管理类却做成灰色可点，违反 §2.1 规则 P1，且无测试锁定（见 §2.3） |

---

### 1.2 `canManageSchema`

| 项 | 内容 |
|---|---|
| 含义 | 增删字段、改表结构，以及视图的新建/删除/复制/元数据修改 |
| 后端判定点 | `guards.ts:132-144`（`requireCanManageSchema`） |
| 覆盖路由 | 表：`POST /api/tables`（`tables.ts:82`）、`PATCH /api/tables/:tableId`（`:192`）、`DELETE`（`:218`）、`POST /:tableId/duplicate`（`:249`）。<br>字段：`POST /api/fields`（`fields.ts:104`）、`PATCH /:fieldId`（`:175`）、`DELETE /:fieldId`（`:239`）、`POST /:fieldId/move`（`:251`）。<br>视图：`POST /api/views`（`views.ts:87`）、`DELETE /:viewId`（`:194`）、`POST /:viewId/duplicate`（`:216`）。<br>回收站：`POST /api/records/trash/:id/restore` 的 field / table 分支（`records.ts:840/878`） |
| 复合判定（易漏） | `PATCH /api/views/:viewId` 只过 `requireCanView`（`views.ts:138`），随后**手写二次判断**：非 personal 视图且 `!perm.canManageSchema` → 403「该视图已锁定」（`views.ts:144-148`）；personal 视图的 name/order 仍限 schema（`views.ts:157-169`）；`lockMode` 恒限 schema（`views.ts:162-165`） |
| 知识库等价物 | 建文档/画布 `routes/kb/docs.ts:66-71`（`RANK[role] >= RANK["editor"]`）；授文档权限 `routes/kb/acl.ts:41-42`；找回文档 `routes/kb/docs.ts:299-301` |
| 前端入口 | 视图切换器：`ViewSwitcher.tsx:194`（重命名/删除的视图操作菜单）、`ViewSwitcher.tsx:243`（新建视图）；L2 表操作菜单 `SecondaryNavTableOps.tsx:136`（`rowMenuItems` 返回空数组 → 三点菜单不出现）、`SecondaryNavTableOps.tsx:158`（「新建数据表」整条不渲染）；字段编辑器 `FieldEditorSheet.tsx:274,420,428`；表单设计器 `FormDesigner.tsx:468,575,690`；详情布局 `DetailView.tsx:61,170`；网格启动字段编辑 `GridView.tsx:245,588`；视图设置面板 `ViewSettingsPanel.tsx:39` |
| 无权限表现 | **隐藏（不渲染）**：`ViewSwitcher.tsx:194/243`、`SecondaryNavTableOps.tsx:158`、`FieldEditorSheet.tsx:428` 等。<br>**例外（待裁决）**：`TopBar.tsx:151`（新建视图）、`:176`（复制视图）、`:185`（删除表）均用 `disabled={!canManageSchema}`。<br>**同一能力在两处表现相反**：ViewSwitcher 隐藏 vs TopBar 置灰，这是代码事实而非推测 |

---

### 1.3 `canEditData`

| 项 | 内容 |
|---|---|
| 含义 | 增删改记录（含批量修改/删除、CSV 导入、清空表、回收站恢复记录） |
| 后端判定点 | `guards.ts:118-130`（`requireCanEditData`）；CSV 导入是**手写二次判断** `records.ts:608-609`（先 `requireCanView`，再 `if (!perm.canEditData) throw 403`） |
| 覆盖路由 | `POST /api/records`（`records.ts:141`）、`PATCH /:recordId`（`:373`）、`DELETE /:recordId`（`:441`）、`POST /bulk-delete`（`:480`）、`POST /bulk-update`（`:531`）、`POST /csv-import`（`:608`）、`POST /trash/:id/restore` 的 record 分支（`:812`）、`POST /api/tables/:tableId/clear`（`tables.ts:441`） |
| 前端入口 | 工具栏「新建记录」`GridToolbarSettingsRow.tsx:57,58,81`（disabled + 文案「无编辑权限」）；顶栏「导入 CSV」`TopBar.tsx:181`（不渲染）；工具栏「导入」`GridToolbar.tsx:184-185`（不渲染）；工具栏「清空表」`GridToolbar.tsx:248-249`（不渲染）；顶栏「清空表」`TopBar.tsx:184`（不渲染）；回收站「恢复」`TrashPage.tsx:194-197`（disabled + 文案「无编辑权限」）；单元格编辑拦截 `GridView.tsx:292,319,366`；抽屉编辑 `RecordDrawer.tsx:213,413` |
| 无权限表现 | **混合口径（本项目刻意如此）**：数据编辑类保留 disabled + 原因（新建记录、回收站恢复）；写入/破坏性入口不渲染（导入 CSV、清空表）。依据：`GridToolbarSettingsRow.tsx:81`、`TrashPage.tsx:194-197` 对照 `GridToolbar.tsx:184,248`、`TopBar.tsx:181,184`；且两类都被测试显式锁定（见 §2.2） |

---

### 1.4 `canComment`

| 项 | 内容 |
|---|---|
| 含义 | 发表评论（不等于删评论；删他人评论另有 author / owner / creator 二次判定） |
| 后端判定点 | `guards.ts:160-172`（`requireCanComment`）；**二次业务判定**：`comment.userId !== userId && role !== "owner" && role !== "creator"` → 403 无权删除他人评论（`records.ts:760-764`） |
| 覆盖路由 | `POST /api/records/:recordId/comments`（`records.ts:731`）、`DELETE /api/records/comments/:commentId`（`records.ts:761`） |
| 前端入口 | 评论输入框 `{permissions.canComment && (`（`RecordDrawer.tsx:351`）；删评论按钮 `RecordDrawer.tsx:244-245`（`canManageSchema \|\| canManageBase \|\| 自己是作者`） |
| 无权限表现 | **隐藏（不渲染）**：评论输入整块不出现（`RecordDrawer.tsx:351`），已有评论列表照常可见。**当前无任何测试锁定此口径**（§2.2 未含此项） |
| 口径落差（待核实） | 后端允许 owner/creator 删**任意**评论（`records.ts:762`）；前端用 `canManageSchema \|\| canManageBase` 近似同一集合creator/owner，`editor` 只能删自己的。当前两侧集合巧合一致，但表达方式脆弱——改角色矩阵时会漂移 |

---

### 1.5 `canView`

| 项 | 内容 |
|---|---|
| 含义 | 查看（五档全为 true，实际闸门是「是否 members 成员」） |
| 后端判定点 | `guards.ts:108-116`（`requireCanView`）；成员缺失 → 全 false（`guards.ts:58-60`）→ 403「无权访问该 Base」（`guards.ts:112`） |
| 覆盖路由 | Base：`GET /api/bases/:baseId`（`bases.ts:204` 手写 `!perm.canView` 判）、`GET /:baseId/stats`（`:279`）、`GET /:baseId/erd`（`:302`）、**`GET /:baseId/members`（`:368`）**。<br>表：`GET /api/tables`（`tables.ts:55`）、`GET /:tableId`（`:166`）、`GET /:tableId/export.csv`（`:408`）。<br>字段：`GET /api/fields`（`fields.ts:94`）、`GET /lookup-targets`（`:288`）。<br>视图：`GET /api/views`（`views.ts:72`）、`GET /:viewId`（`:127`）、`PATCH /:viewId`（`:138`，复合见 §1.2）。<br>记录：`GET /api/records`（`records.ts:68`）、`GET /trash`（`:218`）、`GET /search`（`:283`）、`GET /:recordId`（`:347`）、`POST /csv-import`（`:608`）、`GET /:recordId/comments`（`:706`）。<br>全局搜索：`routes/search.ts:18`（`requireUserId` 后由服务层按 membership 过滤） |
| 无权限表现 | **整页无权限态**（既非无限 loading 也非假空态）：PERM-04 / PERM-05 已修（`KNOWN-ISSUES.md:181`，commit `4f58f05`） |
| **PERM-A3（待裁决）** | 只要能进库（任意成员），`GET /api/bases/:baseId/members` 就**返回全部成员邮箱**（查询结果 `bases.ts:371-383`，其中 email 在 `:379`），前端无条件渲染（`MembersPanel.tsx:119`），设置页「成员」tab 也无 `canManageBase` 过滤（`SettingsPage.tsx:315`；只有 danger tab 被过滤，见 `SettingsPage.tsx:152`）。即**阅读者可见全库成员邮箱**。是否收紧未定 |

---

### 1.6 第二套：五枚组织动作 `OrgAction`（独立于上表，**立即生效**）

定义：`packages/shared-types/src/org.ts:14-25`。判定件：`requireOrgAction`（`middleware/authActive.ts:31-42`）→ `hasOrgAction`（`domain/org/authorization.ts:113-120`）。

默认系统角色授予（`apps/api/src/domain/org/roles.ts:39-51`）：**仅 `role_owner` 持全部五枚动作**（`actions: [...ORG_ACTIONS]`，`roles.ts:45`）；`role_creator / editor / commenter / viewer` 的 `actions` 均为**空数组**（`roles.ts:47-50`）。

| 动作 | 覆盖端点（证据） | 前端入口 | 无权限表现 |
|---|---|---|---|
| `manage_departments` | `POST /api/v1/org/departments`（`departments.ts:22`）、`PATCH /:id`（`:38`）、`DELETE /:id`（`:58`）。**读端点无动作门**（`departments.ts:4` 注释写「读：登录用户全员可读」，注释，非代码证据；读端点确实未见 `requireOrgAction`） | 通讯录入口 `features/workspace/lib/nav-gate.ts:36-38` | 入口不渲染 |
| `manage_members` | `POST /api/v1/org/members/invite`（`members.ts:46`）、`POST /`（`:58`）、`POST /:id/departments`（`:68`）、`POST /:id/disable`（`:81`）、`POST /:id/reactivate`（`:91`） | 同上 | 入口不渲染 |
| `manage_roles` | `POST /api/v1/org/roles`（`roles.ts:15`）、`PATCH /:id`（`:31`）、`DELETE /:id`（`:42`）、`PUT /:id/assignments`（`:64`） | 同上 | 入口不渲染 |
| `manage_menu` | `POST/PATCH/DELETE /api/v1/nav/groups`、`GET /api/v1/nodes/:id/move-impact`、`POST /api/v1/nodes/:id/move`（`routes/v1/nodes.ts:18,26,44,52,71,81`） | `nav-gate.ts:45-47`（原导航编排入口已下线，此判定仅作兜底） | 入口不渲染 |
| `manage_share`（组织空间） | 与资源空间取或后用于 `PUT /api/v1/nodes/:id/policies`（`domain/authz/policyAccess.ts:45-55`） | 权限分区 `nav-gate.ts:61-63` | 分区不渲染 |

**读侧无门（收缩权限的重点靶点）**：`GET /api/v1/org/members`（`members.ts:22-26`）、`GET /:id`（`:29-34`）、`GET /:id/effective-roles`（`:37-43`）、`GET /me/effective-roles`（`:15-19`）**均只有 v1 统一的 `requireActiveUser`**（`routes/v1/index.ts:30`），**没有任何 `requireOrgAction`**。返回体含全员 `email`（DTO `domain/org/memberDirectory.ts:58-77`，查询 select 含 email 见 `:119`）。即：**任何登录且未停用的账号可读全组织成员姓名/邮箱/部门/角色**。文件头注释写「读：登录用户全员可读（总监裁决 3）」（`members.ts:2`，注释，非代码证据）。

---

### 1.7 第三套：七枚资源动作（M4 引擎，**当前不生效**，仅供方案评估）

定义：`packages/shared-types/src/authz.ts:11-29`（`ResourceAction` / `RESOURCE_ACTIONS`）。旧角色 → 动作集映射（回填与引擎共用同一份）：`authz.ts:42-74`。

| 旧角色 | 映射动作集 | 位置 |
|---|---|---|
| base owner | `r,c,u,d,comment,manage_share,manage_schema` | `authz.ts:43` |
| base creator | `r,c,u,d,comment,manage_schema` | `authz.ts:44` |
| base editor | `r,c,u,d,comment` | `authz.ts:45` |
| base commenter | `r,comment` | `authz.ts:46` |
| base viewer | `r` | `authz.ts:47` |
| kb owner | `r,c,u,d,comment,manage_share` | `authz.ts:50` |
| kb editor / doc editor | `r,c,u,d,comment` | `authz.ts:51` / `authz.ts:56` |
| kb / doc commenter | `r,comment` | `authz.ts:52` / `authz.ts:57` |
| kb / doc viewer | `r` | `authz.ts:53` / `authz.ts:58` |

第四层（字段掩码 `FieldMask`，`authz.ts:104-107`）：命中 allow 之上的收窄清单（`allowFields` / `readOnlyFields`），缺省 = 不裁剪。**仅在新引擎字段掩码门生效时有意义**（§0.1）。

---

## 2. 前端口径规则

### 2.1 可执行规则（现状，来自代码而非口头约定）

**规则 P1（分类门）**：判断标准永远是「这个操作属于哪一类」，**不是**「有没有权限」。

- **A 类 = 管理类 / 配置类 / 破坏性操作**（删库、改库名、新建文档画布、改成员角色、删视图、导入、清空表、彻底删除）→ 无权限时**不渲染**，用户根本看不到入口存在。
- **B 类 = 数据编辑类**（表格工具栏「新建记录」、回收站「恢复」）→ **保留 disabled + 原因提示**，用户需要知道「我能看但不能改」。

**规则 P2（工程红线）**：A 类**禁止**写成 `disabled={!canXxx}` 假装禁用；B 类**禁止**改成隐藏。

**规则 P3（入口唯一）**：同一能力只允许一处入口——历史上出现过第二处无门控入口（PERM-02「清空表」，`KNOWN-ISSUES.md:180`），现由计数断言守住（`grid-toolbar-permission.test.tsx:71`：`countOf(src, 'label="清空表"')` 必须等于 1）。

**规则 P4（权限源单一）**：工具栏只读两种权限位，不得引入第三个数据源（`grid-toolbar-permission.test.tsx:98-101`：props 类型必须严格是 `{ canEditData: boolean; canManageSchema: boolean }`）。

**规则 P5（工作区级入口，fail-closed）**：未知入口不猜、不兜底放行，一律 `return false`；探针 loading 期间也按无能力处理（`features/workspace/lib/nav-gate.ts:83-103`，其中 loading 在 `:89`、未知路径在 `:99-101`）；静态内容型入口（`/help`）例外。不做 disabled 假入口（`WorkspaceSettingsSectionGating.test.tsx:132-137`）。

### 2.2 被哪些测试锁住

| 测试文件 | 用例名 | 锁住的组件 / 口径 |
|---|---|---|
| `apps/web/src/features/settings/perm-hide-gating.test.ts` | `KB 新建文档 / 画布由 canCreate 门控，不再 disabled（第四批：入口从 KB 首页移到 L2）` | `SecondaryNavKbOps.tsx`（不渲染；并断言 `KbHomePage.tsx` 不再有 `useCreateDoc`，防双入口） |
| 同上 | `库设置：名称无权限走只读文本；危险操作区（删库）整块不渲染` | `SettingsPage.tsx`（只读文本而非灰 input；danger 区块与左侧 tab 一起收掉） |
| 同上 | `视图切换器：新建 / 重命名 / 删除视图由 canManageSchema 门控，不再 disabled` | `ViewSwitcher.tsx`（同时保留「至少保留一个视图」这条**业务** disabled，与权限 disabled 区分） |
| 同上 | `回收站：彻底删除（不可逆）不渲染；恢复（数据编辑类）保留 disabled` | `TrashPage.tsx`（A/B 两类在同一文件内的对照） |
| 同上 | `成员与权限：角色下拉 / 移除对无权限与所有者行不渲染` | `MembersPanel.tsx` |
| 同上 | `红线：表格工具栏「新建记录」仍是 disabled + 原因，不许改成隐藏` | `GridToolbar.tsx` + `GridToolbarSettingsRow.tsx`（**B 类反例**被显式锁死） |
| `apps/web/src/features/grid/grid-toolbar-permission.test.tsx` | describe `PERM-02：清空表入口受 canEditData 门控，且是「不渲染」而非「置灰」`（4 条用例） | `GridToolbar.tsx`：入口唯一性、`canEditData &&` 门内、禁止 disabled 写法、SSR 三权限组合冒烟、props 类型收敛 |
| `apps/web/src/features/workspace/lib/nav-gate.test.ts` | 通讯录 / 权限管理 / fail-closed / loading / 未知路径各组用例 | `nav-gate.ts` 工作区级可见性（P5） |
| `apps/web/src/features/workspace/WorkspaceSettingsSectionGating.test.tsx` | `非 owner 且无任一管理动作：左栏不出现语义检索分区（fail-closed，不做 disabled 假入口）` 等 | `WorkspaceSettingsPage.tsx` 分区 gating（P5） |

### 2.3 现状破口（有代码证据，**未被任何测试覆盖**）

以下为管理类 / 破坏性操作却做成 disabled 灰色入口，与规则 P1 冲突：

| 位置 | 入口 | 当前写法 | 按 P1 应然 |
|---|---|---|---|
| `features/shell/TopBar.tsx:168` | 顶栏「分享」 | `disabled={!canManageBase}` | 不渲染 |
| `features/shell/TopBar.tsx:151` | 顶栏「新建视图」 | `disabled={!canManageSchema}` | 不渲染（同能力的 ViewSwitcher 版本是不渲染） |
| `features/shell/TopBar.tsx:176` | 「复制视图」菜单项 | `disabled={!canManageSchema}` | 不渲染 |
| `features/shell/TopBar.tsx:185` | 「删除表」菜单项（danger） | `disabled={!canManageSchema}` | 不渲染 |

补充证据：`TopBar.tsx:178-180` 的注释写的正是「写入/破坏性入口无权限时不渲染」，但紧邻的 `:185` 删除表仍是 disabled —— 注释与代码不自洽的现成例子。**是否统一、统一到哪一边，属待裁决项。**

---

## 3. 优先级与冲突处理规则（现状）

### 3.1 Base：单一来源，不存在优先级问题

一个 `(baseId, userId)` 在 `members` 里至多一行（`guards.ts:49-53` 按复合唯一键 `baseId_userId` 查询），角色经查表得权限位（`permissions.ts:71-73`）。因此：

- **没有部门继承**：`guards.ts:1-10` 的 import 只有 prisma / auth / shared-types / configAuthz / adapter，不含任何 `department` / `roleAssignment` 访问。
- **没有显式 deny**：无成员行时返回全 false（`guards.ts:58-60`），语义是「未授权」而非「禁止」。

### 3.2 知识库：库成员角色 ∪ 文档级独立 ACL → **取较高**（当前唯一真正的多来源合并）

证据 `routes/kb/shared.ts:74-98`（`requireDocAccess`）：

```ts
const kbRole  = await kbRoleOf(userId, doc.kbId);    // :77
const aclRole = await docAclRoleOf(userId, docId);   // :78
const effective =
  kbRole && aclRole ? (RANK[kbRole]! >= RANK[aclRole]! ? kbRole : aclRole) : (kbRole ?? aclRole); // :79-80
```

- RANK：`owner=4, editor=3, commenter=2, viewer=1`（`routes/kb/shared.ts:15`）。
- 语义 = **取最大值**：单文档 ACL 只能向上提权，不能把库成员压低；反之亦然。
- **没有显式 deny**：`RANK` 仅用于比较，无负值 / 禁止位。
- 授予口（who can grant）：`PUT /api/kb/docs/:docId/acl` 要求库角色 `>= editor`（`routes/kb/acl.ts:41-42`）。

### 3.3 组织面（生效中）：直接授予 ∪ 部门祖先闭包，**任一角色持有动作即放行**

证据 `domain/org/authorization.ts:40-110`（`effectiveRoleRows`）+ `:113-120`（`hasOrgAction`）。

- 来源合并：一条 `OR` 查询同时取 `subjectType=user` 直授与祖先闭包内的 `subjectType=dept` 授予（`:74-83`）。
- 部门继承方向：由用户所在**活部门**的 `path` 切段求祖先闭包（`:21-23`、`:53-57`）；软删部门不展开（`:51`）。
- 同一角色多来源只做**来源去重**（`:94-97`），不影响是否放行。
- 冲突 / 优先级：**不存在谁压谁**——任一有效角色的 `actions` 含该动作即通过（`:118-119`），等价于 **OR 且不可撤销**。
- **没有显式 deny**：`parseActions` 只做白名单过滤，非白名单值丢弃（`:26-34`）；全文件无 negative grant 字段。

### 3.4 新引擎（M4，**未生效**）：creator/owner 兜底短路 → cutoff 内 allow 并集，**无 deny**

证据 `domain/authz/evaluate.ts:96-108`（`evaluateChainDecision`，`decide` 与 `scope` 共用同一份，避免语义分叉）：

1. `isCreator` → 直接 `fallbackDecision`（`evaluate.ts:98`）；
2. `subject.isWorkspaceOwner` → 直接 `fallbackDecision`（`evaluate.ts:99`）；
3. 否则取 cutoff 内策略中 `actions` 含该动作的**全部来源并列**（非取最高）（`evaluate.ts:101-104`）；
4. 任一命中 → `allowed: true` 且 `sources` 全列（`evaluate.ts:106-107`）；一条没有 → `allowed: false, reason: "no_matching_allow"`（`evaluate.ts:108`）。

配套规则：

- **祖先继承与 cutoff**：`domain/authz/nodes.ts:35-43`（`collectibleChainIndexes`）—— 节点自身 `inheritAncestors=0` 时不收任何祖先；否则向上直到遇到第一个 `inheritAncestors=0` 的祖先 K（**含 K**）后停止。
- **字段掩码多源并集取最宽**：实现见 `domain/authz/fieldMask.ts:46-54`（任一来源可见即可见；可写需在该来源可见且非其只读）。**只增不减**——宽来源存在时无法用窄来源收窄，要收窄必须改宽来源本身（该语义在 `fieldMask.ts:3-8` 与 `authz.ts:7` 有注释说明，属注释，非代码证据）。
- **显式 deny：代码中未见**。`Decision.reason` 只有一个取值 `"no_matching_allow"`（`domain/authz/types.ts:69`）；`ScopedPolicy` 无 effect / deny 字段（`types.ts:24-34`）；`packages/shared-types/src` 全目录检索 `deny|Deny|DENY`，仅命中注释（如 `authz.ts:7`、`policy.ts:46`）。

### 3.5 分享链接 / 匿名访问：独立于上述所有模型

- 匿名持令牌：`routes/public.ts:184-289`；可编辑性由 `root.shareRole === "editor"` 决定（`public.ts:238`）；子树外引用**恒只读**（`public.ts:240-245`）。
- 持票加入：`POST /api/bases/join/:token`（`bases.ts:517-539`），角色取 `link.role`（`bases.ts:532`），不受邀请者身份约束。
- 该链路不进授权引擎（`docs/decisions/AUTHZ-LEGACY-GUARD-CLEANUP.md` 明确「匿名分享链路不在授权引擎域」）。

### 3.6 唯一一处跨模型取或

`domain/authz/policyAccess.ts:45-55`：**写策略权限 = `hasOrgAction(manage_share)`（组织空间）`||` `decide(node, manage_share)`（资源空间）**。两枚同名 `manage_share` 分属不同命名空间，任一成立即放行（OR 逻辑在 `:50-54`，是代码证据；命名空间的说明在 `:41-44`，属注释）。

### 3.7 现状小结

| 问题 | 现状答案 | 证据 |
|---|---|---|
| 多来源谁优先？ | Base：单来源，无所谓；KB/文档：**取较高**；组织面：**OR（任一来源）**；引擎（未生效）：**allow 并集 + creator/owner 兜底短路** | `shared.ts:79-80`；`authorization.ts:118-119`；`evaluate.ts:96-108` |
| 既授又禁怎么办？ | **无法表达「禁」** —— 全栈无 deny 位，冲突不可能发生 | §3.4 末段、`types.ts:62-70` |
| 有没有显式 deny？ | **代码中未见** | 同上；`shared-types` 内 `deny` 仅出现在注释 |
| 能否「先授后压」？ | KB/文档不能（取较高）；组织面不能（OR）；仅 Base 可以（改成员角色即换一行，`bases.ts:432-442`） | `shared.ts:79-80`；`bases.ts:432-442` |

---

## 4. 「收缩权限」改造方案选项（**本章全部为待裁决，不替主理人拍板**）

> 前置提醒：无论选哪个选项，在 §0.1 的闸门未翻之前，**改 `Role → PermissionSet` 矩阵对已经落库的 `auth_policies` 完全不起作用**；翻了闸门之后，同一份改动的语义会同时波及新表侧（映射源 `resourceActionsForLegacyRole`，`authz.ts:42-74`）。

### 选项 A：只把新引擎翻 on，不动粒度

- **改什么**：`configAuthz.ts:17` 的 `AUTHZ_ENFORCE_READY` 翻 `true`，部署侧设 `GX_AUTHZ_ENGINE=on`，按既有 runbook 走 shadow → on 两阶段。
- **影响面**：七守卫 + kb 两守卫的决策权从旧三表切到 `auth_policies`；同时激活字段掩码五出口（`configAuthz.ts:66-69`）与导航剪枝（`configAuthz.ts:85-87`）。语义等价时**页面表现大概率不变**（有 `decision-matrix` / `scope-parity` 系列测试背书），但请求成本与延迟会变。
- **风险与回滚**：`GX_AUTHZ_ENGINE` 回 `off` 即完全回到旧路径，**回滚成本接近零**（三态门设计 + shadow 对拍）。主要风险是 `auth_policies` 与旧三表存在**漂移**（见 §5 存疑 1）。
- **与诉求的关系**：**它本身不收缩任何权限**，只是让「收缩」这件事成为可能。
- **需裁决**：是否接受先翻闸门再谈粒度？谁来验证漂移双零（DRIFT_OVERALLOW / DRIFT_OVERDENY = 0）？

### 选项 B：翻 on + 普通用户默认不给「建库 / 建知识库」，由管理员按部门或角色下发

- **改什么**（均为代码证据指向的位置）：
  1. `POST /api/bases` 目前**只有 `requireUserId`**（`bases.ts:158-159`）；`POST /api/kb` 同样（`routes/kb/index.ts:75-77`）→ 加一枚 org 动作门（现成件 `requireOrgAction`，`middleware/authActive.ts:31-42`；但**现有五枚 OrgAction 里没有 create_base / create_kb**，`org.ts:19-25`，需新增动作位）。
  2. 前端「新建库」入口目前**无条件渲染**（`features/workspace/NavLibraryBlock.tsx:40-50`）；知识库首页「新建知识库」按钮同理（`features/kb/KbListPage.tsx:52,93`）→ 按规则 P1 改为不渲染。
  3. 不需要给普通角色「灌空权限」：`role_creator/editor/commenter/viewer` 的 org actions 已是空数组（`roles.ts:47-50`）。
- **影响面**：一级导航「新建库」按钮（`NavLibraryBlock.tsx`）、知识库首页新建按钮（`KbListPage.tsx`）、`POST /api/bases`、`POST /api/kb`；以及连带的 starter 表与 nav 节点回填（`bases.ts:63-122,165-182`）。
- **风险与回滚**：新增动作位是 additive（`org.ts` 标注只增纪律），可配合 env / v1 挂载条件灰度。风险是**打断现有用户的建库习惯**（老用户「点了没反应」与「按钮消失」按 §2.1 必须二选一，不能出现第三种）。
- **需裁决**：
  1. 建库是「默认允许、显式禁止」还是「默认禁止、显式授予」？后者需新增动作位 + 存量用户补授权。
  2. 粒度落在**个人**还是**部门角色**？（`hasOrgAction` 已支持部门祖先继承，选后者开发量显著更小。）
  3. 存量库的 owner 是否自动获得等价授权（需要幂等回填脚本）？
  4. 入口消失还是置灰 —— 按 §2.1 的哪一条？

### 选项 C：引入显式 deny 位

- **改什么**：这是**架构变更，不是开关**。当前全栈无 deny 概念（§3.4 / §3.7 已证），需要：扩 `Decision.reason`（`types.ts:69` 现仅一个值）、给 `ScopedPolicy` 加 effect/deny 字段（`types.ts:24-34`）、改判定内核 `evaluateChainDecision`（`evaluate.ts:96-108`）加「deny 覆盖 allow」层、改来源链结构 `AllowSource`（`types.ts:51-60`）、补 decide↔scope 零分叉对拍、改 openapi 契约（`docs/api/openapi.yaml`）与前端 PermPanel / 来源抽屉（`apps/web/src/features/authz/`）。
- **影响面**：**最大**。触碰 M4 全部已收敛资产——`s10-ac-*`、`decision-matrix`、`scope-parity`、翻转演练均以「纯 allow」为前提，`docs/decisions/` 与对应 ADR 把「总监裁决纯 allow」写成前置假设。
- **风险与回滚**：deny 一旦上线并回填，回滚到纯 allow 会**放开权限**（比现状更宽），是朝不可逆方向犯错；回滚方案必须包含「数据层 deny 行清理」，不是简单切 flag 能了事。
- **需裁决**：
  1. 收缩到底要不要 deny？「默认不给 + 按需授予」（选项 B）通常能达到同等效果，成本低一个数量级，是否够用？
  2. 若确需 deny，是否接受与现行 ADR「纯 allow」裁决冲突（需新 ADR 推翻或修订前置裁决）？

### 选项 D（可与 B 组合）：收紧信息可见面

针对两个已核实的「可读他人邮箱」事实：

1. **库级（PERM-A3）**：`GET /api/bases/:baseId/members` 只要 `requireCanView`（`bases.ts:368`）即返回全员邮箱（`bases.ts:371-383`），前端无条件渲染（`MembersPanel.tsx:119`）。
2. **工作区级**：`GET /api/v1/org/members` 无任何动作门（`members.ts:22-26`），返回全员 email（`memberDirectory.ts:58-77,119`）。

- **影响面**：通讯录三栏（`apps/web/src/features/contacts/`）、MembersPanel、以及**所有按邮箱 invite 的流程**（收紧后邀请需改为成员选择器）。
- **需裁决**：邮箱是否属敏感字段？收紧到哪一层（仅管理者可看 / 按部门裁剪 / 一律只显示名）？invite 流程如何配合？

### 跨选项共同决策点

1. **要不要先翻 §0.1 的闸门** —— 这是所有后续改动能否生效的唯一前提。
2. **B 与 C 是否互斥** —— 建议先做 B；仅当出现「必须先授所有人、再排除个别人」的真实场景时才上 C。
3. **D 是否与 B 打包** —— 两者都改默认可见性，测试与时间窗可合并。
4. **§2.3 的四个 TopBar 例外**是否顺带统一（低成本，不动后端）。
5. **§5 存疑 1（双写漂移）**必须先行给结论，否则选项 A/B 的验收无法判绿。

---

## 5. 存疑 / 未核实清单（本文不敢下的结论）

1. **`auth_policies` 与旧三表是否存在历史漂移**：本文只读了双写调用点（`projection.ts` 的 `syncBaseMemberTx` / `syncKbMemberTx` / `syncDocAclTx` 及各写点），**未执行**任何对账脚本，也未验证存量库回填完整性。翻闸门（选项 A）前必须实测。
2. **部门读端点同样是「登录即全员可读」**：`GET` 分支在 `routes/v1/org/departments.ts` 未见 `requireOrgAction`（写端点三个均挂门：`departments.ts:22/38/58`），与 §1.6 的成员目录同口径。本文未逐个列出其 GET 路由行号，属未细化项。
3. **TopBar 四个 disabled 例外（§2.3）**：是否有意为之、或存在本文未检索到的书面/口头约定，未核实。
4. **PERM-A3 是否已有裁决**：仓库内只检索到「维持上一轮登记，等产品裁决」（`docs/help-center/assets/walk/perm3-final-recheck-report.md:81`），**未见已拍板结论**。
5. **`canComment` 无权限表现是否被测试覆盖**：检索 `apps/web/src` 下全部测试文件，**未发现**针对 `RecordDrawer.tsx:351` 的断言，当前无测试锁定。
6. **MCP（`/mcp`）与 PAT 的权限面**：本文未展开。PAT scope 收窄、`record.search` 跨族越权修复（P0-A）等属 M6/M7 范畴，若有收缩诉求需另开一篇盘点。
7. **搜索引擎的可见性过滤是否严格等价于成员关系**：本文只看到 `routes/search.ts:3` 的注释（注释，非代码证据），**未读 `domain/search/legacySearch.ts` 与 M5 新链路实现**。

---

## 附录：复核命令

```bash
# ① 新引擎三处就绪门 + 默认 off
sed -n '17p;64p;82p' apps/api/src/configAuthz.ts
sed -n '22,26p' apps/api/src/configAuthz.ts

# ② 五枚权限位定义与角色矩阵
sed -n '24,74p' packages/shared-types/src/permissions.ts

# ③ 旧守卫五个判定入口
grep -n "export async function requireCan\|export async function permissionsOf" apps/api/src/guards.ts

# ④ 建库入口是否无门控（收缩权限靶点）
sed -n '158,159p' apps/api/src/routes/bases.ts
sed -n '75,77p' apps/api/src/routes/kb/index.ts

# ⑤ 组织通讯录读端点有无动作门
grep -n "requireOrgAction\|^memberRoutes.get" apps/api/src/routes/v1/org/members.ts

# ⑥ 前端口径两套规则被哪些测试锁住
grep -n "  it(" apps/web/src/features/settings/perm-hide-gating.test.ts
grep -n "  it(" apps/web/src/features/grid/grid-toolbar-permission.test.tsx

# ⑦ TopBar 例外（管理类却置灰）
grep -n "disabled={!canManage" apps/web/src/features/shell/TopBar.tsx

# ⑧ 有无显式 deny（预期只命中注释）
grep -rn "deny\|Deny\|DENY" packages/shared-types/src apps/api/src/domain/authz | head -20
```
