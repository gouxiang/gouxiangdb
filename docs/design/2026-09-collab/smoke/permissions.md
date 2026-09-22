# 权限点验报告（真实浏览器走查 · 2026-09-22）

- 执行人：general-purpose-1-2074（权限点验专项）
- 环境：本机 dev（web http://127.0.0.1:5173 / api http://127.0.0.1:3001 ，VITE_COLLAB=1）
- 方法：Playwright(chromium) 真实浏览器逐页枚举全部可见可交互元素并逐一点击（破坏性动作只记录不点击），配合 curl 直打 API 做越权写矩阵；所有结论均有截图/网络记录/DB 查询支撑。
- 中间产物：`/tmp/gxperm/out/`（枚举 JSON、走查 JSON、截图、越权矩阵脚本 10-bypass.mjs）。

---

## ① 覆盖的场景清单

**身份**（均用 `node /tmp/gx-mint.mjs` 签发 localStorage 登录态，非密码登录）：

| 身份 | id | 角色 |
|---|---|---|
| 统一测试 test@gx.dev | cmtxqyk8m0000607oodg2c6uk | role_owner（超级管理员）；目标库 kb_members.role=owner |
| 受限验证账号 restricted-navgov@gx.test | cmu7ymujq0001bky62ss9y9zw | role_viewer（阅读者）；目标库 kb_members.role=viewer；workspace role_assignments=role_viewer |

**路由覆盖**（每个身份各走一遍）：/kb 列表、/kb/:kbId 首页、/kb/:kbId/doc/:docId、/kb/:kbId/canvas/:docId、/kb/:kbId/trash、/kb/:kbId/settings、/workspace/contacts、/workspace/authz、/workspace/settings（通用/语义检索/MCP/回收站分区）、/base/:baseId（网格视图）、/help。

**点击覆盖**：两身份合计逐一点击约 700+ 个可见可交互元素（按钮/菜单项/tab/下拉/弹窗/开关/输入框），每次点击后记录 URL 变化、弹层/toast 文案、新增禁用态、console error、pageerror、≥400 响应。破坏性标签（删除/清空/移除/停用/恢复默认/保存/邀请新成员/新建自定义角色/添加成员）只记录存在与禁用态，不实际触发。

**越权 API 矩阵**（viewer token，全部带 X-GX-Token，见 10-bypass.mjs）：建文档、改文档名、写正文、删文档、移动文档、开外链分享、改库名、库分享总闸、回收站找回、彻底删除、改视图配置、建表、改数据表库、策略自授权（PUT /api/v1/nodes/:id/policies）、库视野自授权（PUT /api/v1/org/library-scopes）、建角色、建记录。共 17 项写 + 2 项敏感读。

**空态/加载态/错误态**：viewer 直输无权库 URL（kb 首页、文档、画布、设置、回收站）、目标库回收站为空、库加载中、列表加载失败（KbListFailure / ErrorState / NoPermissionState）均实际渲染过并截图。

---

## ② 发现的缺陷与修复

### P0-1（未修，需产品拍板）：权限管理面板的配置对库访问完全不生效——配置面与裁决面断裂

- **现象**：用 owner 在 /workspace/authz（权限管理）→ 资源树选「统一测试知识库」→ 角色 tab → 展开「阅读者」→ 勾「查看」→ 点「保存权限」。请求 `PUT /api/v1/nodes/nav_kb_.../policies {"subjectType":"role","subjectId":"role_viewer","actions":["r"]}` 返回 200，auth_policies 新增一行（已查库证实）。但 viewer 直打 `GET /api/kb/cmtxr0jok0001607owi2oydgd` 依旧 **403 无权访问该知识库**，界面依旧「无访问权限」。
- **根因**（文件:行号）：
  - 真实裁决只读 `role_library_scope`：`apps/api/src/domain/authz/libraryPolicy.ts:177-202`（resolve → prisma.roleLibraryScope.findMany），kb 守卫入口 `apps/api/src/routes/kb/shared.ts:69-79`（requireKb → resolveKbAccess）。
  - 权限面板写入 `auth_policies` 并"反向映射"到旧三表 members/kb_members/kb_doc_acls：`apps/api/src/domain/authz/policyAdminTx.ts:63-110`——而这三张表已全部退出裁决（`apps/api/src/routes/kb/shared.ts:4-10`、`apps/api/src/guards.ts:1-7` 注释明示"不再读 Member.role / kb_members 不再是授权入口 / kb_doc_acls 彻底不参与放行"）。
  - 该库在 `role_library_scope` 里只有 role_owner/role_admin 两行种子（`apps/api/src/domain/authz/libraryScopeSeed.ts:18-30`），**除 owner/admin 外任何角色对所有库默认零视野**，viewer 的 kb_members 行和 legacy 投影 auth_policies 行都救不了。
  - 前端也没有任何能编辑 `role_library_scope` 的 UI：hooks 里有查询键 `apps/web/src/api/hooks.ts:48`（roleScopes）但全仓无消费；通讯录 RoleManager.tsx（566 行）与 PermPanel 均不编辑库视野。
