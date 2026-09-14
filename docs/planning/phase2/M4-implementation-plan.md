# M4 统一权限引擎 — 可执行实施切片（设计与现状核对，不改业务码）

- 日期：2026-09-17
- 作者：架构师 高见远
- 状态：**待项目总监终审**（§10 待裁决清单未关闭前不得派工实施）
- 上游依据：SPEC-enterprise-v1.0 §5（:71-73 policies/inheritance/effective 端点）/§6（:86 auth_policies 启用写入与旧三表回填、:89 分组条件策略）/§9（AC-M4-1 :120、AC-M4-2 :121、AC-M4-3 :122；AC-M5-2 :124 为 M4 可见集接口的验收下游）；PRD-enterprise O4（:146）/O5（:147、:163 字段数据双语义）/O6（:148 中断继承）/O7（:149）/O8（:150 来源链/预览）/O9（:151 服务端收口）/O10（:152 审计）/§六 M4（:260-266，含中断继承 EARS 原文）/升级等价（:383）；ARCH-enterprise §5.1-5.8（:435-581，纯 allow 伪代码/缓存/越权矩阵 18 条）/§6.1-6.3（:587-609 回填映射与双跑）；M2 实施计划 §5-C（effectiveOrgRoles :209-223）、§5-A（:195-196 M4 衔接点）、S5（:438-447 hasOrgAction/usersWithRole）、S6（:460 lifecycle）；M3 实施计划 §0-1（零剪枝 :17）、§4.1（auth_policies 冻结结构 :216-233、inheritAncestors 恒 1 :243）、§10 移交 M4 输入（:658-661）
- 适用代码基线：`main` @ `a65073d`（M2-S0/S1/S2 已落地：组织五表、users 六列、resolveActiveAuth/issueToken/USER_STATUS、middleware/authActive.ts、routes/v1 骨架、GX_ENTERPRISE_ORG）；根 package.json v0.1.0
- 测试基线（项目总监给定，本文不重跑）：api 54 文件 **657 passed / 3 skipped**、迁移目录 **14 个**；M3 实施后预期 16 个迁移（nav 三表 DDL + 回填）。**M4 第一个数据迁移编号排在 M3 两迁移之后**
- 本机核对环境：Node v22.22.2、pnpm 9、Prisma 5.22、better-sqlite3 13.0.3、Hono 4.13.5、React 18 / TanStack Query 5.62

> **硬依赖声明**：M4 实施依赖 **M3-S1（auth_policies/nav_nodes/menu_items 建表迁移）已合入主干**，且 S5/S6 切片依赖 **M3-S5/S6（tree/menu/node v1 端点）** 与 **M2-S5（effectiveOrgRoles/hasOrgRoles/usersWithRole）、M2-S6（lifecycle）** 落地。当前 M2 S3-S6 正在另一条线实施（`domain/org/roles.ts`、`lifecycle.ts` 此刻尚不存在，2026-09-17 实查 `apps/api/src/domain/org/` 仅有 authState.ts/authStateCache.ts），M3 尚未开工。本计划引用这些**将落地**接口的签名以 M2/M3 终审文档为准，实施开工时逐点复核，**M4 不得改它们的文件、不得替它们实现**。本文所有"现状证据"行号均在本机 a65073d 实读；与旧 ARCH 草案不符之处集中列在 §12。本阶段只产出规划文档，不改任何 .ts 源码。

---

## 0. 结论先行

1. **引擎形态：一次授权判定 = 主体三源展开 × 客体祖先链收集，纯 allow 并集，无 deny 分支**。主体侧：role 源（M2 `effectiveOrgRoles`：role_assignments 的 user 直授 + 用户部门经 dept path 祖先展开的 dept 授角色）命中 `auth_policies(subjectType='role')`；dept 源（`auth_policies(subjectType='dept')`，按用户各部门 path 前缀匹配）；direct 源（`subjectType='user'`）。客体侧：nav_nodes 祖先链（M3 物化 path，一次查询），内容叶子 `inheritAncestors=0` 时不收集祖先。任一策略行动作命中即 allow；无 allow 即拒。确定性优先级：**role_owner/资源 createdBy 兜底 → 节点直接 allow →（开关开时）祖先 allow 并集 → 拒绝**（ARCH :460-502 定稿口径，本计划照实现，不重新发明）。
2. **旧三表（members/kb_members/kb_doc_acls）关系选型——选定"回填为 auth_policies allow 行 + shadow 零漂移对拍 + enforce 后旧表降级为投影（同事务双写）"，否决"运行时双读合并"**（§4.6 给两方案风险对比）。理由：运行时双读合并意味着判定逻辑永久两套，而 fieldMask、中断继承、角色/部门授予三个新能力在旧表无承载，合并语义必然产生永久漂移面，且无法回滚到单一心智；回填+投影方案下旧表是 auth_policies 的一份物化缓存，**权威只有一个**，双写在同一 `withWriteTx` 内共生死（M3 裁决 9 同纪律），flag off 时旧守卫读旧表工作照旧，回滚路径物理存在。
3. **回填映射对 ARCH §6.2 做一处防膨胀裁剪（待裁决 A-1）**：ARCH 草案要求每个 kb_members 行"对该库下每个 doc/canvas 节点写一行"（:600），1000 成员 × 1000 文档 = 100 万行且与 nav 继承重复。本计划改为 **kb_members → kb 节点上一行 user allow，文档/canvas 经 nav 祖先链继承覆盖**（引擎本来就爬祖树，逐 doc 物化是冗余拷贝，违反单一事实源）；kb_doc_acls 仍逐行映射到具体 doc 节点 direct 行（这是真正的单内容例外）。members 同理 → base 节点一行，table/view 经继承覆盖。
4. **fieldMask 挂在 table 节点的策略行上，不建 field 导航节点**（M3 裁决 3 已定 field 不建节点，ADR-0030）。`fieldMask` JSON 形状 `{allowFields?: string[], readOnlyFields?: string[]}`，缺省=全量；多来源并集取**最宽**：可见=任一来源可见之并，可写=任一来源可写（且该字段非各来源只读——纯 allow 下"只读"是该来源的能力裁剪不是 deny，故另一来源给可写则可写）。下推点逐个实查锁定为 5 个出口：records 列表（`records.ts:359-373` 响应体）、records 详情（`:610`）、记录写 payload 键白名单（`:632-636` applyFieldWrites 之前，越权字段键整条 403 不静默丢弃）、CSV 导出（`csvExport.ts:85-103`）、hydrate 内关联标题/公式依赖（`hydrate.ts:499-524` primaryTitle：依赖列照常参与服务端计算但**不下发原值**）。search 旧预览路由（`search.ts:84-115`）M4 不动（M5 统一检索替换，AC-M4-3 的"检索"口径在 M4 只覆盖 records 列表搜索框同链路；M5 凭 §4.7 可见集接口交付零泄漏，AC-M5-2）。
5. **inheritAncestors EARS（AC-M4-2）**：M3 恒 1 的列在 M4 开放 `PATCH /api/v1/nodes/:id/inheritance`，**仅 doc/canvas 内容叶子可关**（table/view/group 不可，400）。关闭前必须经 `GET .../inheritance/impact`（或 PATCH 未带 confirmed 返回 409 + 载荷，M3 move 同款）：后端展开"当前经继承可见、关闭后将失访"的去重用户集（多部门只计 1，去重到 userId；排除 createdBy、节点直接 allow 主体、role_owner），返回人数与按角色/部门聚合的清单；确认后写 nav_nodes.inheritAncestors=0 + bump navVersion 与 policyVersion + 审计前后 diff。重开对称（恢复访问人数预览）。
6. **shadow → enforce 翻转仿 M1 三态 flag 先例**（`GX_M1_SIDECAR_READ=off|shadow|on`，`flags.ts:14-20` 是仓内既有成熟形态）：新增 `GX_AUTHZ_ENGINE=off|shadow|on`（默认 off）。shadow 期旧 guards.ts/kb.ts 决策照跑、响应照返回，引擎在**同一请求内**并行判定并对拍，差异写结构化日志 + 内存计数（`/readyz` 可选带 drift 摘要，不入响应）。drift 分两类：**E-DENY-UNSAFE（旧 allow / 引擎 deny，误拦类）** 与 **E-ALLOW-UNSAFE（旧 deny / 引擎 allow，越权类，安全严重级）**；翻转门：shadow 连续一个迭代、E-ALLOW-UNSAFE=0、总 drift 率=0（以全量 characterization 夹具 + 生产影子流量双重证据，阈值 §4.8）。on 期适配层以引擎为准、旧结果仅记日志；再经一个迭代删旧决策分支（函数签名壳保留，M5/M6 只认引擎）。回滚 = flag 回 off，旧守卫与旧表投影数据完好。
7. **给 M5 的权限查询接口（先收敛后召回）定稿两形态**（§4.7）：`resolveVisibleNodeIds(userId, action, kinds, opts)` 返回节点/资源 id 集合（带 budget，默认 5000，超限拒绝全量模式）与 `buildVisibleScopeSql(userId, action, resourceType)` 返回**参数化 SQL 片段 + 参数数组**（可下推：JOIN auth_policies/nav_nodes/departments/dept_members/role_assignments，全部走 path 前缀索引，无 CTE、无全表 SCAN），M5 在 search.db 召回时以临时表或分批 IN（≤ 参数上限）收敛候选，**无权 id 不进入向量/FTS 召回**。M4 只交付接口、契约、规模测试（500 用户/1 万节点：单用户 scope 定数查询、P95 留证），不接任何检索路由。
8. **切片 S0-S11 共 12 片**：S0 旧三表决策 characterization（golden 矩阵）→ S1 引擎纯函数与定数 SQL（不接线）→ S2 旧三表回填迁移 + 对账脚本（只读）→ S3 shadow 适配层接线（guards.ts/kb.ts 包壳，不改决策）→ S4 可见集接口（M5 契约冻结）→ S5 策略管理 v1 API（policies/inheritance/effective + manage_share 第五动作位 + 写路径投影双写）→ S6 fieldMask 五出口下推 → S7 tree/menu 服务端剪枝 + move-impact 升级并集口径 → S8 openapi 增补冻结 → S9 后端契约片（前端面板另立 M4 前端片，纪律照 M2 S7：无新依赖、只走 api/client、icons.tsx 追加、gx token）→ S10 AC-M4-1/2/3 自动化对抗 + 500 人/万节点规模门 + enforce 翻转演练 → S11 出口收口（ADR/RC/baseline/runbook/旧守卫分支清理裁决）。**enforce 翻转（GX_AUTHZ_ENGINE=on）是 S10 内的独立门，不是默认值**：M4 出口交付物在 shadow=on、enforce 默认 off 的可发布状态，切 on 由项目总监按影子证据下令（与 M1 keyset 同纪律）。
9. **动作词汇表全项目单一真源**：资源行动作串 `r,c,u,d,comment` + 管理位 `manage_share,manage_schema`，存 auth_policies.actions（逗号分隔小写串，与 M3 冻结列一致，不加列）；组织管理动作 `manage_departments/manage_members/manage_roles/manage_menu`（M2/M3 已建）**不进 auth_policies**，M4 新增第五枚组织动作 `manage_share`（策略写权限）走 M2 同款 `requireOrgAction` + owner 幂等补位迁移（照 M3 S6  manage_menu 的迁移模式）。资源角色映射沿用 ARCH §6.1（:589-595）：owner=`crud,manage_share`、creator=`crud,manage_schema`、editor=`crud`、commenter=`r,comment`、viewer=`r`。
10. **即时性与 M2 一致**：引擎判定**不做跨请求正缓存**（与 M2 effectiveOrgRoles :223 同纪律），只缓存可重算的结构数据：nav 祖先链按 navVersion、部门展开可复用 M2 的定数查询；auth_policies/role_assignments/dept_members 任一写事务 bump `workspaces.policyVersion`（M2 已建列，schema.prisma:379）。调岗/收权/删策略后**下一次请求**即新结果（AC-M4-1 硬要求），无 TTL 延迟窗口。停用账号由 M2 resolveActiveAuth 在下一层直接 401，不进引擎。

---

## 1. 现状证据（行号已核对，2026-09-17 于 a65073d 实读）

### 1.1 旧三套守卫的全部决策点（M4 适配层要包壳的位置）

