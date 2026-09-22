# 权限管理面板「真正接通」交付报告（2026-09-22）

- 执行人：mvp-dev-expert-team-backend-1-0c59
- 环境：本机 dev（web `http://127.0.0.1:5173` / api `http://127.0.0.1:3001`），后端由 tsx 直跑源码，**已按改动重启**（重启命令见 §6）
- 基线代码：`ad1b0e8`（工作区另有协同/分享的在途未提交改动，未触碰）
- 结论：**面板写入链路已通，且写进去的东西真的会在裁决链上生效**（库级可见/可管理、表级增删改查、字段级隐藏与只读）。同时补齐了三处"配了不生效/配不了生效"的断点。

---

## 1. 先把现状钉死（动手前的实测，纠正任务书里的两条过期前提）

任务书给的两条前提今天已经不成立，先说清楚，免得后面误判：

| 任务书前提 | 实测结论 | 证据 |
|---|---|---|
| 权限面板是 `apps/web/src/features/contacts/RoleManager.tsx` / `DeptTree.tsx`，接口在 `/api/v1/org/library-scopes` 一带 | 面板已重建，在 **`apps/web/src/features/settings/role-permission/`**（`RolePermissionSection.tsx` → `LibraryScopePanel.tsx` + `LibraryScopeModal.tsx`），入口 `/workspace/settings/authz`。`contacts/` 下那两个文件是**通讯录侧**的角色/部门台账，与库权限配置无关 | 提交 `668952d`/`0480c12`（2026-09-21 13:51/14:03） |
| `role_library_scope` 在 dev.db 里是空表 | **202 行**（role_owner × base 50 + kb 51、role_admin × base 50 + kb 51），迁移 `20260921020000_role_library_scope` 的回填段（§④）已执行 | `select count(*) from role_library_scope` → 202；样本行 `rls_seed_base_<id>_role_owner`，`canManage=1 visible=1` |
| 「库权限」下拉为空 / 「获取字段」弹"请先选择数据表" / 「保存配置」400 | 现版本**均不复现**：面板是两份勾选清单（不是下拉），`useBases()`+`useKbList()` 各返回 7 个库/13 个知识库；`PUT /api/v1/org/library-scopes` 实测 **200** 并落库 | §5 真机验证 ①② |

### 真实裁决链（唯一出口）

```
requireCanView / requireCanEditData …（apps/api/src/guards.ts）
        └── resolveBaseAccess / resolveKbAccess（domain/authz/libraryPolicy.ts）  ← 唯一裁决函数
                ├── role_library_scope（角色 × 库 × 表 × 字段）  ← 面板唯一写入目标
                ├── 超级管理员硬短路全权（不落库）
                └── 管理员：visible 恒真，canManage 仍认配置行
```

- `members.role` / `kb_members.role` / `kb_doc_acls` **不参与放行**（`guards.ts` 头注、`kb/shared.ts` 头注），只作导航投影台账——本次未把它们接回放行链。
- `GX_AUTHZ_ENGINE`（M4 auth_policies 引擎）当前 `configured=off effective=off`（`/tmp/gx-api.log` 启动行），`AUTHZ_ENFORCE_READY=false`（`src/configAuthz.ts:17`）。**库/表/字段三级的裁决完全不经过该引擎**，因此"引擎没开"不是本次接通的先决条件。

### 真正断掉的四处（都在配置面与裁决面之间）