- **为什么不能由我单方面修**：把 auth_policies 投影进 role_library_scope（或让 libraryPolicy 兼读 auth_policies）是 M4 引擎翻门（GX_AUTHZ_ENGINE，AUTHZ_ENFORCE_READY=false，apps/api/src/configAuthz.ts:20-23）的架构裁决，牵动双写/reconcile/shadow 对拍全套设施。已按"修根因不修症状"原则登记为体系缺口。**当前管理员在 UI 上做的任何"给角色/人授权访问某库"操作都是静默无效的**，面板还带「以下授权已在企业权限引擎生效」文案，误导性强；建议短期先在 PermPanel 加"引擎未启用、配置暂不影响库访问"的显式横幅。
- **点验期间的处理**：为完成 viewer 走查，我用 **仅 INSERT** 在 role_library_scope 造了两行临时身份行（id 前缀 `rls_tmp_permsmoke_`，role_viewer × 目标 kb/base，visible=1），验完后已删除还原（只动自己插入的行，未 DELETE/UPDATE 任何既有数据）。

### P1-2（已修）：知识库设置页 fail-open——无权用户看到可编辑表单

- **现象**（修复前实测截图 viewer-kb-settings.png）：viewer 直输 `/?kbId/settings`（GET /api/kb/:id 返回 403）后，页面仍渲染完整设置表单：名称输入框可输入、保存按钮可见（仅因名为空而置灰）、图标选择器、前往权限管理按钮。输入名称点保存则**静默无任何反馈**（saveKb 内 `!isOwner` 直接 return）。
- **根因**：`apps/web/src/features/kb/KbSettingsPage.tsx:25` `const myRole = kb?.role ?? "owner"`——kb 加载失败时按 owner 渲染（fail-open），且页面无 403 错误态分支。
- **修复**：加载中渲染 Spinner；查询失败渲染 NoPermissionState（复用 PERM-05 同款组件）；`?? "owner"` 改 `?? "viewer"`（fail-closed）。
- **自验**：viewer 打开无权库 settings → 「无访问权限 / 返回」；打开有权库 → 名称框 disabled:true。owner 打开 → 名称框 disabled:false、面板正常。

### P1-3（已修）：知识库首页行菜单对 viewer 完全不门控

- **现象**（修复前实测，走查记录 viewer kb-home [69]-[98]）：viewer 在 /kb/:kbId 每行「…」菜单里有**重命名 / 独立权限 / 删除**三项，全部可点；重命名弹窗可提交、删除有确认弹层，最终都被后端 403 拒（PATCH→403「当前角色无权编辑」、DELETE→403）。属"该禁用却可点"的假入口。
- **根因**：`apps/web/src/features/kb/KbHomePage.tsx:245-258`——行菜单只有「图标与颜色」有 `canCreate` 门控，重命名/删除/独立权限无条件渲染。
- **修复**：viewer 档位整个行菜单入口（含触发按钮）不渲染，避免空菜单；同口径改 `apps/web/src/features/kb/KbTree.tsx:85-90`、`apps/web/src/features/workspace/SecondaryNavKbOps.tsx:67-69` 的 `kb?.role ?? "owner"` 兜底——改为"加载中 owner（防闪禁用）、加载失败 viewer（fail-closed）"。
- **自验**：viewer 首页「操作菜单」触发按钮数=0、新建文档数=0；owner 行菜单仍为 重命名/图标与颜色/删除（见 verify-owner-rowmenu.png）。

### P1-4（已修）：分享弹窗「外部链接」总闸对 viewer 可点

- **现象**（修复前代码走读+修复后截图对照）：viewer 打开文档「分享」弹窗，内部成员两档已按 canManage 置灰，但**外部链接开关无 disabled**，可点开分享→后端 POST 403→toast 回滚。属"该禁用却可点"。
- **根因**：`apps/web/src/features/kb/ShareModal.tsx` 外链 Switch 未传 disabled；且 `apps/web/src/components/ui.tsx` 的 Switch 组件本身不支持 disabled。
- **修复**：Switch 增加 disabled/disabledReason/title（aria-disabled + 置灰样式）；ShareModal 传入 `disabled={!canManage || setShare.isPending}`。
- **自验**：viewer 分享弹窗开关 disabled:true（verify-viewer-sharemodal.png）；owner 弹窗不受影响。