| 事实 | 证据（已核对） |
|---|---|
| base/table 侧 RBAC：members 单行定角色，五角色 → PermissionSet 矩阵 | `guards.ts:43-49` roleOf（member 唯一键 baseId_userId）；`:51-57` permissionsOf（无成员=全 false）；矩阵真源 `packages/shared-types/src/permissions.ts:33-69`（owner/creator/editor/commenter/viewer） |
| 五个 requireCan* 守卫 | `guards.ts:66-71` requireCanView（无成员 403）；`:73-77` requireCanEditData；`:79-83` requireCanManageSchema；`:85-89` requireCanManageBase（文案"只有所有者"）；`:91-95` requireCanComment |
| 资源 id → baseId 三个解析器 | `guards.ts:22-25`（table）、`:27-33`（view 经 table）、`:35-41`（record 经 table） |
| kb 侧两套角色源 + 取较高 | `routes/kb.ts:22-28` kbRoleOf（kb_members 四角色 owner/editor/commenter/viewer，:17-18）；`:30-36` docAclRoleOf（kb_doc_acls 三角色 editor/commenter/viewer）；`:38` RANK owner4/editor3/commenter2/viewer1；`:40-46` requireKb（kb 存在且未删 + 成员，否则 404/403）；`:49-60` requireDocAccess（**kbRole 与 aclRole 取较高 :54-55**，needEdit 判 editor 档 :57-58） |
| 错误信封现网形态 | `guards.ts:97-127`：`{error: 中文文案, code: BAD_REQUEST/UNAUTHORIZED/FORBIDDEN/NOT_FOUND/CONFLICT/PAYLOAD_TOO_LARGE/TOO_MANY_REQUESTS}`，500 为 `{error:"服务器内部错误",code:"INTERNAL"}`（dev 才带 message）。M4 新增 code：`FORBIDDEN_FIELD`/`FORBIDDEN_RESOURCE`/`POLICY_CONFLICT`/`INHERITANCE_CONFIRM_REQUIRED`/`NODE_NOT_INHERITABLE`，**信封不切**（M3 裁决 5） |
| 守卫调用面（回归面量化） | grep 计数：records.ts 24 处、kb.ts 35 处、bases.ts 14 处、tables.ts 11 处、fields.ts 7 处、views.ts 7 处、search.ts 2 处（requireUserId 为主）。**适配层策略成立：路由文件零改动，只换 guards.ts/kb.ts 两文件内函数体**（ARCH :535 同口径） |

### 1.2 旧三表 schema 与写点（回填来源 + 投影双写接线点）

| 表 | schema | 写点（必须双写 auth_policies 的位置） |
|---|---|---|
| members（base 五角色） | `schema.prisma:220-233`，@@unique([baseId,userId])，FK cascade | 建库自动建 owner 行 `bases.ts:153`；加成员 `:333-345`（create）；改角色 `:361-371`（update）；移除 `:378-384`（delete）；持票加入 `:445-459`（create，role 取自 share link） |
| kb_members（四角色） | `:282-295`，@@unique([kbId,userId]) | upsert `kb.ts:254`（单成员加/改）；deleteMany `:281`（移除）；全库成员批量升降级 `:575-592`（循环 update :586）；成员列表 `:221`、:115/:497 为读点 |
| kb_doc_acls（三角色） | `:352-364`，@@unique([docId,userId]) | 清空文档 ACL `kb.ts:634`（deleteMany，物理删文档分支）；列表 `:737`；删单人 `:766`；upsert `:769` |
| createdBy 兜底列 | bases `schema.prisma:24`、tables :40、fields :128、knowledge_bases :271、kb_docs :306、records :341 均有 createdBy（非空串） | 引擎 owner/creator 兜底判定直接读 nav node 解析回实体的 createdBy（经 M3 node 的 resourceType/resourceId 一次解析），不新增列 |

- 三张旧表均无软删（成员关系物理行，FK ON DELETE CASCADE）；回填按活资源（实体 deletedAt IS NULL）+ 活用户（M2 status=ACTIVE/INVITED 均映射，DISABLED 不剔除行——停用在登录层拦，策略保留，M2 计划 :420 同口径）。
- 表删除语义（M3 已核对）：member 行随 base 删而 cascade；M4 投影双写时对应 auth_policies 行的清理挂在 M3 nav sync 软删/purge 语义上——**软删资源不删策略行**（恢复后授权自动还在），物理 purge 才删策略（在 M3 purgeResourceNodeTx 同事务内追加，§7-S5）。

### 1.3 fieldMask 五个响应/写入出口（AC-M4-3 的"一致不出现"覆盖面）

| # | 出口 | 证据 | 掩码方式 |
|---|---|---|---|
| 1 | 记录列表响应体 | `records.ts:327-374`：`:339` loadTableFields → `:349` queryRecords → 响应 `:359-367` 含 `records / fields=visibleFields(fields,config) :363 / allFields :364 / groups / aggregations` | records 逐行删键 + fields/allFields 双重过滤 + groups/aggregations 涉及隐藏字段的桶/聚合列剔除（aggregation 列由 fieldId 标识） |
| 2 | 记录详情响应 | `records.ts:597-611`：`:610` `{record: found, fields}`，found 来自 hydrateRecordById | 同口径过滤 fields 与 found.fields 键 |
| 3 | 记录写 payload | create `records.ts:386-456`（:400 payloadFields，落库走 applyFieldWrites）；patch `:617-636`（:633-634 assertUnique/applyFieldWrites 在 withWriteTx 内） | 事务前键白名单校验：**出现不可见字段键 → 403 FORBIDDEN_FIELD 整单拒绝**（ARCH :504：不静默丢弃）；readOnly 字段出现在 patch payload 同样 403；create 对只读键拒绝、对不可见键拒绝（草稿 draft 同口径） |
| 4 | CSV 导出 | `domain/csvExport.ts:85`（hydrate）、`:96`、`:103`（分批累积），入口 tables.ts:17 exportTableCsv | 导出列集 = 可见字段交集（导出沿用视图 config 的 hiddenFieldIds 后再叠加掩码） |
| 5 | hydrate 内计算依赖 | `domain/hydrate.ts:94` hydrateRecords、`:499-524` primaryTitle（关联显示名优先 linkDisplayFieldId 否则 primaryFieldId :505-524，link title 拼接 :390-392）；lookup/rollup/formula 计算读依赖列 | 依赖列**照常取数参与服务端计算**，但计算结果字段本身若不可见则不下发；隐藏列的标题拼接用于 LinkRef.title 时按"目标表掩码对本表用户不可见"处理：title 回退主键 id 或空串（**待裁决 A-4**，见 §10） |
| — | 列表内搜索/排序/过滤 | `recordService.ts:68-101` applyViewQuery：搜索可见字段 :84-87、filters :77-78、sorts :93-98 | 隐藏字段不参与内存搜索匹配（M1 物理下推路径另需在 compile 阶段禁止以隐藏字段做物理 filter/sort，S6 验收含此断言）；这是 AC-M4-3"检索不出现"在 records 域的边界 |

- M3 不建 field 节点（M3 计划 §0-2/ADR-0030），故字段掩码**没有 field 级 nav 客体可挂**；本计划定稿挂在 table 节点策略行的 fieldMask（§4.4），view 节点不挂掩码（视图 hiddenFieldIds 是个人/视图配置，与权限掩码正交且已在 visibleFields :54-57 生效）。

### 1.4 M2 将落地接口（M4 消费方，签名以 M2 计划为准，开工复核）

- `effectiveOrgRoles(userId, workspaceId)`：返回 `{roleId, sourceType:'user'|'dept', sourceId}[]`（M2 计划 :212-217），定数 2-3 条 SQL，部门祖先闭包走 path 前缀（:220）；**M4 role 源展开直接复用，不重写**。
- `usersWithRole(roleId)`（:446，最后 owner 保护同款反向展开：user 直授 + dept 授角色的子部门全体成员）；M4 的失访人数预览、策略 subject 解析复用。
- `hasOrgAction(userId, action)`（:447）：M4 manage_share 守卫调它。
- `lifecycle.ts` disableUserTx/reactivateUserTx（:460）：M4 不接停用逻辑，但 shadow/enforce 必须有"DISABLED 用户进不了任何守卫"的对拍断言（resolveActiveAuth 已在 v1 层保证，旧 /api 经 getUserId 共享核心，authState.ts 头部注释 :4-5 已声明）。
- 已落地可直接用：`resolveActiveAuth/ResolvedAuth`（authState.ts:23-28/:55-96）、`requireActiveUser/requireOrgAction`（authActive.ts:20-46，**当前 OrgAction 联合仅三枚 :11、allowed 数组 :34；M3 已规划加 manage_menu 第四枚，M4 再加 manage_share 第五枚，两处同改**）、v1 挂载（routes/v1/index.ts:13-30，requireActiveUser 全链 :16）、config.enterpriseOrg（config.ts:229）。

### 1.5 M3 将落地接口（M4 消费方）

- nav_nodes：M3 计划 §4.1（:162-189），`path/depth/parentId/kind/resourceType/resourceId/inheritAncestors`，索引含 `[workspaceId,parentId]`、`[path]`、`[resourceType,resourceId]`。
- auth_policies 冻结结构（M3 计划 :216-233）：列 id/workspaceId/nodeId/subjectType/subjectId/actions/fieldMask/conditions/reason/createdAt/createdBy；`@@unique([nodeId,subjectType,subjectId])`（**同节点同主体唯一行，调权限=upsert 改 actions，天然无 allow/deny 两行**）；索引 `[workspaceId,subjectType,subjectId]`、`[nodeId]`。M4 如需新索引只能加（见 S1）。
- tree/menu 读端点（M3 S5）当前零剪枝（M3 §2.1-12）；M4 S7 翻转剪枝（M3 §10 移交项，M3 计划 :659）。
- move-impact（M3 S6）当前按旧 members/kb_members 口径（M3 计划 :518-520），M4 S7 自动升级为三源并集口径并启用 willBreakInheritanceHint 真值（M3 :660 移交项）。

### 1.6 flag / 审计 / 性能设施（M4 直接复用，不新造轮子）

- 三态 env flag 解析先例：`domain/queryPlan/flags.ts:14-20`（off/shadow/on，未知值保守回 off）、灰度纪律注释 :10（shadow 连续一迭代差异 0 才切 on）。
- 审计 JSONL：`audit/audit.ts:9-15` 当前 6 事件联合；M4 只增事件名（policy_changed/inheritance_changed/fieldmask_changed/authz_engine_mode），detail 带前后 diff，敏感脱敏设施 :39-41 已存在。
- Prisma 调用计数/bench proxy：M2 计划 :513 提到 `db.ts:38` instrumentPrisma；M4 规模门用同款计数断言定数上界。
- 写串行门面：withWriteTx/runWrite/withWriteBatch（M1 设施，M3 18 写点已复用）；投影双写只允许在这些回调内用传入 tx。
- workspaces.policyVersion 已建（schema.prisma:379，M2 只建此列；navVersion/menuVersion 待 M3-S1 补）。

---

## 2. M4 范围边界

### 2.1 必做（SPEC M4 + O4-O10 + AC-M4-1/2/3）

