# M4 统一权限引擎：策略双写、开关往返与恢复路径

M4 权限引擎（`auth_policies` 权威表 + 旧三表 `members` / `kb_members` /
`kb_doc_acls` 物化投影）的可执行运维流程。架构背景见
[ADR-0024](../adr/0024-org-role-vs-resource-role-layering.md)（组织角色与资源角色
物理分层）。

> 命令默认在 api 应用目录（发布物的 `apps/api` 或等价 current 目录）执行；生产
> `DATABASE_URL` 由 `/etc/gouxiangdb/env.conf` 注入。改库前先按
> [backup.md](backup.md) 做一次在线备份。单实例部署（ADR-0003）。

## 1. 权威边界与双写方向

- **权威唯一**：`auth_policies`。引擎决策（decide/scope/effective）只读这张表加
  `nav_nodes` 祖先链，绝不读旧三表。
- **旧三表是物化投影**：旧七守卫仍只读 `members`/`kb_members`/`kb_doc_acls`。
- **两个写方向，都在同一事务内共生死**（任一侧写失败整体回滚，无半截）：
  1. 旧入口加/改/移除成员或文档 ACL -> 同事务投影到 `auth_policies`（`reason` 为
     `legacy:member` / `legacy:kb_member` / `legacy:acl`，确定性策略 id
     `pol_legacy_{member|kbmember|acl}_<旧行id>`）。成员**降级**（owner->viewer）
     走精确 SET 收窄，不用并集。
  2. 新端点 `PUT /api/v1/nodes/:id/policies` 写可映射档 -> 同事务反写旧三表。

## 2. 功能 flag 与本阶段语义

| flag | 默认 | 取值 | 作用 |
|---|---|---|---|
| `GX_AUTHZ_ENGINE` | **off** | off / shadow / on | off=七守卫只走旧三表；shadow=旧决策为准并额外对拍引擎；on=以引擎为准 |
| `GX_ENTERPRISE_NAV` | **on** | on / off | off 摘 `/api/v1/nodes/*`（含 policies/effective 端点） |

**S5 阶段门（重要）**：`AUTHZ_ENFORCE_READY=false`，此时把 `GX_AUTHZ_ENGINE=on`
会被**自动降级为 shadow** 并在启动日志打一次 warn。也就是说 S5 期间守卫永远以旧
三表为准，`on` 不会真正生效；要等 S6（fieldMask 五出口）完成、§4.8 翻门五条件
全满足且由项目总监下令后，`on` 才以引擎为准。`GET /nodes/:id/effective` 与
`GET /nodes/:id/policies` 不经过该 flag，任何模式下都直接算权威表。

## 3. legacyUnmappable：不可映射授权的处理

`PUT /nodes/:id/policies` 只在以下严格条件下反写旧三表：`subjectType=user` +
节点是 base/kb/doc|canvas 实体 + 无 fieldMask + 动作串恰好等于某旧角色档。其余
授权（**角色/部门授予、fieldMask、非标动作组合、table/view/group 节点**）无法回写
旧三表，处理方式是：

- 仍写入权威 `auth_policies`（这是成功操作，HTTP 200）；
- 响应携带 `legacyUnmappable:[{subjectType,subjectId,reasons}]` 明细；
- **不动旧三表**（不扩列、不留假成员行）。

`legacyUnmappable` 不是错误码，错误码表不含它。

## 4. 开关往返与「关引擎后不可映射授权失效、重开恢复」

S5 期间的权威语义（守卫在 off/shadow 都以旧三表为准）：

1. 一条角色授予（不可映射）经 PUT 落 `auth_policies`，旧三表零行。
2. **flag off / shadow 期间**：旧守卫看不到这条授权（旧三表没有对应行），即
   「引擎侧授权在旧权威路径下不生效」——这是预期，因为引擎尚未接管强制。
3. **权威行始终保留**：往返切 off -> shadow -> on(降级shadow) -> off，
   `auth_policies` 里那条角色授予行不被删除、不被回灌到旧表、动作串不变。
4. 引擎决策与 flag 无关：即使在 off 下，直接对权威表跑 decide / 查
   `GET /nodes/:id/effective` 仍会把该角色授予求值为 allow。**这就是「重开即恢复」
   的根据**——S6 翻门把 `GX_AUTHZ_ENGINE` 置为真正的 on 后，无需任何数据迁移或
   补写，存量不可映射授权立即生效。

### 4.1 恢复/演练命令

```bash
# 权威表中某节点的全部策略（含不可映射的角色/部门授予），off 下也能查
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3001/api/v1/nodes/nav_base_<baseId>/policies

# 某用户在该节点的最终动作集与逐动作来源链（直接算权威表，不经 flag）
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:3001/api/v1/nodes/nav_base_<baseId>/effective?userId=<uid>"
```

紧急收回引擎强制路径（S6 翻 on 之后若需回退）：把 `GX_AUTHZ_ENGINE` 改回
`shadow` 或 `off` 重启即可，旧三表权威立即接管；权威表数据保留，重开 on 恢复。

## 5. 物理删节点的策略清理

`auth_policies` 对 `nav_nodes` **无外键**（刻意解耦），物理删节点不会级联清策略。
三个 purge 函数已在同事务显式删除挂在被删节点上的全部策略（含各来源与
legacy/v1）：

- `purgeViewNodeTx`：删该 view 节点策略；
- `purgeTableNodeTx`：删 table 节点及其子 view 节点策略；
- `purgeDocNodeTx`：删 doc/canvas 节点策略。

若历史库出现指向已不存在节点的孤儿策略（正常路径不会产生），用 M4 对账脚本
（`apps/api/scripts/authz/reconcile-policies.ts`）检出 B1 类悬挂投影后按其
`--apply` 清理。

## 6. 排障速查

| 现象 | 排查 |
|---|---|
| PUT policies 返回 400 `POLICY_*` | 动作非七枚白名单 / 主体悬挂（用户/部门/角色不存在或已删）/ fieldMask 字段不属于该 table / 动作对节点 kind 非法（如 view 上 manage_schema）。整单全拒，无任何写入 |
| PUT 返回 404 | 节点不存在或已软删（404 先于授权判定） |
| PUT 返回 403 | 既无组织 `manage_share`（工作区角色），对该节点 `decide(manage_share)` 也不通过 |
| 200 但 `legacyUnmappable` 非空 | 成功，只是这些授权不能反写旧三表；S6 引擎强制前对旧守卫不生效，行已留存 |
| 加成员后旧守卫不认新角色 | 查 `auth_policies` 是否有 `pol_legacy_*` 投影行 + 引擎是否已翻 on；S5 off/shadow 下以旧表为准，投影只供引擎/shadow |