| # | 断点 | 症状 | 性质 |
|---|---|---|---|
| A | **字段权限的读侧没有任何一处读 `role_library_scope.config.fields`**。写侧早有 `libraryPolicy.fieldWriteGate`，读侧只有 M4 的 `maskSession`，而后者读的是 `auth_policies`（引擎 off ⇒ 恒不生效） | 管理员把字段配成「隐藏」，列表/详情/搜索照样把值和字段名吐出来 | 配了不生效（死开关） |
| B | **批量写通道没有挂字段闸**：`/api/records/bulk-update` 与 `/api/records/csv-import` 直接调 `applyFieldWrites`，只有单条 create/patch 传了 `fieldGate` | 「仅可见/隐藏」字段可以被批量改、被 CSV 覆盖写 | 配了不生效（侧门） |
| C | **领域层抛的 4xx 被吞成 500**：`libraryPolicy.fieldWriteGate` 与 `libraryScopeConfig.parseScopeInput` 用 `Object.assign(new Error(msg), { status })`，而统一错误出口只认 `instanceof HttpError` | 用户改「仅可见」字段 → `500 服务器内部错误`（消息还漏出来了）。明明是拒绝却报成故障，排查方向全错 | 错误归类错误 |
| D | **写入不校验库是否存在**：PUT 整体替换会原样接受任意 `libraryId` | 可写进指向不存在库的脏授权行（界面上显示成"（这个库你现在看不到）"）；`kind` 与 `id` 错配也能写进去（例如把知识库 id 配成 `base`） | 脏数据 / 无效配置 |

---

## 2. 改了哪些文件

生产码（6 个文件，净 +/‑）：

| 文件 | 改动 |
|---|---|
| `apps/api/src/httpError.ts` | **新增**（30 行）。把 `HttpError` 与 `errorCodeForStatus` 从 `guards.ts` 抽成零依赖模块，使 `domain/**` 也能抛标准 4xx 而不必 import 带 Hono 的 `guards.ts`（也避免 guards ⇄ domain/authz 依赖成环）。 |
| `apps/api/src/guards.ts` | 改为 `import { HttpError, errorCodeForStatus } from "./httpError.js"` 并 `export { HttpError }`，删掉本地定义。**文件从 298 → 280 行**（原本已贴 300 行门禁，这次顺手压回去，未改任何行为）。 |
| `apps/api/src/domain/authz/fieldScope.ts` | **新增**（86 行）。字段权限读侧的纯函数：`fieldScopeOf` / `stripHiddenKeys` / `stripHiddenFromRecords`。**零变化契约**：该表一条 `hidden` 都没配时 `active=false` 且返回入参同一引用，调用方走原路径，响应逐字节不变。 |
| `apps/api/src/routes/records.ts` | 列表 / 详情 / 搜索 / 回收站四个读出口接 `fieldScopeOf`；列表额外用 `sanitizeViewConfigForMask`（复用 M4-S6 同一实现）抹掉视图配置里对隐藏字段的分组/聚合/排序/筛选引用；`recordTitle` 增加可选 `hidden` 参数（跳过隐藏字段再取第一个非空值）；`bulk-update` 与 `csv-import` 补挂 `fieldWriteGate`。 |
| `apps/api/src/domain/authz/libraryPolicy.ts` | `fieldWriteGate` 改抛 `HttpError(403, …)`（见断点 C）。 |
| `apps/api/src/domain/authz/libraryScopeConfig.ts` | `parseScopeInput` 改抛 `HttpError(400, …)`。 |
| `apps/api/src/routes/v1/org/roleLibraryScopes.ts` | PUT 增加 `assertLibrariesExist`：按 `kind` 分别批量校验库存在性（base 与 kb 各自表），缺失/错配一律 **400 且发生在写事务之前**（不会因为一次手滑清空该角色既有授权）。 |

测试（3 个文件）：

| 文件 | 说明 |
|---|---|
| `apps/api/src/routes/v1/org/__tests__/library-scopes-wiring.test.ts` | **新增**（184 行）。真迁移临时库 + 真 `createApp` + 真 JWT，只用 HTTP 走完整条链：未配置=看不见 → 配「可见」=立刻看得见 → 整份替换清空=立刻失去 → 脏库 id=400 且不清空既有授权 → 超级管理员始终全权 → 字段 hidden 读侧缺席且单条/批量都写不进。 |
| `apps/api/src/domain/authz/__tests__/fieldScope.test.ts` | **新增**（65 行）。纯函数层；重点钉「没配 hidden 时零变化」这条热路径契约。 |
| `apps/api/src/domain/authz/__tests__/characterization/legacy-decision-matrix.test.ts` | **修 4 行**（见下）。 |