1. **纯函数权限引擎**（domain/authz/）：三源主体展开、nav 祖先链收集、inheritAncestors 裁剪、动作命中、fieldMask 合并、conditions 求值钩子（本期只实现 M3 config 之外的策略 conditions= null/{}；**行级分组条件（group bucket）列为 P1 切片，不进 M4 P0**——PRD :167 明确"记录（行）级权限本期不做"，ARCH §5.3 的 group 条件下推随之顺延，auth_policies.conditions 列保留但 M4 只接受 null，非 null 返回 400 留口）。
2. **旧三表回填为 auth_policies allow 行**（只增迁移 + 幂等 + 对账脚本，§5）：members → base 节点、kb_members → kb 节点、kb_doc_acls → doc 节点；角色→动作按 §6.1 映射表；回填后 0 漂移对账（旧守卫决策 vs 引擎决策全量对拍）。
3. **shadow 对拍适配层**：guards.ts 五函数 + kb.ts 两函数体内并行调引擎，差异分类记日志/计数，响应与现状字节一致。
4. **策略管理 v1 API**（SPEC :71-73）：GET/PUT `/api/v1/nodes/:id/policies`（批量 upsert-delete，纯 allow）、PATCH `/api/v1/nodes/:id/inheritance`（二次确认门）、GET `/api/v1/nodes/:id/effective`（来源链：role/dept/direct/owner_fallback，O8）；manage_share 第五组织动作位 + owner 幂等补位迁移。
5. **写路径投影双写**：§1.2 表中 10 个旧表写点在同一 withWriteTx 内维护 auth_policies（及反向：v1 策略写在 M4 on 期同步旧表，保证 flag off 回退正确；§4.6 切换点表）。
6. **fieldMask 五出口下推**（§1.3）+ AC-M4-3 六通道对抗（列表/详情/导出/API/关联展开/公式引用；"检索"通道在 records 域为列表搜索，向量/FTS 留 M5 由 §4.7 接口封口）。
7. **中断继承全链路**（AC-M4-2）：impact 预览去重人数（多部门 1 人计 1、owner/创建者豁免）、二次确认、审计 diff、重开对称、restricted 后子节点（被关节点的子孙文档）可见性 EARS 语义（§4.5）。
8. **M5 可见集接口**（§4.7）：resolveVisibleNodeIds + buildVisibleScopeSql，契约冻结 + 500 人/万节点规模测试；不挂任何检索路由。
9. **tree/menu 服务端剪枝翻转**（M3 移交）：on 期无权 shortcut 剔除、空容器对普通成员隐藏、admin/可管理人标灰可见（ARCH 越权矩阵 #17，:579）；move-impact 升三源口径。
10. **enforce 翻转**：适配层切换为引擎决策，旧决策仅留影子日志；翻门证据与回滚演练（S10）。M4 出口默认 shadow，切 on 总监下令。
11. **审计 O10**：策略/继承/掩码变更事件 + 前后 diff；引擎模式切换（GX_AUTHZ_ENGINE）启动行入审计或运行日志。
12. **后端契约片 + openapi 增补**（S8/S9）：policies/inheritance/effective/scope 四组端点进 M3 冻结的 openapi.yaml，现网信封写实；前端权限面板（PermPanel/BreakInheritanceConfirmModal/来源链调试视图）为**独立 M4 前端片**，本文档只给契约与字段，不拆前端切片排期。

### 2.2 明确不做

| 不做 | 归属 | M4 临时姿态 |
|---|---|---|
| 行级/分组桶条件授权（ARCH §5.3 group.conditions 下推） | **P1（PRD :167 明确记录行级本期不做）** | conditions 列只收 null；非 null 400；引擎留 ctx.row 参数位不实现谓词 |
| 向量/FTS 统一检索接入、change_events/outbox | M5 | search.ts 旧预览一行不动；M5 凭 buildVisibleScopeSql 实现 AC-M5-2 |
| PAT、MCP 通道鉴权 | M6 | 引擎决策核心设计为通道无关（userId 入参），M6 直接复用 enforce()，M4 不提供 MCP 入口 |
| 字段结构权限（建列/删列/改类型 O5 结构语义） | 现状守卫承接 | M4 用 manage_schema 动作位表达表结构写，仍由 requireCanManageSchema 适配层映射，不新增字段结构 CRUD 的细分策略 UI |
| deny/黑名单、对人拒绝开关 | 永不（纯 allow 定稿） | 收权=移除来源；UI 明示并集（PRD C-6 :313） |
| 旧三表物理删除/停写 | 下一迭代评估 | M4 出口仍是投影双写；停写/删表需 on 稳定两个迭代后另开切片（ARCH :428） |
| 旧 /api 下线、信封切换 | 不做 | 适配层在旧路由内完成引擎替换，URL/响应信封零变化 |
| 权限申请审批流（O11） | P2 | 无 |
| O8"以某人视角预览"的专门 impersonation 端点 | 前端片用 effective 端点拼装 | GET effective 已返回给定 userId 的来源链与动作集，预览=换 userId 调同一端点（需 manage_share） |
| 多工作区/多租户 | Out-of-scope | workspaceId 恒 ws_default |
| 菜单个人化收藏/最近（M3 P1） | P1 | 无关 |

---

## 3. 不能动的契约（Characterization 先锁）

1. **旧 /api 全部端点的 URL、请求参数、成功响应形状字节不变**：适配层只换 guards.ts/kb.ts 函数体内部决策，调用方（60+ 处）零改动；shadow 期响应与 a65073d 完全一致（S0 golden + S3 对拍）。
2. **403/404 文案与 code 映射现状不变**：guards.ts:98-108 的 errorCodeForStatus 与中文 error 文案沿用；新增错误码只增不改（如 FORBIDDEN_FIELD 是新增 403 场景，旧场景文案不动）。"无权资源 404 不泄露存在性"（ARCH 矩阵 #1）只适用于**新 v1 节点级端点**；旧 /api 现状是 403（如 requireCanView :69），M4 不翻转旧端点的 403/404 选择（翻转即破坏契约 1；不泄漏存在性通过"不返回资源名/字段"已满足既有水平）。
3. **匿名三通道**（public.ts /s/:token、/s/:token/doc/:docId、/ref/:docId）不经引擎：sharePolicyAllows 作为引擎外纯函数保留其 shareRole/shareIncludeChildren 规则（ARCH :552-554）；M2/M3 已锁，M4 加对拍断言"匿名请求零 auth_policies 查询"。
4. **M2 即时性契约（AC-M2-1）不回退**：调岗/停用后的权限变化仍为"下一次请求"语义；引擎不得引入使该承诺退化的正缓存（决策不缓存，只缓存结构数据且带版本号）。
5. **M3 契约不破坏**：nav 同步强一致（M3 裁决 9）、menu_items 不触策略（AC-M3-1）、state 三态（alive/soft_dangling/broken）字段在剪枝后语义不变（剪枝是可见性另一维）；策略挂载点永远是 nav_nodes 不是 menu_items。
6. **auth_policies 冻结结构（M3 建表）只加不改**：M4 不删列、不改唯一键语义；actions 词汇逗号串、fieldMask/conditions 整存整取 JSON（不在 SQL 内抽 JSON，守 M2 方言边界：无 CTE、无 JSON 函数、参数化、LIKE 带 ESCAPE）。
7. **迁移只增、回填幂等、发布前快照、30 分钟可回滚**（SPEC :60 铁律）：回填迁移可重跑（upsert by 唯一键 + 来源标记，见 §5.1）；down SQL 只允许删 auth_policies 中带回填标记的行，不碰旧三表。
8. **资源角色五档语义连续**：permissionsForRole 矩阵（shared-types/permissions.ts:33-69）与 kb RANK（kb.ts:38）是回填映射的唯一真源；映射后对拍必须覆盖 5×4×3 角色档在 r/c/u/d/comment/manage 各动作上的等价性（S0/S3 golden）。
9. **M1 读链路不受掩码下推破坏**：fieldMask 在 queryRecords 返回之后、响应组装之前施加（§4.4 时序），不进 sidecar/queryPlan 物理层（M5 索引侧的"不索引字段"是另一条线，M4 不改 sidecar schema）；GX_M1_* flags 全组合下回归。
10. **画布 R10 与正文内链**（M3 契约）：权限翻转不影响画布内部交互；DocRefCard/GxLinkBlock 引用目标无权时的呈现归前端片（显示"无权限"占位，不篡改已落库链接）。

---

## 4. 引擎与数据模型设计

### 4.1 动作词汇与角色映射（单一真源放 shared-types）

```
资源动作（auth_policies.actions，逗号分隔，全集）：
  r         读（见节点/读记录/打开文档）
  c         新建（库内建表、表内建记录、组内建内容）
  u         更新（改名/改记录/编辑文档；表结构变更另需 manage_schema）
  d         删除（含归档/软删）
  comment   评论（文档/记录评论能力，对齐 requireCanComment guards.ts:91）
  manage_share  改本节点授权（策略写/继承开关；=旧 canManageBase 与 kb owner 的成员管理面）
  manage_schema 表结构（字段/视图配置；=旧 canManageSchema，仅 table 节点有意义）
```

| 旧角色来源 | r | c | u | d | comment | manage_share | manage_schema |
|---|---|---|---|---|---|---|---|
| members owner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| members creator | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| members editor | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| members commenter | ✓ | – | – | – | ✓ | – | – |
| members viewer | ✓ | – | – | – | – | – | – |
| kb_members owner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| kb_members editor | ✓ | ✓（内容） | ✓ | ✓（内容） | ✓ | – | – |
| kb_members commenter | ✓ | – | – | – | ✓ | – | – |
| kb_members viewer | ✓ | – | – | – | – | – | – |
| kb_doc_acls editor/commenter/viewer | 同上三档（仅挂 doc 节点） | | | | | | |

- 动作串规范化：存放前排序去重（字典序），同 actions 语义只有一种串形，对账与 upsert 幂等依赖此规范。
- 节点 kind 与动作的合法性在 API 层校验（doc 节点授 manage_schema → 400 POLICY_ACTION_INVALID）；管理动作不向下继承时的语义：manage_share/manage_schema **随祖先链继承**（库 owner 能管库内表的分享，与现状 requireCanManageBase 守卫面一致），不做特殊裁剪。
- 旧 PermissionSet 到动作的适配函数放 shared-types（新增 `resourceActionsForLegacyRole(system: 'base'|'kb'|'doc', role): string[]`），回填 SQL 生成与引擎共用映射，禁止两处各写一份。

### 4.2 主体展开（subjects.ts）

```
resolveSubject(user, workspaceId):
  deptIds   = SELECT d.id, d.path FROM dept_members dm JOIN departments d
              WHERE dm.userId=? AND d.deletedAt IS NULL          -- 用户各部门（兼岗）
  roleIds   = effectiveOrgRoles(user, workspaceId)               -- M2 接口，含部门继承的角色
  return { userId, dept: [{id,path}], roleIds,
           isWorkspaceOwner: roleIds.includes('role_owner') }    -- 兜底用，不展开成全量管理员集合之外的东西
```

- dept 源匹配（策略 subjectType=dept 命中用户）：`用户任一所属部门.path LIKE 策略部门.path || '%'`（用户在被授部门的子部门即命中，与 M2 角色继承同方向）；一条 SQL 的 OR 展开，参数数 = 用户部门数（500 人组织人均兼岗有界，主部门 1 + 兼岗少量）。
- role 源匹配：策略 subjectId IN roleIds（effectiveOrgRoles 已含 user 直授角色 + 部门祖先角色，role_assignments 表不在引擎里再 join 一次——**复用 M2 求值结果是避免两套角色展开语义漂移的关键**）。
- 悬挂主体（软删部门/已删角色）：M2 求值已排除软删部门（M2 计划 :206）；角色删除 M2 要求先清空（PRD C-12），引擎对查不到的 role/dept 策略行跳过并计数（O8 显红数据来源）。

### 4.3 客体收集（nodes.ts）与决策（engine.ts）

```
ancestorChain(nodeId):                                 -- 带 navVersion 的 LRU 结构缓存
  row = nav_nodes.findUnique(nodeId)                   -- 含 path/kind/inheritAncestors/resource*
  ids = row.path 切段（'/a/b/' → [a,b]，含自身）        -- path 是权威派生，一次点查拿到全链
  return rows（批量 id IN 取回，顺序自叶到根）

collectScopedNodes(subject, node):
  pols = []
  pols += policiesOnNode(subject, node.id)             -- 节点直接策略（三源 OR，定数 SQL）
  if node.inheritAncestors == 1:
     for anc of ancestorChain(node) 除自身:
        pols += policiesOnNode(subject, anc.id)
  return dedupe(pols by policyId)

decide(subject, node, action, ctx?):
  if node.resourceType 对应实体 createdBy == subject.userId: return ALLOW(owner_fallback:creator)
  if subject.isWorkspaceOwner:                              return ALLOW(owner_fallback:workspace_owner)
  for p of collectScopedNodes:
      if action not in split(p.actions): continue
      if p.conditions: continue            -- M4 只可能为 null（非 null 写入被 400 拦），留口
      if ctx.fieldId and not fieldAllowed(p, ctx.fieldId, action): continue
      return ALLOW(source: {type:'direct'|'dept'|'role', policyId, nodeId, viaAncestor:bool, deptId?/roleId?})
  return DENY(no_matching_allow)
```

