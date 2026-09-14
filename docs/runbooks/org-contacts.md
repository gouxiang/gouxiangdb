# M2 组织通讯录运维：紧急收回、停用排查、工作区/Owner 修复、邀请重发、回滚姿态

M2 企业组织管理面（`/api/v1/org/*` + 公开邀请接受 `/api/v1/auth/invite/accept`）的可执行
运维流程。架构背景见 [ADR-0022](../adr/0022-org-token-version-revocation.md)（tokenVersion
即时吊销）、[ADR-0023](../adr/0023-materialized-path-dept-tree.md)（部门物化路径）、
[ADR-0024](../adr/0024-org-role-vs-resource-role-layering.md)（两层角色隔离）。

> 命令默认在 api 应用目录（发布物的 `apps/api` 或等价 current 目录）执行；生产
> `DATABASE_URL` 由 `/etc/gouxiangdb/env.conf` 注入。改库前先按 [backup.md](backup.md)
> 做一次在线备份。M2 为单实例部署（ADR-0003）。

## 1. 功能 flag 与紧急收回通讯录面

| flag | 默认 | 取值 | 作用 |
|---|---|---|---|
| `GX_ENTERPRISE_ORG` | **on** | on（默认，含 test）/ **off** | on 挂载 `/api/v1` 组织路由与 `/api/v1/auth/invite/*`；off 不挂载，请求落入 404 |
| `GX_AUTH_STATE_TTL_MS` | **0** | 非负整数毫秒 | 鉴权状态进程内缓存 TTL；0=完全旁路、每请求查库；>0 时停用仍会同进程主动失效 |

### 1.1 紧急收回（flag off）能收回什么、不能收回什么

设置 `GX_ENTERPRISE_ORG=off` 并重启（systemd 改 env.conf 后 `systemctl restart gouxiangdb`）：

- **能收回**：整个组织管理面 HTTP 入口——`/api/v1/meta`、`/api/v1/org/departments`、
  `/api/v1/org/members`、`/api/v1/org/roles` 及邀请接受
  `/api/v1/auth/invite/accept` 全部返回 404（`{error,code:"NOT_FOUND"}`）。这等于把通讯录
  功能对用户整体下线，旧 `/api/*` 数据面（base/记录/知识库）完全不受影响、继续可用。
- **不能收回（需要明确）**：flag off **不关闭**账号状态/tokenVersion 校验。旧 `/api` 的
  `getUserId` 与 v1 共用同一鉴权核心 `resolveActiveAuth`，它**不在** flag 条件块内。因此
  停用账号、tv 不符、INVITED 账号在 flag off 下依旧被旧数据面拒绝（401）。flag 是「摘路由」，
  不是「退回 M2 前的仅验签行为」。若要让某个被停用账号重新能访问旧数据面，正路是重新激活
  （见第 2 节），而不是关 flag。
- 组织表（workspaces/departments/dept_members/roles/role_assignments）与 users 新列在
  flag off 时只是闲置，数据不删、不丢；重新置 on 即恢复。

验收（flag off 重启后）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/api/health            # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/api/v1/org/departments # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3001/api/v1/auth/invite/accept \
  -H 'Content-Type: application/json' -d '{}'                                         # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3001/api/auth/login \
  -H 'Content-Type: application/json' -d '{"email":"...","password":"..."}'           # 200（旧数据面在）