> **关于这 4 行**：该文件里的「匿名编辑已关闭 → 403」用例在 **HEAD 上就是红的**——它发的 body 只有 `{content}`，而 `7195f23`（乐观锁）之后 `PUT /s/:token/doc/:docId/content` 的 zod 要求带 `baseUpdatedAt`，于是先被判 400，根本走不到 403 分支。已核对：路由与测试两个文件在 HEAD 下内容就是这么写的（`git show HEAD:…` 逐字确认），与本次改动无关。修法是**只补 `baseUpdatedAt`**，不动任何断言：补上之后该用例恢复测到真东西（两档分享一律 403「只读」、正文与 updatedBy 未变、零授权查询）。属陈旧测试对齐新契约，不是放松断言。

---

## 3. 存量数据怎么补

**已经补过了，本次没有再动数据。** 归档如下以免后续重复排查：

- 机制：迁移 `20260921020000_role_library_scope` 的 §④ 回填段 —— 对 `bases ∪ knowledge_bases` 与 `{role_owner, role_admin}` 做 `CROSS JOIN`，`WHERE NOT EXISTS` 幂等插入 `canManage=1, visible=1` 的台账行。
- 现状：dev.db 中 202 行（= (50 base + 51 kb) × 2 角色），**完全覆盖**。
- 建库时增量：`domain/authz/libraryScopeSeed.ts` 的 `seedAdminScopeTx` 在建库/建知识库的同事务里 upsert 这两行（`upsert + update: {}`，不覆盖管理员后来手工勾的值）。
- 为什么这两行是必须的：超级管理员的"全权"是 `libraryPolicy` 里的硬编码短路，**行只是台账**；但**管理员的 `canManage` 只认表里的行**——缺行就会出现"管理员进得去所有库、却连一张表都加不上"。

> 迁移注释里有一句需要更正的事实性偏差（不影响行为，供后人对账）：§③ 写"超管/管理员的全量视野硬编码推导，不需要行"，而 §④ 又为每个存量库补两行，中间用"④是唯一例外"圆回来。实际语义没问题，但 §③ 的措辞容易被读成"这两行可省"。

---

## 4. 行为变化清单（**产品需要提前知晓**）

开关一开（准确说：不是开关，是本轮修复落地），以下可见性会**立刻**改变：

1. **只有"受限成员"角色、或零角色的成员，之前能看到的东西不变——他们本来就什么都看不到（`libraryPolicy` 对无命中返回 `source:"none"`）。** 本轮没有放松这一档。
2. **修复前配了库权限但一直"不生效"的角色，现在开始真的生效。** dev.db 里这类行**只有 0 条**（非 owner/admin 的 role_library_scope 行在本次验证前为空），所以存量环境**没有人的可见性会因此突然收窄**。
3. **新增：持有非超管/非管理员角色、且被配了「可见」的成员，现在能真的进库了**（这正是产品要的"配了生效"）。
4. **新增：字段被配成「隐藏」后，读接口会让它整体缺席**——列表 `fields`/`allFields` 里没有它、记录里没有该键、`/api/records/search` 不再按它的内容命中、回收站不再用它当记录名。**这会让前端"字段选择器"里少一列**，是预期行为而非 bug。
5. **新增：字段被配成「仅可见」或「隐藏」时，写入一律 403**（原来单条就是 403，但错误码是 500；批量与 CSV 原来**能写进去**，现在不能）。如果有任何自动化脚本依赖"批量改只读字段成功"，会开始收到 403。
6. **新增：PUT 库视野不再接受不存在的库 id**。如果某个脚本/历史 UI 曾经写入过脏行，会开始收到 `400 库不存在：<kind>:<id>`——**这是有意的**，且校验在写事务前，不会连带清空该角色的其它授权。
7. **超级管理员与管理员不受任何影响**：超管恒全权（已实测进统一测试知识库 200、bases 7/7），管理员仍进得去所有库、`canManage` 仍认配置。