- **policiesOnNode 三源一条 SQL**：`WHERE nodeId IN (...) AND ((subjectType='user' AND subjectId=?) OR (subjectType='role' AND subjectId IN (?)) OR (subjectType='dept' AND subjectId IN (?)))`；节点集 = 自身+祖先（通常 ≤ 6 个 nav id），总查询 2 条（节点行 + 策略行），与部门深度/节点总数无关。
- **决策无表名概念**：输入只有 nodeId；资源类型（table/doc…）决定 fieldMask 适用性与 createdBy 解析。nav node → 实体 createdBy 用 M3 resourceType/resourceId 映射按类型点查（可在 subject 会话内缓存，上限为本次判定的节点数）。
- **inheritAncestors=0 的 EARS 边界**：只裁剪**祖先**收集；节点自身的三源策略照常（组内重新分享=节点 direct allow，ARCH :451）；**该开关不向下传播**——子孙文档有自己的开关：子孙 inherit=1 时其祖先链中经过 restricted 父节点，收集规则为"从自身向上，遇到 inheritAncestors=0 的祖先节点即停止继续向上"（停止点节点的自身策略仍收集，因为它是子孙的祖先节点；被关节点自己的判定不收集它的祖先）。§4.5 给精确停止规则与 AC。
- 软删 nav 节点：M3 sync 保证软删资源节点带 deletedAt；引擎只在活节点决策；v1 端点对软删 nodeId 返回 404/410（不新建 410，用 404 NOT_FOUND）。
- fieldMask 合并：

```
fieldCapability(subject, tableNode):
  visible:  并集 = 任一命中 r 且 (无 allowFields 或 field ∈ allowFields)
  writable: 并集 = 任一命中 u/c 且可见且 (无 readOnlyFields 或 field ∉ readOnlyFields)
  无任何 r 来源 → 表级不可见（节点 403/剪枝），不产生字段级结果
```

  fieldMask 为 null = 该来源不裁剪（全字段）；故 allowFields 是**收窄清单**而非授权清单——不配置=不限制，配置=只列出的可见。多来源（表级授 r 无掩码 + 字段收窄的部门来源）取并集后表级宽来源胜出，符合"并集只增不减"（PRD D-2/C-6）；管理员要真正收窄必须收窄**宽来源本身**（O8 来源链指引"查看其他来源一并修改"）。

### 4.4 fieldMask 下推时序（五出口）

```
列表 GET records：
  requireCanView 适配层（shadow: 旧决策为准）
  → loadTableFields → queryRecords（M1 物理层不知掩码）
  → 【投影点】applyFieldMask(records, fields, capability, viewConfig)
       - records[].fields 删除不可见键（含 hydrated LinkRef/lookup/公式结果键）
       - visibleFields 结果再 ∩ 可见集；allFields 同步过滤（allFields 仅用于表结构能力，
         掩码后无权字段不出现；前端字段选择器自然不可选）
       - groups 桶/aggregations 列：fieldId 不可见则整列/桶剔除
  → 响应（键集合其余不变）
详情：同投影点施于单行 + fields
写：  loadTableFields → assertFieldsWritable(payload.keys, capability)
       不可见/只读键 → 403 FORBIDDEN_FIELD（整单，事务不开）；通过后进既有 withWriteTx
CSV： exportTableCsv 在 hydrate 后、组列前套同一投影点
hydrate 依赖：不改 hydrate 取数；投影点在出口；LinkRef.title 跨表隐藏按 §10-A-4 裁决
```

- 投影实现为纯函数 `domain/authz/fieldMask.ts`（mergeFieldMasks/applyMaskToRecords），全部单测可表驱动；不在 recordService 内部做（M1 模块零侵入，flag off 时函数不被 import——动态 import 或顶层 import 但调用点受 flag 守卫，保证 off 态零查询开销）。
- 掩码查询随当次请求的 decide 一并取得（capability 是 collectScopedNodes 的副产物），**不新增 SQL 往返**。

### 4.5 inheritAncestors 中断/恢复 EARS（AC-M4-2 实现细则）

停止规则（引擎）：

```
collectForNode(subject, X):
  chain = [X, ...祖先]
  cutoff = chain 中第一个（离 X 最近，不含 X）inheritAncestors=0 的节点 K
  收集节点 = X 自身策略 ∪ (X 到 K 之间各祖先，含 K 自身) 的策略；K 之上的祖先不收集
  （K 的开关保护的是 K 自己；对 K 的子孙，K 是"被允许的最后一个祖先边界"）
```

impact 预览（关）：

```
inheritanceImpact(node, nextValue:0|1):
  现可见用户集 V_now   = expandVisibleUsers(node)      -- 三源+祖先沿链展开到 userId 去重
  关后可见集 V_after   = createdBy ∪ direct 行用户 ∪ direct 行 dept/role 展开 ∪ role_owner 成员
  losing = V_now - V_after（去重 userId；多部门只计 1）
  gaining（重开时对称）= V_after' - V_now'
  返回 {count, items:[{userId,name,via:'role'|'dept'|'direct', sources:[...]}] 分页,
        exempt:[creator/owner 不计入]}
```

- expandVisibleUsers 复用 M2 usersWithRole 同款反向展开 + dept path 子树成员查询；500 人规模直接算（成员表小），items 分页（limit 100），count 必须精确（COUNT DISTINCT 单条）。
- 端点：`GET /api/v1/nodes/:id/inheritance/impact?value=0`（manage_share）；`PATCH /api/v1/nodes/:id/inheritance {value:false, confirmed:true}`；未确认 → 409 INHERITANCE_CONFIRM_REQUIRED + impact 载荷（M3 move 同款交互）。
- 仅 doc/canvas 叶子可切：其他 kind → 400 NODE_NOT_INHERITABLE；M3 恒 1 保证开启前无历史 restricted 节点。
- 写事务：update nav_nodes + bump navVersion（结构变了）与 policyVersion（决策输入变了，两个版本都 bump；M3 计划 :241 的版本分工在此交叉，属正确做法）+ 审计 inheritance_changed {from,to,count,actor}。

### 4.6 旧三表关系：选型对比与切换点

| 维度 | 方案甲：回填 allow + 旧表投影双写（**选**） | 方案乙：旧表为资源基线 + 策略叠加运行时双读合并（否） |
|---|---|---|
| 权威数 | 1 个（auth_policies）；旧表=物化投影，可由策略重建 | 2 个，判定时合并 |
| 新能力承载 | fieldMask/继承中断/角色部门授予全在策略表，表达完整 | 旧表只有 per-user 资源角色，新能力在策略表，合并需定义"策略 vs 旧成员行冲突谁赢"——又引回优先级/deny 问题 |
| 零漂移验证 | shadow 逐请求对拍，差异可数可归零 | 合并结果无单一参照物，漂移只能人工推理 |
| 回滚 | flag off：旧守卫读旧表（双写保证其新鲜），完全回到 a65073d 行为 | 无法干净回滚：策略行已独立增长，关掉新逻辑后这些授权消失 |
| 长期形态 | on 稳定 2 迭代后停旧表写、再评估删表（ARCH :428） | 永久双系统 |
| 成本 | 回填一次 + 10 写点双写（每点 ≤2 行同事务代码） | 每次判定多 2-3 条旧表查询且永久支付 |
| 主要风险 | 双写漏点 → 投影陈旧；缓解：S5 每写点真库测试 + 对账脚本持续可跑 + 回滚只依赖旧表（双写方向是策略→旧表也要覆盖 v1 策略写） | 语义复杂度不可逆 |

**写路径切换点表**（双写方向与时序）：

| 阶段 | 旧入口（/api members/acls 写） | v1 入口（policies 写） | 旧表角色 |
|---|---|---|---|
| shadow（默认） | 只写旧表 + **同事务投影策略行**（S5 起） | v1 策略写已开放（面板上线后）：写策略 + 同事务反写旧表（仅当策略可映射回 per-user 资源角色；角色/部门授予无旧表对应行，只写策略，回退意味着放弃这类新授权——可接受，ARCH :609 同口径） | 旧守卫的决策真源 |
| on（enforce） | 同上双写 | 同上 | 仅投影；旧守卫结果只记影子日志 |
| on +2 迭代（另开切片） | 旧表停写评估 | 单写策略 | 归档/删表 |

- 双写投影规则：members.upsert(role) → 对应 base 节点 user 策略行 actions=映射串（reason='legacy_backfill' 不打标到业务列——用 reason 列记录来源前缀 `legacy:member` / `legacy:kb_member` / `legacy:acl` / `policy:v1`，回填迁移与对账据此区分，**不加新列**；reason 在 M3 冻结结构中已存在）。
- 反向映射（策略→旧表）仅当 subjectType=user、node=base/kb/doc 实体节点、actions 恰好等于某一旧角色档映射串时可写；否则旧表不动（UI 上提示"该权限含新能力，旧版客户端不识别，关闭引擎后失效"，前端片文案）。
- 冲突处理：同节点同用户旧表角色与策略行都存在时（双写过渡期理论上同源一致），以策略为准；对账发现不一致记 D 类差异（§5.4）。

### 4.7 M5 可见集接口（先收敛后召回契约）

```ts
// domain/authz/scope.ts（M4 实现，M5 唯一消费入口；M6 同样消费）
interface VisibleScope {
  nodeIds: string[];                    // 预算内时直接给集合
  resourceIdsByType: Record<string, string[]>;
  truncated: boolean;
  policyVersion: number;
}
resolveVisibleNodeIds(userId, opts: {
  actions?: string[];                   // 默认 ['r']
  kinds?: Array<'base'|'kb'|'table'|'view'|'doc'|'canvas'|'group'>;
  budget?: number;                      // 默认 5000，硬上限 20000；超限 truncated=true 且拒绝召回方按集合模式使用
}): Promise<VisibleScope>

buildVisibleScopeSql(userId, opts): {
  sql: string;                          // 参数化片段，可作为 WHERE node_id IN (<scope sql>) 或临时表 INSERT
  params: (string|number)[];
  expectsTempTable: boolean;            // 超预算时 M5 必须物化临时表，禁止 IN 直拼
}
```

SQL 形状（无 CTE、无 JSON 函数；两步可接受）：

```sql
-- 1) 取主体（定数）：用户部门 path 集 + effectiveOrgRoles 角色集（M2 接口内部 SQL）
-- 2) 命中的授予节点 G：
SELECT n.id FROM auth_policies p
JOIN nav_nodes n ON n.id = p.nodeId
WHERE n.deletedAt IS NULL
  AND ( (p.subjectType='user' AND p.subjectId=@u)
     OR (p.subjectType='role' AND p.subjectId IN (<roles>))
     OR (p.subjectType='dept' AND p.subjectId IN (<depts>)) )
  AND (','||p.actions||',') LIKE '%,r,%'        -- 动作包含，参数化前后缀；或落地时用 instr，方言二者皆通用
-- 3) 可见集 = G ∪ G 子树（n.path LIKE g.path || '%' ESCAPE '\\'），再用
--    restricted 裁剪：对每个 inheritAncestors=0 的叶子 K，若非 K 自身被直接命中则其专属子树排除。
--    实现：SELECT 一次 G，SELECT 一次 restricted 节点表（同 SQL 族），在应用层集合运算
--    （集合规模 ≤ 万级，JS Set 运算毫秒级；避免在 SQL 里做递归差集）。
```

- 索引需求（S1 核对/增补）：auth_policies 现有 `[workspaceId,subjectType,subjectId]` 支撑主体反查；nav_nodes `[path]` 支撑子树；LIKE 前缀可走 B-tree。EXPLAIN 留证无全表 SCAN（万级节点 + 500 用户夹具）。
- M5 消费纪律（写入 M5 输入清单，M4 只声明）：召回前把 scope 物化为 search.db  ATTACH 临时表或分批 IN（≤499 个/批，SQLite 变量上限 999 留余量）；向量/FTS 候选必须 JOIN 收敛；**禁止"先召回全量再在应用层过滤"**（AC-M5-2 零泄漏的工程定义）。
- 字段侧：M5 的"不索引字段"消费 fieldMask 能力集——但字段可见是 per-user 的，派生库无法逐用户建索引；M4 只在 scope 响应附 `maskedTableFields: {tableNodeId: string[]}`（仅对用户有掩码的表，默认空数组不膨胀），M5 对命中文档摘要的字段剔除按此表执行（具体在 M5 计划展开，M4 冻结字段存在性）。

### 4.8 shadow 对拍、drift 分类与翻门

- 埋点位置：适配层函数内（guards.ts 五个 require*、kb.ts requireKb/requireDocAccess），旧决策得到后 `void shadowDecide(...)`——**不 await 阻塞响应**？否：决策必须与当次请求同上下文（同一主体/节点/动作），且查询极轻（2 条），定稿 **await 但不影响返回值**（与 M1 shadow 同形态，planner shadow 是同步跑完对拍的；若 P95 实测有压力再加异步队列，不预设）。
- drift 记录：结构化日志行 `authz_drift`（userId 哈希、nodeId、action、old、engine、mismatch 类、来源链）+ 进程内滚动计数（按 endpoint/动作/类分桶，最近 N=200 条环形缓冲供 runbook 排查，不落盘、不含响应体）。
- 分类：
  - **E-ALLOW-UNSAFE**：旧 allow/引擎 deny 的反向——实际是引擎更严，安全侧=引擎可能误拒（命名按风险方向：旧放行而新拒，用户可能被锁外）；
  - **E-DENY-UNSAFE**：旧 deny/引擎 allow——**越权风险，零容忍**；
  - 修正命名定稿：`DRIFT_OVERDENY`（旧允新拒，可用性风险）、`DRIFT_OVERALLOW`（旧拒新允，安全风险）。
