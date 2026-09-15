# M4 权限引擎错误码表（v1 冻结）

随 M4/S8 `docs/api/openapi.yaml` 增补冻结一并落表。全部 v1 端点错误体统一为现网信封：

```
{ "error": "<中文文案>", "code": "<机器码>", ...仅个别端点附载荷 }
```

不使用 `{code:0,data,message}` 信封（M3 裁决 5）。未显式指定机器码时按 HTTP 状态回落
（400 BAD_REQUEST / 401 UNAUTHORIZED / 403 FORBIDDEN / 404 NOT_FOUND / 409 CONFLICT）。

## 权限域六枚定名码（S8 去重冻结）

| code | HTTP | 产出端点 | 语义 | M4 是否真实产出 |
|------|------|----------|------|-----------------|
| FORBIDDEN_FIELD | 403 | 旧 `/api` records create/patch/batch 三写端点 | 写 payload 含不可见字段键或只读物理键；整单拒绝、事务不开、行不变 | 是（S6 fieldMask 写键守卫） |
| FORBIDDEN_RESOURCE | 403 | 预留：M6 MCP 工具执行期 | 主体已认证但本次资源/动作无权（IDOR 直传无权资源 id）；结构化拒绝可附 requiredAction/currentRoleSources | 否。REST v1 当前 403 回落泛 `FORBIDDEN`；M6 MCP 面启用本码（见 M6 计划 §MCP 词汇） |
| POLICY_CONFLICT | 409 | 预留 | 同节点同主体多策略行违反唯一意图等策略冲突 | 否。M4 策略写为 upsert 覆盖语义（同键更新不新增），不经 HTTP 产出；对账脚本的 `C4_DUPLICATE_POLICY` 是只读巡检码，非本错误码 |
| INHERITANCE_CONFIRM_REQUIRED | 409 | PATCH `/nodes/{id}/inheritance` | 切换继承影响面需二次确认；响应附 `impact`（InheritanceImpact），状态不变 | 是（S7） |
| NODE_NOT_INHERITABLE | 400 | GET `/nodes/{id}/inheritance/impact`、PATCH `/nodes/{id}/inheritance` | 目标节点非 doc/canvas 叶子，不能中断/恢复继承 | 是（S7） |
| POLICY_CONDITION_UNSUPPORTED | 400 | 预留：PUT `/nodes/{id}/policies` | A-7 行级/分组桶条件本期不实现，upsert 不接受也不持久化 conditions 键；P1 启用时非 null conditions 一律 400 本码 | 否（A-7 顺延 P1；当前 conditions 键被白名单取字段忽略，不报错也不落库） |

## 策略写整单校验细码（S5，PolicyValidationError.code 原样透传）

仅 PUT `/nodes/{id}/policies` 产出。任一不合法整单全拒、policyVersion 不增、合法项也不落。

| code | HTTP | 触发 |
|------|------|------|
| POLICY_BAD_INPUT | 400 | 请求体非对象；upserts/deletes 非数组或全空；超批量（upserts>200/deletes>500）；元素非对象 |
| POLICY_SUBJECT_INVALID | 400 | subjectType 非 user/dept/role；subjectId 缺失/空白；主体不存在（悬挂） |
| POLICY_ACTION_INVALID | 400 | actions 非非空数组；含七枚白名单外动作；kind-动作非法（如 view 挂 manage_schema） |
| POLICY_FIELD_INVALID | 400 | fieldMask 引用字段不属于该 table 节点 |
| POLICY_NODE_NOT_FOUND | 404 | 目标 nav 节点不存在或软删（存在性预检先于授权，避免探测出 500） |
| POLICY_NODE_KIND_INVALID | 409 | 编排节点（group）挂资源授权策略 |

## 相关既有码（非本期新增，一并列管）

| code | HTTP | 说明 |
|------|------|------|
| NODE_NOT_FOUND | 404 | inheritance/breadcrumb：节点不存在或软删（与 POLICY_NODE_NOT_FOUND 不同域） |
| MOVE_NEEDS_CONFIRM | 409 | POST `/nodes/{id}/move` 未带 confirmed，附 MoveImpact |
| VERSION_CONFLICT | 409 | 旧 `/api/kb/docs` 乐观锁冲突，附 currentVersion（现网特殊信封，不改） |

## 前端处理约定

- 403 泛 `FORBIDDEN` 与预留的 FORBIDDEN_RESOURCE 在 M4 REST 上按同一"无权操作"提示处理；M6 接 MCP 时再细分。
- 409 INHERITANCE_CONFIRM_REQUIRED / MOVE_NEEDS_CONFIRM：读响应体 `impact` 弹二次确认 Modal，确认后带 `confirmed:true` 原样重放。
- 400 POLICY_CONDITION_UNSUPPORTED 本期不会出现；若出现视为前端误传 conditions（M4 UI 不得提供行级条件入口）。