> **本次验证在 dev.db 留下的样例数据**（供复现，不是产品行为）：
> - `role_library_scope` 一行：`role_restricted` × base `cmu6fz36b00rb8ab1dt0qbsex`（冒烟基地），`visible=1 / canManage=0`，config = 数据表1 只读 + `数量`=仅可见 + `备注`=隐藏；
> - 冒烟基地 / 数据表 1 里一条记录 `cmubw9fmh00022mb1za39qqgn`（名称"被受限用户改过的名字"，备注"这是一条隐藏字段的密文"）。
> 不受限的成员影响面：`role_restricted` 被 61 条授予挂着，因此**这 61 个账号现在能看到「冒烟基地」且只读**。若不想留，执行
> `DELETE FROM role_library_scope WHERE roleId='role_restricted';`（或在面板上取消勾选后保存）。

---

## 5. 真机验证（浏览器 + 直打 API，不是单测）

身份（均用 `node /tmp/gx-mint.mjs <email>` 签发 localStorage 登录态，非密码登录）：

| 身份 | id | 角色 |
|---|---|---|
| 统一测试 `test@gx.dev` | `cmtxqyk8m0000607oodg2c6uk` | 超级管理员（role_owner） |
| `s7direct@example.com`（直建小李） | `cmu146edz000nvkzql7whv8lt` | **只**持受限成员（role_restricted，零组织动作），作为"权限最小"的受验账号 |

### ① 授权：配「可见」→ 立刻看得见

- 操作：超管 → `/workspace/settings/authz` → 选中「受限成员」→ 在「可见库」勾选「统一测试知识库」→ 保存库权限。
- 结果：`PUT /api/v1/org/library-scopes` **200**，`role_library_scope` 新增 `kb / cmtxr0jok0001607owi2oydgd / visible=1`。
- 受验账号：`GET /api/kb` 由 `[]` 变为恰含该库；直开该库 `GET /api/kb/<id>` **200**；`GET /api/kb/<另一个未授库>` **403**。
- 浏览器：左侧导航出现且只出现「统一测试知识库」，能打开，只读态（无新建/删除等写入口）。
  证据：`screens/authz-wiring-01-restricted-sees-granted-kb.png`、`authz-wiring-02-restricted-opens-kb-readonly.png`

### ② 反向：取消配置 → 立刻失去

- 操作：同一个勾选框取消 → 保存（`PUT` 200，行被删除）。
- 受验账号立刻：`GET /api/kb` **`[]`**；直开该库 `GET /api/kb/<id>` **403**；`GET /api/kb/<id>/docs` **403**。
- 说明"取消勾选删得掉"——这正是 PUT 采用**整体替换**而非逐条 PATCH 的语义。

### ③ 表级：只读就不给写

- 配置：`role_restricted` × 冒烟基地，数据表1 → `read:true, create:true, update:true, delete:false`。
- 受验账号：`POST /api/records?tableId=<未配表>` → **403 当前角色无权编辑数据**；`PATCH /api/records/<id>` 改普通字段 → **200**。

### ④ 字段级：隐藏读不到、只读写不了

- 配置：数据表 1 的 `备注` = 隐藏，`数量` = 仅可见。
- 读侧（受验账号）：`GET /api/records?tableId=…` 的 `fields` / `allFields` 都是 `名称,数量,状态,日期`（**无 `备注`**），记录键里也没有 `备注`；`GET /api/records/<id>` 同；`GET /api/records/search?q=密文`（该词只在 `备注` 里）→ **`{"results":[]}`**。
- 读侧（超管）：同一接口 `fields` = `名称,数量,状态,日期,备注`，详情里 `备注=这是一条隐藏字段的密文`，搜索能命中。→ 证明是"只减不增"，不是把功能关掉。
  证据：`screens/authz-wiring-05-restricted-hidden-field-absent.png`（受验账号：四列）、`authz-wiring-04-owner-sees-all-fields.png`（超管：五列）
- 写侧（受验账号）：`PATCH` 改 `数量` → **403 字段「数量」为仅可见或已隐藏，不可编辑**；`PATCH` 改 `备注` → **403 字段「备注」…**；`POST /api/records/bulk-update` 写 `数量` → **403**；`POST /api/records/csv-import` 用列名 `备注` 命中隐藏字段 → **403**。