- 翻门（enforce on 前置，全部满足才由总监下令）：
  1. S0/S3 全量 characterization 夹具（覆盖五角色×三资源族×继承/ACL 组合，≥ ARCH 矩阵 18 条 :560-581）对拍 DRIFT 全 0；
  2. 回填对账脚本对**升级副本库**全量随机抽样（每主体 20 节点，ARCH :604）0 漂移 + 全量小库（v0.1.0 风格种子库）逐判定对拍 0；
  3. shadow 在类生产演练库（M1 bench 造数设施造 500 用户/多部门/万节点/含 ACL 例外）跑确定性流量序列 0 漂移；
  4. 生产影子时长：**连续一个迭代**（对齐 M1 flags.ts:10 文字纪律）DRIFT_OVERALLOW=0 且 DRIFT_OVERDENY=0（M4 比 M1 更严：可用性漂移也必须归零，因为权限误拒无灰度容忍）；
  5. on 切换后保留 1 个迭代的"反向 shadow"（引擎决策、旧结果只记录），期间发现 OVERALLOW 立刻 flag off 回滚并启动故障 runbook。
- on 之后：旧决策分支在再下一个迭代删除（S11 只产出裁决与删除清单，实际删代码随 M5/M6 切片，因为 M6 MCP 从第一天只走引擎，ARCH :539）。

### 4.9 目录组织（新增代码边界，单文件 ≤300 行，资源分包）

```
apps/api/src/domain/authz/
  engine.ts        // decide/collectScopedNodes 纯决策（无 Hono 依赖，可表驱动单测）
  subjects.ts      // resolveSubject（包 M2 effectiveOrgRoles，不重写展开）
  nodes.ts         // ancestorChain、navVersion LRU、cutoff 停止规则
  repository.ts    // policiesOnNode 定数 SQL、CRUD 原语（*Tx 签名）
  fieldMask.ts     // 动作串规范、merge/apply 纯函数、键白名单
  scope.ts         // M5 契约：resolveVisibleNodeIds/buildVisibleScopeSql
  impact.ts        // inheritance/失访人数展开、move-impact 三源口径
  legacy.ts        // 旧角色映射（调 shared-types 新函数）、回填规则（供迁移文档与脚本共用）
  shadow.ts        // 对拍、drift 分类、环形计数
  backfill.ts      // 回填可调用实现（对账脚本复用，禁止第二套规则）
  reconcile.ts     // A/B/C/D 差异
  __tests__/       // characterization/ golden / 对抗 / 规模计数
apps/api/src/routes/v1/
  policies.ts      // GET/PUT nodes/:id/policies、GET effective
  inheritance.ts   // impact + PATCH（或并入 nodes.ts，按行数决定）
  scope.ts         // GET /api/v1/authz/visible-scope（M5/M6 联调探针，manage_share 或本人）
  index.ts（M2）   // 追加装配
apps/api/scripts/authz/
  reconcile-policies.mjs   // 只读默认，--apply 修复，--rebackfill 重放回填
```

---

## 5. 回填与对账（0 漂移定义）

### 5.1 迁移拆分（只增；编号排在 M3 两迁移之后，时间戳开工时定）

- 迁移 C `xxxxxx_authz_policies_backfill/migration.sql`：纯幂等 DML。前提：M3 三表已建且 nav 实体节点回填完成（迁移依赖目录顺序天然保证）。
- 无需 DDL 迁移（M3 冻结结构足够）；**S1 只在 EXPLAIN 证伪既有索引时**追加一个只增索引迁移（候选：`auth_policies(actions)` 不需要——动作匹配在节点行过滤后内存判定；scope 路径主要靠 subject 复合索引与 nav path，预期不用加，开工实测）。
- down SQL `prisma/docs/rollback/<ts>_authz_backfill.down.sql`：`DELETE FROM auth_policies WHERE reason LIKE 'legacy:%'`（只清回填/投影行；v1 手工策略 reason 不以 legacy 开头则保留——回滚演练定义：回滚=回到旧表权威，v1 新授权在 off 态本就不生效，保留行无害，二次升级仍在）。

### 5.2 映射规则（逐条，与 §4.1 表一致）

1. members 活行（用户未物理删除；含 DISABLED——行保留）→ base nav 节点（resourceType='base', resourceId=members.baseId）上 subjectType=user 策略，actions=base 角色映射，reason='legacy:member'。
2. kb_members 活行 → **kb 节点一行**（reason='legacy:kb_member'）；doc/canvas 不逐行物化（§0-3，待裁决 A-1）。
3. kb_doc_acls 活行 → doc 节点（resourceType='doc'）user 行，reason='legacy:acl'。
4. 唯一键冲突（nodeId,user 已存在，如 kb_member 与 acl 在 kb 节点不可能同节点；真正冲突在多次回填）：actions = 动作并集（等价比"取较高角色"，kb.ts:54-55 的并集语义：两档角色动作集是包含关系，取动作超集即取较高；非包含关系在旧角色体系不存在）。
5. owner 行**不自动授予 role_owner 组织角色**（ARCH :602 草案要求"owner 成员额外写 workspace_admin"——本计划建议否决，待裁决 A-2：把每个 base/kb 的 owner 全部抬成工作区管理员是语义放大，单人多库/历史测试库 owner 泛滥；资源管理能力已由其 manage_share 动作承载，workspace 管理面仍只归 M2 自举的 role_owner）。
6. 回填不产生任何 inheritAncestors=0 行（M3 全 1，PRD :603 同口径：不制造私密节点）。
7. 幂等：INSERT...SELECT + `WHERE NOT EXISTS (SELECT 1 FROM auth_policies ... 唯一键)`；actions 收敛用 §4.1 规范化串；重跑零行增长（第二次全被 NOT EXISTS 挡）。
8. 实体悬挂过滤：JOIN nav 节点必须是活节点（M3 回填后资源-节点 0 差异是本迁移前置门，M3 reconcile A/B 类=0 才允许跑 C）。

### 5.3 数量与分批

- members/kb_members 行数 = 用户级（每库每成员一行到容器节点），规模 ≤ 500 用户 × 库数，无膨胀；acl 行数 = 现有 kb_doc_acls 行数（本就稀疏）。对比 ARCH 逐 doc 方案：1000 成员×1000 文档省 99.9 万行（A-1 的量化论据）。
- 单条 INSERT...SELECT 完成（SQLite 单库体量小）；超大客户未来分批每批 5000（ARCH :600 纪律保留在脚本实现，不进迁移 SQL 复杂度）。

### 5.4 对账脚本：差异分类与 0 漂移

`scripts/authz/reconcile-policies.mjs [--apply]`，只读默认，有差异 exit=1：

- **A 类（旧表→策略缺失/不一致）**：A1 成员/ACL 行在对应容器/内容节点缺 user 策略；A2 actions 与映射表不符（如旧 owner 行缺 manage_share）；A3 reason 不是 legacy 前缀但动作串恰好等于某旧角色档（疑似手工污染，报告不自动改）。
- **B 类（策略→旧表悬挂/虚高）**：B1 legacy 行对应旧表行已不存在（投影未同步删除）；B2 指向软删/不存在节点；B3 主体用户不存在。
- **C 类（结构合法性）**：C1 actions 含非法动作词；C2 fieldMask 指向已删字段；C3 subjectType=dept/role 悬挂；C4 同节点同主体多行（违反唯一意图，理论上唯一键挡住，作完整性巡检）；C5 非 null conditions（M4 应不存在写入路径）。
- **D 类（决策漂移，核心）**：对夹具库/副本库逐 (用户, 资源节点) 跑旧决策与 engine.decide，任一动作不一致即出 DRIFT 行（含两路来源链）。`--apply` 修 A/B（用 backfill.ts 同一 upsert 原语），**D 类不自动修**（漂移意味着代码/数据分歧，只报告，人工按 runbook 定位）。
- **0 漂移定义**：A/B/C 计数全 0 且 D 类全量对拍（小库）或随机抽样（大库，每主体 ≥20 节点且覆盖所有有策略的节点类型）判定全等。连跑两次 `--apply` 第二次 no changes。

---

## 6. 切片总览与依赖