### P2-5（已修）：知识库回收站对 viewer 渲染「找回/彻底删除」写按钮

- **现象**：viewer（授予库只读后）打开 /kb/:kbId/trash 可见回收站列表，每行带「找回」「彻底删除」按钮，点击后分别 403「当前角色无权编辑」/403「只有知识库所有者可彻底删除」。
- **根因**：`apps/web/src/features/kb/KbTrashPage.tsx` 不读库角色，写按钮无条件渲染（仅靠后端兜底）。
- **修复**：按 `kb.role` 门控——找回=owner/editor 可见，彻底删除=仅 owner 可见。
- **自验**：viewer 回收站两按钮数为 0；owner 空回收站空态正常。

### P2-6（已修）：「独立权限」入口是死开关（点了必 404/配置无效）

- **现象**：owner 打开行菜单「独立权限」→ DocAclModal。本次实测该弹窗打开时先发 `GET /api/kb/docs/:id/acl` → **404 接口不存在**（旧 ACL 路由已删除）；owner 因 authzManage=true 瞬时切到 M4 DocPolicyView，但对持 authzManage=false 的 editor 会永久停在 legacy 分支——查询 404、授予也 404，整个弹窗是坏的。
- **根因**：后端已删 ACL 路由且 kb_doc_acls 退出裁决（`apps/api/src/routes/kb/shared.ts:8-10`），前端入口 `apps/web/src/features/kb/KbHomePage.tsx`（DocAclModal）未同步下线；DocAclModal 依赖 `useNavNodeIndex` 异步解析，解析完成前 legacy 分支必发一次 404 请求。
- **修复**：移除行菜单「独立权限」入口及 DocAclModal 挂载/导入（KbHomePage 内）。M4 DocPolicyView 本体与 /workspace/authz 面板未动——是否恢复"文档级独立授权"应随引擎翻门一并裁决。
- **自验**：owner 行菜单=重命名/图标与颜色/删除；web 全量测试 102 文件 1241 用例全绿。

### P1-7（已修，team-lead 派修）：分享弹窗「内部成员」档位写入不存在的接口，点了必 404

- **现象**：分享弹窗「内部成员」区有「仅可见 / 可编辑」两个档位，点任何一个（无论身份）发 `POST /api/kb/docs/:docId/share/internal` → **404 接口不存在**（Hono 落兜底）。owner 在权限管理里能看到成员列表，很容易把这里的档位当成真实的内部授权开关。
- **代码证据链（只认 import/调用，不认注释）**：
  1. 前端写链：`apps/web/src/api/client.ts` `KbApi.setInternalShare` → `POST /api/kb/docs/:docId/share/internal`（原 911-914 行）→ `apps/web/src/features/kb/kb-hooks.ts` `useSetInternalShare` → `apps/web/src/features/kb/ShareModal.tsx` `applyInternalRole()`（「仅可见/可编辑」两个 RoleOption 的 onClick）。
  2. 后端路由：`apps/api/src/routes/kb/sharing.ts` 只注册 `GET :15` 与 `POST :51` 两条 `/docs/:docId/share`，**无 `/share/internal` 子路由**（`grep -rn "share/internal" apps/api/src` 零命中），PUT /acl 亦已删除。
  3. **kb_doc_acls 是否仍参与放行（决定二选一的关键证据）**：生产码中 `kbDocAcl` 全部引用仅 4 处——`domain/authz/reconcile.ts:108`（legacy→auth_policies 对账脚本，只读）、`domain/authz/policyAdmin.ts:64` 与 `policyAdminTx.ts:90/107`（策略保存时的旧表反写）、`routes/kb/recycle.ts:32`（彻底删时清行）。**读路径零引用**：kb 守卫 `requireDocAccess`（routes/kb/shared.ts:85-108）只走 `resolveKbAccess → prisma.roleLibraryScope.findMany`（domain/authz/libraryPolicy.ts:177-202），从不查 kbDocAcl；base 侧守卫（guards.ts）同理。即：即使把接口补上把数据写进去，对任何放行判定的影响是零——典型「配了不生效」。