### ⑤ 面板回显：配的东西存得住、读得回

- 重进 `/workspace/settings/authz` → 「受限成员」：`冒烟基地` 在「可见库」里是勾选态；点「设置」→ 逐字段档位回显为
  `名称=可编辑 / 数量=仅可见 / 状态=可编辑 / 日期=可编辑 / 备注=隐藏`，与库里存的 JSON 逐项一致。
  证据：`screens/authz-wiring-03-panel-field-config-roundtrip.png`
- 「通讯录权限」保存链路同样实测通过（`PATCH /api/v1/org/roles/role_restricted` 200），**验证后已把 `view_directory` 还原为空**，不留副作用。

### ⑥ 防锁死：超级管理员自始至终进得去

- `GET /api/kb/cmtxr0jok0001607owi2oydgd` **200**、`GET /api/kb/<id>/docs` **200**、`GET /api/bases` **7/7**。
- 上述所有配置变更前后各测一次，结论不变。

### ⑦ 脏数据校验

- `PUT` 指向不存在的库 → **400 `库不存在：base:nope-does-not-exist`**；
- `PUT` 把知识库 id 配成 `base` → **400 `库不存在：base:cmtxr0jok0001607owi2oydgd`**；
- 两次失败后复查该角色既有授权**原样保留**（校验在写事务之前）。
- `items` 里缺 `libraryId` → **400 `缺少 libraryId`**（断点 C 修好后，不再是 500）。

---

## 6. 自验命令与结果

```
# 后端（约 70s，须在无重负载时跑）
cd apps/api && npx vitest run src/domain/authz src/domain/org src/routes src/routes/v1 src/__tests__
  → Test Files 100 passed | 2 skipped (102)
    Tests      837 passed | 11 skipped (848)     exit=0

cd apps/api && npx tsc --noEmit          → 干净
cd apps/web  && npx tsc --noEmit         → 干净
npx eslint <本次改动的 6 个文件>          → 干净（exit 0）

# 行数门禁
fieldScope.ts 86 / roleLibraryScopes.ts 152 / libraryPolicy.ts 299 / libraryScopeConfig.ts 103
httpError.ts 30 / guards.ts 280（298→280） / 新测试 184、65
```

**重启命令**（tsx 直跑源码，无 watch，必须重启才生效）：

```
cd apps/api && pkill -f "tsx/dist/cli.mjs src/index.ts"
nohup /Users/daijing/.workbuddy/binaries/node/versions/22.22.2-3/bin/node \
  /Users/daijing/Desktop/GouXiangDB/node_modules/tsx/dist/cli.mjs src/index.ts >> /tmp/gx-api.log 2>&1 &
```

### 关于两个"看起来红了"的失败（第三次跑已全绿，说明是负载抖动）

全量套件在本机跑过 3 次：第 1 次红 1 个（`legacy-decision-matrix`，见 §2）、第 2/3 次红的是**别的**文件，且**每次都是 `Test timed out in 5000ms`**（`s8-upgrade-drill` 要连跑两次 `prisma migrate deploy`，实测量级 1.2–1.4s；`departments` / `m5-search-gate` 同理）。单独跑这些文件**全绿**。本机同时有 8 个以上 agent 在并行跑测试，5s 默认预算被打穿，属既有抖动（另有人在专治这个，见任务 #345/#347），**与本次改动无关**：最终一次干净重跑 837 passed / 0 failed。

---

## 7. 遗留与需要拍板的事（没有自行绕过）

### 7.1【需产品/总监拍板】**站内有两套"权限管理"，其中一套是死面板**