| 切片 | 标题 | 类型 | 主要触碰 | 对 657/3 基线影响 | 依赖 |
|---|---|---|---|---|---|
| S0 | 旧三表决策 characterization golden + M4 baseline | 测试+文档 | domain/authz/__tests__；docs/baseline | 只增测试 | — |
| S1 | 引擎纯函数层（subjects/nodes/engine/fieldMask/repository 定数 SQL） | 纯后端 | domain/authz/*（不接线）；shared-types 动作词汇/映射函数 | 无（无调用方） | M2-S5（effectiveOrgRoles 接口形态确认，可用 import 类型占位 + 开工接线） |
| S2 | 回填迁移 C + 对账脚本（只读/A·B·C 类）+ backfill.ts | 纯后端 | 1 迁移；scripts/authz；reconcile | 无（只增表数据，旧路径不读） | **M3-S1/S2**（三表+nav 回填在库） |
| S3 | shadow 适配层接线（guards.ts/kb.ts 七函数包壳）+ drift 设施 | 纯后端 | guards.ts、kb.ts（函数体）、config.ts（GX_AUTHZ_ENGINE）、audit 事件 | 中敏（动两守卫文件），flag 默认 off 零行为变化，S0 golden 保护 | S1、S2 |
| S4 | M5 可见集接口 scope.ts + /authz/visible-scope 探针端点 + 规模门 | 纯后端 | domain/authz/scope.ts；routes/v1/scope.ts | 无（新端点） | S1 |
| S5 | 策略管理 v1 API（policies/effective）+ manage_share 第五动作位 + 旧表 10 写点投影双写 | 纯后端 | routes/v1/policies.ts；bases.ts/kb.ts 双写接线；authActive.ts 动作枚举；owner 补位迁移 | 中敏（旧表写点事务内追加） | S1、M2-S5/S6、M3-S6（节点端点/v1 装配） |
| S6 | fieldMask 五出口下推 + FORBIDDEN_FIELD | 纯后端 | records.ts、recordService 投影点、csvExport.ts、hydrate 出口（不改取数） | 中敏（响应形状可能裁剪，flag off 不裁），S0 响应快照保护 | S5 |
| S7 | inheritAncestors 端点全链路 + tree/menu 剪枝 + move-impact 三源口径 | 纯后端 | routes/v1/inheritance.ts；domain/authz/impact.ts；M3 tree/menu 读路径（M3 已落地文件内追加剪枝） | 只增端点 + on 态剪枝（shadow/off 仍全量） | S5、M3-S5/S6 |
| S8 | openapi.yaml 增补冻结（policies/inheritance/effective/scope + 错误码） | 文档+测试 | docs/api/openapi.yaml；手写形状对拍 | 只增 | S5/S7 后（汇合点） |
| S9 | 后端契约片收口（DTO/shared-types/契约自测，供前端片消费） | 纯后端 | packages/shared-types；routes/v1/__tests__ | 只增 | S8 |
| S10 | AC-M4-1/2/3 自动化对抗 + 500 人/万节点规模 + 回填升级演练 + enforce 翻转演练（默认仍 shadow） | 混合 | __tests__；造数夹具；RC；docs/baseline 门文档 | 只增测试/文档 | 全部后端片 |
| S11 | 出口收口：ADR/40RC/runbook/baseline/旧守卫清理裁决 | 文档+验证 | docs/adr、docs/runbooks | 无 | S10 |

关键路径：S0 → S1 →（S2 依赖 M3）→ S3 → S5 → S6/S7 → S8 → S9 → S10 → S11；S4 只依赖 S1，可与 S2/S3 并行。

**排期硬约束**：
1. S2 之前 M3-S1/S2 必须合入（auth_policies 在库且 nav 回填 0 差异）；S5/S7 之前 M3-S5/S6 与 M2-S5/S6 合入。
2. S3 与 M3-S3（18 写点接线）**都会改 kb.ts/bases.ts/records.ts 区域**（M3 改实体写事务，M4-S5 改成员写点）：派工时 M3-S3 必须先收口，M4-S3/S5 再 rebase，避免同文件并行冲突（M3 裁决 10 的单线纪律延伸到 M4：后端顺序 M2 全片 → M3 全片 → M4）。
3. 前端权限面板为独立前端片（暂名 M4-FE），在 S8 openapi 冻结后派工；本文不排其 S 号。
4. GX_AUTHZ_ENGINE 默认值：S3-S10 期间 off（测试中显式开 shadow/on）；M4 出口交付 shadow 为建议生产值（由总监在部署时设），**代码默认仍 off**，与 M1 各 flag 保守默认一致。

---

## 7. 切片明细

> 每片统一给：新增/改动文件、要点与陷阱、独立验收命令、回滚。

### S0 — 旧三表决策 characterization + baseline

**新增**
- `docs/baseline/2026-09-17-m4-baseline.md`：基线 a65073d、54 文件 657/3、迁移 14（M2 后）；记录 M3 后预期 16、M4 回填迁移后 17；环境版本。
- `domain/authz/__tests__/characterization/legacy-decision-matrix.test.ts`：真库真迁移造夹具，逐值锁旧决策：
  - base 五角色 × {列表/详情/建记录/改记录/删记录/改结构/管成员/评论} 的 200/403 矩阵（调真实旧路由或直接调 guards 函数+断言 PermissionSet）；
  - kb 四角色 × doc ACL 三角色组合（含"取较高" :54-55：viewer 成员 + editor ACL → 可编辑；editor 成员 + viewer ACL → 可编辑）；
  - 无成员/无 ACL/软删资源 403/404 文案与 code；
  - 匿名 public 三通道不查成员。
- `legacy-response-shapes.test.ts`：锁 records 列表响应键集合（records/fields/allFields/groups/aggregations/total/filteredTotal）、详情 `{record,fields}`、CSV 表头列序——S6 后 off 态逐字节不变。
**验收**：`pnpm -w test` 全绿（657+N，只增不红）。
**回滚**：删测试与文档。

---

### S1 — 引擎纯函数层（不接线）

**新增/改动**
- shared-types 新增：`RESOURCE_ACTIONS` 常量（r/c/u/d/comment/manage_share/manage_schema 白名单）、`resourceActionsForLegacyRole(family, role)`、动作串规范化 `normalizeActions/hasAction`、FieldMask 类型（`{allowFields?:string[];readOnlyFields?:string[]}`）。
- `domain/authz/subjects.ts`：resolveSubject 调 M2 effectiveOrgRoles（**开工先核 M2-S5 实际导出名/签名**，若命名不同做薄适配，不复制实现）；部门 path 集一次查询。
- nodes.ts：ancestorChain（path 切段 + id IN 批量取）、navVersion LRU（容量 1000，key=workspace，版本失配弃；结构缓存不涉即时性承诺）、cutoff 停止规则纯函数。
- repository.ts：policiesOnNode 定数 SQL（三源 OR + nodeId IN），动作包含判定在内存（不用 SQL LIKE  actions，避免转义）；CRUD `*Tx` 原语供 S5。
- engine.ts：decide/decideMany（批量同表节点判定供 scope 与列表剪枝复用）/fieldCapability；owner_fallback 两类（workspace role_owner、实体 createdBy）。
- fieldMask.ts：merge（并集最宽）、applyMaskToRecords、assertFieldsWritable。
- 单测：ARCH §5.8 矩阵 #2/#3/#7/#8/#9/#10/#10b/#11 的决策表驱动用例（service 层直调，不经 HTTP）；cutoff 边界（K 自身策略收集/孙节点越过 K 不收集）；fieldMask 并集最宽 6 组合。
**陷阱**：不得在引擎内 import Hono/guards（纯域）；不得查旧三表（影子对拍的旧决策由适配层传入，引擎不读 members/kb_members——权威单一原则的代码边界）。
**独立验收**
```bash
pnpm --filter @gx/api test -- authz
pnpm --filter @gx/api typecheck
# SQL 计数测试：夹具（6 层部门 × 10 兼岗 × 7 层 nav）decide 单节点 Prisma 调用 ≤ 3，
# 与部门层数/节点数无关（instrumentPrisma 计数断言）
```
**回滚**：新目录无调用方，删除即可。

---

### S2 — 回填迁移 C + 对账脚本

**新增**
- `prisma/migrations/<ts>_authz_policies_backfill/migration.sql`：§5.2 全部 INSERT...SELECT NOT EXISTS；reason 前缀；动作串字面量与 shared-types 映射测试交叉断言（测试读 SQL 字面量比对，防止两处漂移）。
- backfill.ts（upsertByLegacy* 原语）、reconcile.ts（A/B/C，D 类在 S3 后补）、scripts/authz/reconcile-policies.mjs。
- runbook："升级后必跑 reconcile（预期 0 差异）"。
**独立验收**
```bash
# v0.1.0 风格库（含五档成员/四档 kb 成员/ACL 例外/软删资源）快照升级：
T=$(mktemp -d); DATABASE_URL="file:$T/t.db" pnpm --filter @gx/api exec prisma migrate deploy
node apps/api/scripts/authz/reconcile-policies.mjs        # A/B/C = 0
node apps/api/scripts/authz/reconcile-policies.mjs --apply # no changes
# 行数断言：策略行数 = 活 members + 活 kb_members + 活 kb_doc_acls（无逐 doc 膨胀）
```
**回滚**：down SQL 删 legacy 行；旧表零改动。

---

### S3 — shadow 适配层（中敏）

**新增/改动**
- config.ts：`authzEngine: 'off'|'shadow'|'on'`（GX_AUTHZ_ENGINE，resolve 仿 flags.ts:16-20，未知值→off；test 默认 off，对抗测试内显式置位并在 afterEach 还原，模式见 records-keyset.test.ts:62/179）。
- shadow.ts：shadowCompare(old, engine, ctx) 分类计数；环形缓冲；日志脱敏（只记 id 哈希/动作/nodeId）。
- guards.ts 五函数与 kb.ts requireKb/requireDocAccess：**旧决策代码路径保留为函数内分支**——off=旧逻辑；shadow=旧逻辑为准 + await 引擎对拍；on=引擎为准（on 分支 S10 才真正可触达，S3 先把分支结构写全，on 行为在 S5/S6 能力齐备前若被误开应 fail-closed？**不**：on 值在 S3 时点引擎只做节点 r 判定，会误拒——定稿 S3-S5 期间 on 解析为 shadow 并打 warn，S6 完成后 on 才生效，gate 函数 `authzEnforceEffective()` 显式表达此阶段门）。
- 资源→nodeId 解析：旧守卫入参是 baseId/tableId/docId，适配层用 nav_nodes `[resourceType,resourceId]` 索引一次反查（M3 已建）；table 的视图/记录动作映射到 table 节点（requireCanManageSchema 等）；doc ACL 映射 doc 节点。
**陷阱**：requireCanView 返回 `{userId, role, perm}` 被路由消费（不只做布尔门禁），shadow/on 下返回值形状必须保持（on 期 role/perm 由策略反解：role 取旧表投影值——投影仍在双写，故继续读 member 行取展示用 role 是允许的，决策才以引擎为准）。
**独立验收**
```bash
pnpm --filter @gx/api test                 # off 态：S0 golden 全绿、零新增 SQL（off 分支不实例化引擎）
GX_AUTHZ_ENGINE=shadow pnpm --filter @gx/api test   # 全部旧测试绿 + 回填夹具 drift=0
# 故障演练：引擎内抛错 → shadow 态必须吞错记 metric 不影响旧响应（fail-open 仅限 shadow 观测层）
```
**回滚**：GX_AUTHZ_ENGINE=off；适配分支保留无副作用。

---

### S4 — M5 可见集接口

- scope.ts：§4.7 两形态；集合运算在应用层（G ∪ 子树 − restricted 裁剪）；budget 截断语义。
- `GET /api/v1/authz/visible-scope?actions=r&kinds=doc,canvas,table`：本人可查（供前端"无权列表"诊断），查任意 userId 需 manage_share。
- 规模夹具：M1 造数设施扩成 500 用户（多部门 6 层、人均 2 部门）、1 万 nav 节点（base/table/doc 按比例）、策略 3000 行；断言：单用户 scope SQL ≤ 4 条、EXPLAIN 无 SCAN（nav path/主体复合索引）、P95 时延留证进 baseline、结果与逐节点 decide 全量对拍 0 差异（scope 快路径不得与 decide 语义分叉——同一条 collectScopedNodes 逻辑的批量形态）。
**验收**：上述；M5 团队（未来）只凭 openapi 与本文件签名消费。
**回滚**：删端点/新文件。

---

### S5 — 策略管理 API + manage_share + 投影双写（中敏）

**新增/改动**
- 第五组织动作位（照 M3-S6 清单跨文件改）：`authActive.ts:11` 联合与 `:34` allowed 追加 `"manage_share"`；shared-types OrgAction 同源追加（开工核 M3 落地的白名单位置，M3 S6 已踩过一次同样的坑，见 M3 计划 :512-516）；角色管理端点校验集合同源。
- owner 补位只增迁移：`UPDATE roles SET permissions=...,'manage_share'] WHERE id='role_owner' AND permissions=...四动作串`（幂等 WHERE 全串匹配，M3 manage_menu 迁移同款）。
- `routes/v1/policies.ts`：
  - `GET /nodes/:id/policies`：返回节点策略行（主体解析出 name/kind 供面板）+ 当前继承状态 + 祖先只读策略摘要（O4/O7）；
  - `PUT /nodes/:id/policies`：单事务批量 `{upserts:[{subjectType,subjectId,actions,fieldMask?}], deletes:[{subjectType,subjectId}]}`，整单校验（动作白名单、节点存在非软删、kind-动作合法、fieldMask 字段必须属于该 table、subject 存在/未悬挂），任一不合法 4xx 全拒；bump policyVersion + 审计 policy_changed（diff）；
  - `GET /nodes/:id/effective?userId=`：来源链 decide 解释器——返回最终动作集 + 每条 `{action, sources:[{kind:'role'|'dept'|'direct'|'owner_fallback', policyId, nodeId, nodeName, viaAncestor, subjectName}]}`（O8，AC-M4-1"展示全部来源"）；缺省 userId=本人；查他人需 manage_share。
- 鉴权：读策略 r；写策略/继承 = requireOrgAction('manage_share')（组织动作）**或** 对该节点 decide(action=manage_share) 放行（资源级分享者，对齐 ARCH :528"创建人+可编辑者+管理员"——manage_share 动作既挂组织角色也可由资源 owner 行持有）；两判定取或，在路由内组合，不污染中间件。
- **投影双写接线（§1.2 共 10 点）**：bases.ts :153/:345/:371/:384/:459、kb.ts :254/:281/:586/:766/:769/:634（11 个实际条目，634 随文档物理删清策略）；每点在既有事务（多数当前裸写，沿用 M3 纪律：最小 withWriteTx 包裹，行为等价收紧，M3-S3 若已包则复用同事务）内调 repository `*Tx` 原语；v1 策略写反写旧表按 §4.6 反向映射。
- nav purge 挂钩：M3 purgeResourceNodeTx 内删节点策略（M3 文件已合入时追加其原语调用，作为 M4 对 M3 文件的唯二触碰点之一——另一个是 S7 剪枝；触碰需在切片 PR 单独列出）。
**独立验收**
```bash
pnpm --filter @gx/api test
# 每写点真库双向证明（M3 裁决 9 同款升级）：
#  ① 旧入口加/改/移除成员 → 策略行同步出现/变更/消失；flag off 后旧守卫按新角色正确决策（回滚演练）
#  ② v1 PUT 策略（可映射档）→ 旧表行更新；不可映射授权（角色/部门）→ 旧表不动且响应有提示字段
#  ③ 注入策略写失败 → 成员写整体回滚（无半截）
# 幂等：owner 补位迁移连跑两次 permissions 恒为五动作；白名单穷举测试（五动作 × requireOrgAction）
```
**回滚**：flag off + 旧表权威；down SQL 清 legacy 行；manage_share 动作位多一枚无副作用。

---

### S6 — fieldMask 五出口（中敏）

- 投影纯函数接 records.ts 列表（:359 组装前）、详情（:610）、CSV（csvExport 组列前）；写键校验在 create/patch 事务前（:395/:628 loadTableFields 之后）。
- groups/aggregations：读 groups/aggregations 响应结构后按 fieldId 剔除（S6 开工时补读 recordService groups 产出形态，本计划不预设字段名，验收以测试快照锁定）。
- M1 物理路径：compile 阶段（domain/queryPlan/compile.ts，开工实读）禁止以掩码外字段做物理 filter/sort/aggregate 下推——断言：带隐藏字段条件的 view config 在 on 态该条件无效化（与前端该列消失一致，不能用隐藏列偷偷过滤），shadow/off 不变。
- on 态阶段门：authzEnforceEffective()=false 期间投影点不生效（即使 flag=on），S6 合入后开放。
**独立验收**
```bash
GX_AUTHZ_ENGINE=on pnpm --filter @gx/api test
# AC-M4-3 六通道用例（S10 自动化收口，本片先建单测）：
#  列表/详情/导出/直调 API/关联展开（LinkRef.title）/公式引用（依赖列计算但不出现原值）
# 写：patch payload 带隐藏键 403 FORBIDDEN_FIELD 且整行未改；带只读键 403；合法键正常
# off/shadow：响应快照与 S0 字节一致
pnpm --filter @gx/web build   # 仅确认 shared-types 重建不爆类型（前端片未开工）
```
**回滚**：flag off，投影点短路；无 schema 变化。

---

### S7 — 中断继承 + tree/menu 剪枝 + impact 升级

- inheritance.ts：impact（§4.5 展开/COUNT DISTINCT/分页 items/豁免清单）+ PATCH（confirmed 门、kind 白名单、双版本 bump、审计）。
- tree/menu 剪枝（M3 移交项，M3 计划 :659）：on 态（authzEnforceEffective）tree 读对无 r 节点裁剪子树（父无权则子树不出现——子节点有 direct 例外时**子节点仍出现但挂在可见性提升位**？定稿：nav 树按权威父结构，父无权子有权时子节点也不出现在该子树位置（权威树不可达），但 menu shortcut 直达与内容 URL 直访仍可打开（权限在、导航路径断，符合继承中断语义）；menu 侧无权 shortcut 剔除、空容器对普通成员隐藏、可管理人标灰（ARCH #17）；shadow/off 全量不变。
- M3 move-impact 口径升级：受影响人数改三源展开（impact.ts 复用），willBreakInheritanceHint 计算移动是否跨越 restricted 边界给真值。
**验收**：AC-M4-2 全流程自动化预演（S10 封口）；关继承后同库其他 doc 仍可继承访问（ARCH #10）；restricted+direct 放行、移除 direct 立即 403（无缓存）。
**回滚**：端点新增可摘；剪枝随 flag；inheritAncestors 已被置 0 的行在回滚后旧守卫不读此列（行为=旧表决策，不受影响，重新开继承只需一次 PATCH）。

---

### S8 — openapi 增补冻结

- 在 M3 首版 openapi.yaml 上只增：policies GET/PUT、inheritance impact/PATCH、effective GET、visible-scope GET；错误码 5 枚；FieldMask/PolicyRow/PolicyChange/EffectivePermission/InheritanceImpact/DiagSource schemas；bearerJwt 安全沿用。
- 写实信封 `{error,code}`（裁决 5）；手写真实响应形状对拍测试，零新依赖（M3 S7 纪律）。
**验收**：yaml 结构合法（M3 已定的最小检查手段）+ 形状对拍绿。
**回滚**：纯文档/测试。

---

### S9 — 后端契约片（供前端 M4-FE 消费）

- shared-types 只增：PolicySubject/PolicyRow/PolicyUpsert/EffectiveAction/InheritanceImpact/VisibleScope DTO；api 侧 client 契约在前端片接（本仓 apps/web 不改）。
- 契约自测：所有 v1 新端点在无权限（viewer）/有 manage_share/owner 三身份下的响应快照；枚举/错误码表落 docs/api。
- 前端片输入清单（写入 M4-FE 派工文档，本节登记）：PermPanel（资源树+主体三页签+矩阵+字段三态可见/只读/可编辑，SPEC :98）、Break/RestoreInheritanceConfirmModal（:100）、来源链抽屉（O8）、DocAclModal 改造为同表视图、图标只追加 icons.tsx（候选 shield/lock/unlock/keyRound/inherit/cutoff，禁止第二套库与 emoji）、全部 gx token、只走 api/client.ts 无新依赖。
**验收**：shared-types build；api/web typecheck 双过。
**回滚**：类型只增。

---

### S10 — AC 对抗 / 规模 / 翻转演练总验证

**自动化对抗用例（AC 逐条）**

- **AC-M4-1**（去角色留其余来源 + O8 来源链）：
  1. 用户仅经部门 D 获角色 R，R 授 table A 的 r；移除 role_assignment（角色页移除）→ 下次请求 effective 不含该来源；若另有 dept 直接授权或 direct 行，按其余来源判定（构造三源齐全后逐一切断，每切一次断言动作集与来源链）；
  2. GET effective 同时列出 role/dept/direct 三类来源（含 viaAncestor 节点名）；
  3. 调岗（移出 D / 移入有权部门）下一次请求权限即时变化（无 policyVersion 等待）。
- **AC-M4-2**（中断继承 EARS）：未确认 PATCH → 409 + impact 且状态不变；确认 → restricted、审计 diff；失访人数多部门去重=1、createdBy/owner 豁免且自己仍可访问；重开对称，预览"恢复人数"；孙节点经 K 的边界规则两条用例。
- **AC-M4-3**（字段一致缺席）：hidden 后列表/详情/导出/直调 GET/关联 LinkRef/公式引用六通道无该列与原值；写该字段键 403 且行不变；M1 flags 四组合（sidecar read off/on × keyset off/on）回归。
- **越权直调**（ARCH #1/#2/#12/#17）：无关系用户直调各 /api 与 v1 端点 403/404；viewer 直调写端点 403；停用用户持旧 JWT 全端点 401（M2 契约联测）；on 态菜单无权项剔除、URL 直访行为。
- **回填升级等价（PRD :383）**：v0.1.0 风格快照 → 全迁移 → reconcile 0 漂移；旧分享链接 /s/* 逐条可开（匿名通道独立）；随机 20 主体×20 节点新旧判定全同。
- **双写共生死**：11 写点注入失败回滚证明（S5 已建，S10 复跑抽全）。
**规模门**：500 用户/万节点夹具：decide P95、scope P95、policyVersion bump 频率计数、SQL 计数；留证 `docs/baseline/2026-09-17-m4-gate.md`。
**翻转演练（不切生产默认）**：off→shadow（旧测试全绿）→shadow 全量 drift=0→on（对抗用例在 on 态全绿）→on 态反向 shadow 计数正确→off 回滚（旧行为恢复、投影数据支撑旧守卫）；产出"切 on 操作清单"runbook，下令权归总监。
**RC**：40 RC 全量复跑 + M4 新 RC 组追加 docs/baseline/2026-09-12-regression-cases.md。
**回滚**：纯测试/文档。

---

### S11 — 出口收口

- ADR 归档（§8）；40RC + S0 golden 逐值绿；openapi/DTO 对拍 0 diff。
- runbook 增章："权限漂移排查（reconcile D 类）"、"成员被锁外/误授应急（移除来源 vs 关引擎两条路）"、"GX_AUTHZ_ENGINE 三态操作与回滚"、"inheritance 误关恢复"、"旧表投影不一致修复"。
- 旧守卫分支清理裁决文档：列出 on 稳定两迭代后的删除清单（guards.ts 旧决策分支、kb.ts 旧查询、旧表停写顺序），**不在 M4 删**。
- baseline：测试计数（657 → 预计 +180~230，以实现为准）、迁移数、规模数据、升级演练记录。

---

## 8. 关键设计决策（ADR 候选）

- **ADR-0031 纯 allow 三源并集与无 deny 收权模型**：owner_fallback → direct → 祖先 allow → 拒；收权=移除全部来源；与 kb.ts:54 取较高语义的连续性证明（动作集包含关系）；否决 deny 列/后写覆盖/优先级数。
- **ADR-0032 旧三表回填为 allow 投影而非运行时双读合并**：§4.6 七维对比；权威单一、可回滚、零漂移可验证；双写共生死纪律（M3 裁决 9 延伸）；旧表退役路径。
- **ADR-0033 kb_members 映射到 kb 节点单行（覆盖 ARCH §6.2 逐 doc 物化）**：nav 祖先继承已是引擎一等能力，逐 doc 拷贝冗余且随新增文档失效（新建文档瞬间两系统不一致窗口）；量化 1000×1000 省百万行；代价：无（继承语义本就在引擎中）。
- **ADR-0034 fieldMask 挂 table 策略行而非 field 节点**：M3 ADR-0030 不建 field 节点的下游定稿；allowFields/readOnlyFields 收窄语义与并集最宽；五出口单一投影纯函数；计算字段依赖取数不下发。
- **ADR-0035 继承中断的 cutoff 停止规则（非简单布尔）**：K 关继承保护 K 自身；子孙链在 K 截断但 K 自身策略仍及于子孙；impact 去重展开算法；二次确认 EARS。
- **ADR-0036 GX_AUTHZ_ENGINE 三态 shadow/enforce 翻转门**：仿 M1 三态先例；DRIFT_OVERALLOW/OVERDENY 双零 + 一迭代时长 + 反向 shadow；默认 off 的保守姿态；与 M3 GX_ENTERPRISE_NAV 的正交关系。
- **ADR-0037 M5 先收敛后召回的 scope 契约**：两形态（id 集 budget / 参数化 SQL 片段）；无 CTE 集合运算上移应用层；禁止先召回后过滤；规模上界证据。
- **ADR-0038 owner 兜底口径（待 A-2 裁决后定稿）**：建议=workspace role_owner ∪ 实体 createdBy，不把资源 owner 批量抬成 workspace_admin；manage_share 资源动作承担资源分享管理。

---

## 9. 对 657/3 基线的影响面与保护

| 触碰源 | 切片 | 保护 |
|---|---|---|
| auth_policies 数据回填（无 DDL） | S2 | 旧路径不读该表；down 按 reason 前缀清；迁移只增 |
| guards.ts / kb.ts 七函数体 | S3/S5/S6 | flag off 旧分支逐值执行；S0 golden + legacy 响应快照；适配层分阶段 gate（on 在 S6 前不生效） |
| 旧三表 11 个写点事务追加 | S5 | M3-S3 先行避免同文件冲突；每写点双向回滚真库测试；投影失败整体回滚 |
| records/csv 响应裁剪 | S6 | flag gate；off/shadow 响应字节快照；M1 flags 四组合回归 |
| M3 tree/menu 读路径剪枝、purge 原语 | S7/S5 | on 态才剪；M3 state 三态契约不变；触碰 M3 文件在 PR 单列 |
| 第五组织动作 + owner 迁移 | S5 | 只增一枚；穷举白名单测试；幂等 UPDATE |
| /api/v1 新端点 + 新 flag | S4/S5/S7 | flag off 不挂新子路由（或挂了也 404——按 M3 合并挂载现状，开工核 app.ts）；旧 /api 零 diff；rateLimit 按 /api/ 前缀自动覆盖 v1 |
| shared-types 只增 | S1/S9 | 不动现有 PermissionSet/Role（新映射函数并列） |
| 审计事件只增 | S5/S7 | 联合类型只增；脱敏设施复用 |
| 前端 | 独立 M4-FE | 本里程碑后端片零 apps/web 改动（S6 仅 typecheck 旁证） |

统一回归口令（每片 PR 必贴，M3 后以新基线数字替换）：

```bash
pnpm -w install --frozen-lockfile
pnpm --filter @gx/shared-types build
pnpm --filter @gx/api typecheck && pnpm --filter @gx/web typecheck
pnpm -w test            # api 657+N / 3 skipped、web 基线、shared-types 基线，只许增不许转红
pnpm --filter @gx/api lint
bash scripts/ci-quality.sh
GX_AUTHZ_ENGINE=shadow pnpm --filter @gx/api test   # S3 起每片必跑：drift=0
```

预计新增测试：S0 ~22、S1 ~45、S2 ~16、S3 ~18、S4 ~12、S5 ~34、S6 ~20、S7 ~22、S8 ~8、S9 ~10、S10 ~30（api 657 → 约 +200~240，以实现为准）。

---

## 10. 待项目总监裁决清单（终审前阻断）

| # | 议题 | 架构师建议 | 影响 |
|---|---|---|---|
| A-1 | kb_members 回填粒度：kb 节点单行继承（建议）vs ARCH :600 逐 doc 物化 | **单行**（ADR-0033，省百万行、无新增文档不一致窗口）；逐 doc 物化仅在引擎证明无法沿 nav 祖树覆盖 kb 文档时回退（S1 对拍可否决本建议） | §5.2-2、回填行数、对账 A 类 |
| A-2 | 资源 owner 是否自动授 workspace role_owner（ARCH :602 草案） | **不自动抬升**；workspace 管理仍只归 M2 自举 owner；资源 owner 持 manage_share 动作（ADR-0038） | 兜底语义、影响人数、越权矩阵 #11 |
| A-3 | enforce 翻转门时长与阈值 | shadow 连续一迭代 + DRIFT 双零（比 M1 更严，误拒也归零）；代码默认 off，切 on 总监下令；M4 出口生产建议值 shadow | S10、runbook、发布姿态 |
| A-4 | LinkRef.title 指向目标表中对当前用户隐藏字段时的呈现 | 回退显示 record id（不显示空、不伪造标题），前端片显示"无权限查看标题" tooltip；公式依赖同口径（值缺席按 null 参与计算并在来源链标注）——**注意这可能改变跨表引用显示，需产品确认是否接受 id 兜底** | hydrate.ts:499-524、AC-M4-3 关联展开通道 |
| A-5 | v1 策略写对旧表不可映射时（角色/部门授予、fieldMask 收窄），flag off 回滚后该授权失效的告知方式 | 响应 200 带 `legacyUnmappable: true` 提示字段 + 面板内警示文案（不阻断写入）；不做旧表 schema 扩展 | §4.6 切换点、S5 API 形状 |
| A-6 | tree 剪枝中"父无权、子 direct 有权"节点是否在权威树响应出现 | **树位置不出现、直达 URL/shortcut 可开**（权威结构不造伪父）；菜单 shortcut 若存在则正常显示 | S7、ARCH #17 解释、前端片 |
| A-7 | 行级分组条件（conditions/ARCH §5.3）正式顺延 P1 的确认 | 顺延（PRD :167 已述记录行级本期不做）；conditions 列 M4 只收 null、非 null 400；move-impact 的分组桶预览随之不含行级人数 | 范围 §2.2、scope 接口不含行谓词 |
| A-8 | 前端面板是否在 M4 同里程碑交付（独立 M4-FE 片）还是随后续 | 建议同里程碑（PRD M4 出口含 O4 面板验收 :264），S8 冻结契约后派工前端片；本文只交后端切片 | 排期、M7 总验收范围 |

---

## 11. M4 出口 Definition of Done（摘）

1. AC-M4-1/2/3 自动化全绿：三源切断/来源链完整；中断继承二次确认+去重人数+审计+重开；字段六通道一致缺席且写键 403 整行不变。
2. v0.1.0 风格库直升演练：迁移后 reconcile A/B/C=0、D 类对拍 0 漂移；旧分享链接与抽样资源权限逐值等价；幂等重跑 no changes。
3. shadow 门证据齐备（S10 gate 文档）：全 characterization + 类生产演练流量 DRIFT 双零；切 on/回滚操作手册；**代码默认 off**，生产取值由总监下令。
4. 500 用户/万节点：decide 与 scope 定数 SQL、无 SCAN、P95 留证；调岗/收权下次请求即生效（无决策缓存）。
5. openapi 增补冻结并与真实响应/DTO 对拍；ADR-0031~0038 归档；40RC 全绿；657+N/3 + lint/typecheck/ci-quality 全门；匿名三通道零引擎查询断言。
6. 旧三表 11 写点双写双向回滚证明齐全；旧 /api URL/信封/文案零变化；M1 flags 四组合与 M3 画布/内链 RC 通过。
7. scope 契约可供 M5 直接消费（含 maskedTableFields），M5 接入时不需改引擎。

---

## 12. 现状核对后与旧文档/锚点的不符与澄清

1. **ARCH §6.2 逐 doc 回填**（:600）与引擎继承能力自相矛盾：引擎既沿 nav 祖树收集（§5.2 :476-481），kb 级授权挂 kb 节点即覆盖全部文档；逐 doc 物化是引擎设计前的保守草案。本计划 A-1 提请裁剪。
2. **ARCH §6.2 owner→workspace_admin**（:602）在 M2 角色模型下语义偏大：M2 role_owner 是工作区管理员（系统角色五枚，M2 计划 §5-A），资源 owner 是 per-base/kb 的协作角色，二者不等价；自动授予会让历史库 owner 全部获得通讯录/全库管理权。A-2 待裁。
3. **ARCH §5.6 L1 缓存 TTL 300s**（:544-549）与 M2 已定的"零跨请求缓存、下次请求即变"（M2 计划 :223、AC-M2-1）冲突。M4 从 M2 纪律：决策不缓存；仅 nav 祖树结构按 navVersion 缓存（结构变更频率低且版本号即时失效），主体展开复用 M2 的无缓存定数查询。policyVersion 列保留给未来多实例（ARCH :548），单实例不消费。
4. **ARCH §5.5 旧守卫"路由文件零改动"**（:535）在本计划细化：路由调用点零改（60+ 处），但 guards.ts/kb.ts 两文件函数体要改（适配层本就位于其中）；另需在 11 个旧表写点加双写——这些写点代码在路由文件内（bases.ts/kb.ts），"零改动"应理解为**端点签名与调用方零改**，写事务内追加投影不违背其降回归面意图。
5. **ARCH §5.1 group 条件节点行级权限**（:448、§5.3 :506-511）与 PRD :167"记录行级本期不做"冲突；以 PRD 为准，conditions 冻结不启用（A-7）。M3 group 节点 config.bucket 已预留（M3 计划 :174），未来启用不需补表。
6. **actions 词汇扩充**：ARCH :442 列 `c/r/u/d` + manage 位但未列 comment 的存放方式；现网 requireCanComment（guards.ts:91-95）与 kb RANK commenter 档证明 comment 必须独立可授（viewer 无评论权，permissions.ts:62-67），本计划把 comment 收进 actions 串（M3 冻结列类型 String 足够），不新增表列。
7. **M2 在途文件真实状态**（2026-09-17 实查）：domain/org/ 仅 authState.ts（96 行）/authStateCache.ts（67 行），roles.ts/lifecycle.ts 尚不存在；routes/v1 仅 index.ts（30 行，/meta 探针）。本计划所有对 effectiveOrgRoles/hasOrgAction/usersWithRole/lifecycle 的引用是**面向 M2-S5/S6 交付物的编程契约**，S1/S5 开工必须先复核实际导出名与返回形状（M2 计划 :212-217/:446-447/:460 为当前唯一依据），发现偏差走变更通知，不在 M4 内改 M2 文件。
8. **authActive.ts 动作枚举止于三枚**（:11/:34）：M3-S6 将加 manage_menu（M3 计划 :512-516 已列跨文件清单），M4-S5 再加 manage_share 时联合应为五枚；若 M4 开工时 M3 未合入，manage_share 不得先行单独加（v1 装配依赖 M3 挂载合并点），排期硬约束已在 §6 声明。
9. **config 现状无 GX_AUTHZ_ENGINE**（config.ts:175-230 只有 enterpriseOrg/authStateTtlMs 等）；新增项位置与解析仿 enterprise 布尔但类型为三态，解析函数放 domain/authz 内（与 queryPlan/flags.ts 同构）而非塞进 config.ts 扩 union——config.ts 只存原始字符串或三态值之一，开工按 M3 enterpriseNav 落地形态对齐。
10. **search.ts 旧检索不读 nav/策略**（:58/:122 仍直接 members/kbMembers 循环；ADR-0005 有界预览 :77-78）：AC-M4-3 提到"检索"，M4 能封口的只有 records 列表搜索（applyViewQuery 同链路）；全局/FTS/向量检索零泄漏是 M5 AC-M5-2，M4 交付 scope 接口与"search.ts 不接引擎"的显式边界，避免在 M4 重写 search.ts（那是 M5 的工作量与风险面）。
11. **M3 auth_policies 已有 reason 列**（M3 计划 :225）：回填来源标记复用它（legacy: 前缀），不需要新列；ARCH 草案无此用法，属于对冻结结构的无害消费。
12. **迁移计数**：当前 14（20260915090100 为止）；M3 +2 = 16；M4 回填 +1 = 17，索引补强迁移视 S1 EXPLAIN 证据决定（可能 18）。ci-quality.sh 动态对账不写死数字（M3 计划 :94 已核实机制）。
13. **records 列表 allFields 也必须掩码**（:364）：它被前端字段配置/隐藏列选择器消费；只裁 fields 不裁 allFields 会泄露字段名与类型（AC-M4-3"不出现该列"含结构元数据）。同理字段建改端点（fields.ts）的列表返回不受影响（结构管理靠 manage_schema 守门，能管结构者本就可见全部字段——字段数据权限与结构权限分离，PRD :162-163）。
14. **kb doc 物理删已级联清 acls**（kb.ts:634）但不清理策略：M3 purge 节点时 M4 挂钩删 auth_policies（S5），软删不删（恢复自动还权）；该行为与 M3"软删悬挂保留引用"一致。
15. **角色 subject 的策略无 scope 概念混用风险**：role_assignments 有 scopeType/scopeNodeId（schema.prisma:450-451，M2 恒 workspace），auth_policies 自身带 nodeId 已是资源 scope；引擎不读 role_assignments.scopeNodeId（M2 求值内部处理），M4 不引入资源级角色分配（角色是工作区主体，M2 计划 :195 口径）。
16. **审计当前仅 6 事件且 audit.ts 是硬编码联合**（:9-15）：M4 新增 4 事件需同改联合与任何事件名穷举测试；JSONL 脱敏复用，policy diff 中不含字段值只含字段 id/动作名。

---

## 13. 切片速查（供派工 / RoleVerdict）

| ID | 标题 | 关键文件 | 独立验收（一句话） | 依赖 |
|---|---|---|---|---|
| S0 | 旧决策 golden + baseline | domain/authz/__tests__/characterization；docs/baseline/2026-09-17-m4-baseline.md | 五角色×三资源族矩阵与响应形状快照全绿，657 只增 | — |
| S1 | 引擎纯函数层 | domain/authz/{engine,subjects,nodes,repository,fieldMask}.ts；shared-types | decide 对 ARCH 矩阵用例全对、单判定 SQL ≤3 且与规模无关 | M2-S5 接口形态 |
| S2 | 回填迁移+对账 | <ts>_authz_policies_backfill；backfill.ts；scripts/authz | 旧库升级后策略行数=成员/ACL 行数、A/B/C=0、重跑 no changes | **M3-S1/S2** |
| S3 | shadow 适配层 | guards.ts；kb.ts；shadow.ts；config（GX_AUTHZ_ENGINE） | off 字节不变；shadow 全量 drift=0；引擎报错不影响旧响应 | S1/S2 |
| S4 | M5 可见集契约 | scope.ts；routes/v1/scope.ts | 500 人/万节点 scope 与逐节点 decide 对拍 0 差异、无 SCAN | S1 |
| S5 | 策略 API+manage_share+双写 | routes/v1/policies.ts；bases/kb 11 写点；authActive；owner 迁移 | 三源策略 CRUD/来源链正确；11 写点双向回滚证明；旧表回滚可用 | S1、M2-S5/S6、M3-S6 |
| S6 | fieldMask 五出口 | records.ts；recordService；csvExport；queryPlan/compile | on 态六通道无隐藏列、越权写键 403；off 快照不变 | S5 |
| S7 | 中断继承+剪枝+impact | inheritance.ts；impact.ts；M3 tree/menu 读路径 | AC-M4-2 全流程；on 态无权项剔除而 direct 例外 URL 可达 | S5、M3-S5/S6 |
| S8 | openapi 增补 | docs/api/openapi.yaml；形状对拍测试 | 四组新端点+5 错误码全覆盖且与真实响应一致 | S5/S7 |
| S9 | 后端契约片 | shared-types DTO；v1 __tests__；枚举/错误码表 | 三身份快照齐、api/web typecheck 双过，可供前端片派工 | S8 |
| S10 | 对抗/规模/翻转演练 | ac-m4-*.test.ts；造数夹具；RC；m4-gate.md | AC-M4-1/2/3 + 越权矩阵全绿、双零漂移、on/off 演练闭环 | 全部 |
| S11 | 收口 | ADR-0031~0038；runbook；baseline；旧守卫清理裁决 | RC/golden 逐值绿、升级 0 漂移、文档齐备 | S10 |