- **裁决**：采用第二种（下线界面入口），与 9a96364 取消单篇授权的模型一致；不补接口。
- **修复**：`ShareModal.tsx` 移除内部成员两个档位与 `applyInternalRole`/`useSetInternalShare`，改为一条只读结论（"组织内成员当前可编辑/仅可见本篇内容"，读 GET share 现算的 `internal.membersCanEdit`）+ 指引文案（由知识库角色配置决定）；`apps/web/src/api/client.ts` 删除 `setInternalShare`；`apps/web/src/features/kb/kb-hooks.ts` 删除 `useSetInternalShare`。文件降至 207 行（≤300）。
- **自验**：owner 打开分享弹窗 → 内部成员区为只读文案、无 404 请求（网络面板无非 GET）；viewer（临时授予库只读后）→ 内部成员只读 + 外链开关保持置灰；验后临时行已删（库中 rls_tmp% 计数=0）。`apps/web`: `tsc --noEmit` 0 错、全量 `vitest run` 102 文件 1241 用例全绿、改动文件 eslint 0 error（client.ts 两条既存 unused-import warning 与本次无关）。

---

## ③ 未修的遗留

1. **P0-1 配置面/裁决面断裂**（见上）：需要产品+架构拍板翻门路径或做 UI 投影，属 M4 既有里程碑范畴，不在本次最小修复内。
2. **非 owner/admin 角色对全部库默认零视野**：role_library_scope 种子只有 role_owner/role_admin（libraryScopeSeed.ts），creator/editor/commenter/viewer/restricted 新建后同样默认谁也进不去。这是"谁能进库由角色的库视野决定"设计下的既定行为，但**当前没有任何 UI 能配库视野**（见 P0-1 第 4 点），两者叠加=生产环境除 owner/admin 外无人可用库。需要产品确认是否补"角色库视野"配置 UI。
3. **网格视图挂载即发一次视图配置写**：以 viewer 点 Logo/切库进入网格视图时，页面自动发出 `PATCH /api/views/cmtxuttr1001q607o79pmm5ti`（body 为完整 view.config），被 403「该视图已锁定，当前角色无权修改」拒绝并弹 toast——用户未做任何操作即见报错。owner 下同样发出但静默成功（每次进视图都整包重写 config）。已用 CDP+fetch 栈确认走 `ViewShell.onUpdateConfig → useGXMutations.updateView`（apps/web/src/features/views/ViewShell.tsx:81-92），但**具体哪个子组件在挂载期无条件调了一次 onUpdateConfig 未能定位**（全量 grep 了 grid/views/shell 下 11 个调用点，均为用户动作触发；react-query 异步边界截断了调用栈）。建议后续用 devtools 断点或给 onUpdateConfig 加 dev 日志定位后修复（挂载期不应有写）。
4. **viewer 可见「工作区设置」入口并可进通用/语义检索/MCP 分区**：canSeeWorkspaceSettings（apps/web/src/features/workspace/lib/nav-gate.ts:81-83）把 view_directory 计入 CONTACTS_ACTIONS，导致仅持 view_directory 的阅读者也通过该兜底判定；实测 viewer 能进工作区设置看到通用（上传限制，纯 localStorage 不越权）、语义检索、MCP 分区（ownerOnly 的权限管理分区正确隐藏、/workspace/authz 直访有整页无权态）。与注释意图（"一枚都没有的成员不该进工作区配置页"）不符，建议把 view_directory 从该兜底口径剔除或单列。
5. **kb_doc_acls 死数据**：库里 kb_doc_acls 为空、ACL API 已删，但 shared-types / DocAclModal.tsx / DocPolicyView 文案仍提"同步到原文档独立权限"，建议随引擎翻门一并清理文案与死表。
6. **越权读轻微暴露**：viewer 可 GET /api/kb/:kbId/members（库视野角色覆盖与人数）、GET /api/kb/:kbId/trash（已删文档标题列表）。均为同库成员语义下的低敏信息，是否收紧交产品定。

## 自验记录

- `apps/web`: `npx tsc --noEmit` 0 错；`npx vitest run` 102 文件 / 1241 用例全绿（含 PERM-S5 后复跑）；改动文件 eslint 0 error（client.ts 两条既存 unused-import warning 与本次无关）。
- `apps/api`: `npx tsc --noEmit` 0 错（本次未改 api 生产码）。
- 数据库：仅 INSERT 过 2 行 `rls_tmp_permsmoke_*`（role_library_scope）用于 viewer 走查，验后已删；另经产品 UI（PermPanel）产生过 1 行 auth_policies（role_viewer×nav_kb，reason=policy:v1）——这是真实管理员操作路径的产物，保留未删，如需回滚可在权限管理面板取消勾选后保存。
- 未执行任何 git commit / stash / checkout / reset。