```

## 2. 「停用后用户仍能访问」排查

预期：管理员停用后，该用户**下一次请求**即被 401（其旧 JWT 的 `tv` 与已 +1 的
`tokenVersion` 不符）。若反馈仍能访问，按序排查：

1. **确认确实停用且 bump 了版本**：
   ```sql
   SELECT id,email,status,"tokenVersion","disabledAt" FROM users WHERE email='?';
   -- status 应为 DISABLED，disabledAt 非空，tokenVersion 较停用前 +1
   ```
   若 status 还是 ACTIVE，说明停用请求没成功（最后 owner 保护会 409，见第 4 节）。
2. **看该请求打到哪个面、带的哪个 token**：旧 `/api` 与 `/api/v1` 都经 resolveActiveAuth，
   停用后两面都应 401。解码 JWT payload 的 `tv`，应小于库里当前 tokenVersion。
3. **是否开了鉴权缓存（`GX_AUTH_STATE_TTL_MS>0`）且是多实例**：默认 0 时每请求查库、无窗口。
   同进程内停用会主动 invalidate，仍即时；但**多实例**下 A 实例的停用无法主动清 B 实例的
   短缓存，B 最长在 TTL 窗口后才生效。处置：把该实例 TTL 临时设 0 并重启，或等待 TTL 到期。
   M2 是单实例交付，多实例属未支持形态（ADR-0022 §4、ADR-0008）。
4. **是否用的是另一类凭据**：个人访问令牌（PAT，M6）/MCP 凭据是独立凭据，不受
   tokenVersion 影响；停用用户不等于吊销 PAT（M6 起需另行吊销）。匿名公开外链
   `/api/public/s/:token` 本就不绑定用户，停用创建者不影响外链，这是设计而非缺陷。
5. **重新激活后旧 token 仍 401 是正常的**：reactivate 会再 bump 一次 tokenVersion，强制
   重登；用密码重新登录拿到新 tv 的 JWT 才恢复，且停用期间保留的部门归属/角色授予仍在。

## 3. 默认工作区与 Owner 自举修复

- 单工作区固定 id `ws_default`，由组织 DDL 迁移幂等播种（`workspaces` 恰一行）。
- owner 自举发生在两处，都是幂等的：① 存量库升级的 backfill 迁移（给 createdAt 最早的用户
  补恰好一行 `role_owner` user 授予，`createdBy=system-bootstrap`）；② flag on 时空库首个
  用户 signup（工作区用户数=1 且无任何 user 级 owner 授予时，`createdBy=system-signup-bootstrap`）。
- **手工修复缺失 owner**（如误删了全部 owner 授予导致无人能管通讯录）：先确保有至少一个
  ACTIVE 用户，再直接补一行授予（走应用写队列的脚本或在维护窗口用 SQL；补后核对仅一枚）：
  ```sql
  -- 先盘点在岗 owner（含部门继承需在应用侧 usersWithRole 展开；此处只查直接授予）
  SELECT ra."subjectId", u.status FROM role_assignments ra
    JOIN users u ON u.id=ra."subjectId"
    WHERE ra."roleId"='role_owner' AND ra."subjectType"='user';
  -- 维护窗口补直接 owner（把 <uid> 换成目标 ACTIVE 用户）
  INSERT INTO role_assignments(id,"roleId","subjectType","subjectId","scopeType","createdBy")
    VALUES ('ra_manual_fix','role_owner','user','<uid>','workspace','manual-runbook')
    ON CONFLICT DO NOTHING;
  ```
  > 注意「最后 owner」保护按**在岗 owner 并集**计算：直接授予 + 授给部门后经子树展开的
  > ACTIVE 成员（见 ADR-0024 的 usersWithRole）。停用判定 409 时，先查是否还有部门继承
  > 的 owner，再决定先移交还是先停用。
- **修复工作区归属**：存量用户回填后 `workspaceId` 应全为 `ws_default`；异常空值可重放
  backfill 的幂等 UPDATE（`UPDATE users SET "workspaceId"='ws_default' WHERE "workspaceId" IS NULL`），
  重放不产生重复 owner。

## 4. 停用被拒（400/409）的含义

- 自停用返回 400：不能停用自己；用另一个 owner/管理员操作。
- 最后在岗 owner 返回 409：先把 owner 授予转给另一名 ACTIVE 成员（直接授予或部门授予），
  或先提升第二名 owner，再停用。系统按直接 + 部门子树展开计数，INVITED/DISABLED 不计在岗。
- 无 `manage_members` 动作返回 403：操作人有效角色里没有持该动作的角色（组织角色与资源
  Base owner 无关，见 ADR-0024）。

## 5. 邀请与「重发激活链接」

M2 **没有**独立的「重发邀请」端点，一次性激活码是 32 字节随机串，库里只存其 SHA-256
（`inviteTokenHash`），明文仅在邀请接口响应里返回一次，无法事后取回。需要让用户重新获得
激活入口时，二选一：

1. **重新邀请（推荐，前提是该邮箱账号还停在 INVITED 且可删除）**：先由管理员移除该 INVITED
   用户（M2 未提供专门的「删除邀请」业务端点；可在维护窗口删除该未激活用户行以释放邮箱），
   再调 `POST /api/v1/org/members/invite` 生成一枚新激活码，把新链接发给对方。旧激活码随
   哈希被删而失效。
2. **管理员直接建可登录账号**：`POST /api/v1/org/members`
   `{email,displayName,password}` 直接建 ACTIVE 账号，把初始密码线下交付，对方首次登录后
   自行改密（`POST /api/auth/me/change-password`）。适合不需要「邮件激活」仪式的场景。

已激活用户忘记密码走既有的账号/口令流程；邀请接受端点对已用过的码返回 404（防账号枚举，
不区分「码无效/已用过/账号不存在」）。

## 6. 组织数据的回滚姿态（只增不删，快照为主）

M2 两个迁移是**只增**：新建 workspaces/departments/dept_members/roles/role_assignments
五表，users 仅 ADD COLUMN（status/workspaceId/tokenVersion/disabledAt/inviteTokenHash/
invitedAt），不删表不删列、不改列类型。因此：

- **首选回滚 = 恢复升级前的数据库快照**（见 [restore.md](restore.md)），再部署旧版本二进制。
  这是唯一能把组织表/新列整体「撤回」的干净方式，演练目标恢复时长 <=30 分钟。
- **前滚/降级共存**：旧版本代码不认识新表新列，直接跑也不会去删它们；`GX_ENTERPRISE_ORG=off`
  可在保留数据的前提下把功能面下线，users 新列对旧逻辑闲置（status 默认 ACTIVE、tv 默认 0，
  旧 token 平滑可用）。
- **不要手工 DROP 组织表或新列**：departments 自引用外键是 `ON DELETE RESTRICT`，且无下迁
  迁移脚本；确需清理请在备份后按「先 dept_members/role_assignments，再 departments/roles，
  最后 workspaces」的顺序并关闭 foreign_keys，属高风险操作，默认不做。
- 迁移可重入：`prisma migrate deploy` 重复执行幂等（已应用跳过），backfill 重放不重复自举 owner。

## 7. flag 生命周期

- `GX_ENTERPRISE_ORG` 默认 on（test 亦 on）。M2 保留 off 分支用于紧急收回与灰度回退；
  计划是稳定一个迭代后，另开任务删除 off 条件挂载与 v1 条件分支（届时组织面成为常驻），
  本里程碑不删。
- `GX_AUTH_STATE_TTL_MS` 保持默认 0，直到出现明确的每请求点查性能证据再评估调大；调大必须
  连同多实例失效方案一起设计（ADR-0022）。
- 审计 JSONL 仍写 `/var/log/gouxiangdb/audit.logl`（见 [deploy.md](deploy.md) 与
  [`../baseline/2026-09-14-m2-gate.md`](../baseline/2026-09-14-m2-gate.md) 的事件名表），
  logrotate copytruncate 复用既有轮换。