- `/workspace/authz` → `features/authz/PermPanel.tsx`（M4 资源树 + 策略矩阵 + 字段三态）。它写 `auth_policies`（`domain/authz/policyAdminTx.ts`），而 `auth_policies` 只在 `GX_AUTHZ_ENGINE=on` 时参与裁决，当前 `effective=off`、`AUTHZ_ENFORCE_READY=false`。**在这上面做的授权一律不影响任何库的访问**，页面上也没有任何"暂未生效"的提示。
- `/workspace/settings/authz` → `features/settings/role-permission/*`（本轮接通的就是它，写 `role_library_scope`，真生效）。
- 这不是我能单方面决定的：让 `auth_policies` 参与放行 = 翻 `AUTHZ_ENFORCE_READY` = 项目总监级裁决（`configAuthz.ts:13-20` 明写 S10 且 §4.8 五条件满足后才由总监下令），且会同时打开 `shadow` 对拍/双写/reconcile 一整套设施。**按"发现先决条件就停下回报"的要求，我停在这里。**
- 建议（任一，均不动裁决链）：① 给 `PermPanel` 加显式只读横幅（"资源树策略尚未接入库访问裁决，请到 工作区设置 → 权限管理 配置"）；② 直接下线 `/workspace/authz` 入口，等 M4 翻门再上。同一问题另有 `docs/design/2026-09-collab/smoke/permissions.md` 的 P0-1 记录（general-purpose-1-2074），本条不重复其取证，只补"新面板已真生效"的对照事实。

### 7.2 四枚资源锚点角色在面板里不可见 → 持有者无法被授权

`creator / editor / commenter / viewer`（`role_owner` 之外的四枚 M4 资源锚点）被 `RoleListPanel.isVisibleRole` 过滤掉，**不会出现在权限面板**；而它们在数据层是可以被授予的（`role_assignments` 允许任意 roleId，dev.db 里 `restricted-navgov@gx.test` 就只挂着 `role_viewer`）。
结果：**任何只持这四枚角色之一的账号，永远看不到任何库，管理员也无处给他配库权限**（面板里没有这个角色）。
现状之所以没爆：通讯录里的角色列表同样过滤掉这四枚，UI 上授不出去（只有脚本/API 能造出这种账号）。需要产品决定二选一——面板里展示并允许配置它们，或明确禁止把锚点角色授予成员。

### 7.3 用户首页文案与库可见性不一致（体验，非权限）

只被授权了**知识库**、没有被授权任何**数据库**的账号，进 `/` 会看到"还没有任何库 / 请联系管理员为你开通"，尽管左侧导航里躺着可用知识库（`RootRedirect` 只看 `useBases()`）。受验账号实测截图 `screens/authz-wiring-01-…png` 即为此态。建议 `RootRedirect` 在 bases 为空但 kb 非空时跳 `/kb`（属前端改动，未越界动）。

### 7.4 `apps/api/src/routes/records.ts` 已 1027 行（既有超标）

单文件远超 300 行门禁，是长期存量（本次净增约 26 行）。本次把新增逻辑全部放进独立模块 `fieldScope.ts`，未继续往这个文件堆；但彻底达标需要按资源拆分（读出口 / 写出口 / 回收站 / 导入），属独立重构，未在本轮动。

### 7.5 `role_library_scope` 的 `createdAt/updatedAt` 两种格式并存

迁移回填行是 `CURRENT_TIMESTAMP` 字符串（`2026-09-21 10:28:32`），Prisma 写入行是毫秒整数（`1790033807588`）。Prisma 两边都能解析（实测 GET/DTO 正常），但混格式不利于以后做时间范围查询/排序核对，建议后续迁移统一。

---

## 8. 交付物索引

- 新增生产码：`apps/api/src/httpError.ts`、`apps/api/src/domain/authz/fieldScope.ts`
- 修改生产码：`guards.ts`、`domain/authz/libraryPolicy.ts`、`domain/authz/libraryScopeConfig.ts`、`routes/records.ts`、`routes/v1/org/roleLibraryScopes.ts`
- 新增测试：`routes/v1/org/__tests__/library-scopes-wiring.test.ts`、`domain/authz/__tests__/fieldScope.test.ts`
- 修改测试：`domain/authz/__tests__/characterization/legacy-decision-matrix.test.ts`（4 行，陈旧契约对齐）
- 截图：`screens/authz-wiring-01..05-*.png`
- 未提交：按要求**未做任何 git commit / stash / checkout / reset**
