# ADR-0056：库级聚合动作位 enter / edit_data（投影派生、落库节点、不进字段并集）

**状态（Status）**：Accepted（2026-10-03 架构师 arch-authz-on-final 定稿）
**作者**：架构师 arch-authz-on-final
**上游依据**：docs/decisions/AUTHZ-ENGINE-ON-LIBRARY-SEMANTICS.md（权威长文，本 ADR 为其登记入口）
**关联**：ADR-0037（GX_AUTHZ_ENGINE 三态门）；ADR-0035（fieldMask 在表策略行上）；ADR-0036（继承中断）；ADR-0033（旧表作为 allow 投影）

---

## 1. 背景（Context）

翻 `AUTHZ_ENFORCE_READY`（off→on）前最后一个阻断缺陷：引擎拿节点 `r` 同时表达两件事——「人能否进入这个库」（库级准入，与表无关）与「人能否读这张表内容」（表级，承载 fieldMask）。数据动作 r/c/u/d 刻意只投影到 table 节点，库节点只放管理位。于是 on 态：

1. 七守在库节点判 r/u 一律落空 → 非超管角色（含只读成员）被 403；
2. 库节点因无 r 整层退出 S4 可见集（实测 owner visible=78，普通角色 visible=4、无 base/kb），库连同库内资源被 nav 祖先门剪掉；
3. requireCanManageBase 误用 manage_share，未勾 canManage 的管理员拿到全库管理权（OVERALLOW）。

两条直觉修法各撞一条已验收语义，详见长文 §1。

## 2. 决策（Decision）

在 `ResourceAction` 封闭枚举新增两枚**库级聚合动作位**，均由窄策略投影派生、落在库节点自身：

- **`enter`** = 第二代 `access.visible`。库门准入，空表库也成立；仅判库自身，不向下授权。
- **`edit_data`** = 第二代 `perm.canEditData`（= `canManage` 或库内任一活表被授 c/u/d）。

表级内容读仍由 table 节点 `r` + fieldMask 承载。枚举由 8 枚增至 10 枚，新位追加在末两位：

```
["r","c","u","d","comment","manage_share","manage_schema","manage_table","enter","edit_data"]
```

两条不变量：

- **I1 仅投影派生**：enter/edit_data 只接受 `reason='scope:role'` 的投影行，禁止手工授予；kb 只 emit enter，不 emit edit_data。
- **I2 不进字段能力并集**：二者不是 r/c/u，结构上进不了 fieldMask 的 read/writeSources，故永不制造 visibleAll、永不淹没逐表/逐字段收窄。

七守 on 态动作位：View=enter；EditData=edit_data；Comment=edit_data（legacy canComment=canEditData）；ManageSchema=manage_schema；ManageBase=manage_table（纠正 manage_share 错位）；ToggleShare=manage_share；DeleteBase=d（conjunction）。

## 3. 被否决的备选

1. **库节点补 `r`**：撞 A-4，无 mask r 源 → visibleAll，bc698bb 已锁 f2 泄漏。
2. **判定层沿用 `r` 实时跑库内活表并集**：撞 S4 decide↔scope 零分叉，空表库失效，且需把 legacy canManage 掺回引擎权威路径。
3. **库节点补最窄 mask**：mergeFieldMasks 对 `{allowFields:[]}` 不宽放，方向相反。

## 4. 后果与新鲜度闸（Consequences）

`edit_data` 是投影期算出的位，存在「新增/删除授权活表后、重投影前」的陈旧窗口。**落地原语 `syncTableForAllScopesTx`（scopeProjectionTx.ts:101-139）当前在 add/remove 时只 upsert/delete 目标 table 节点（:121/:129-136），并未把同一轮 `projectScopeRow` 已算出的库节点 edit_data 写回**；其调用点（tableServiceTx.ts:160、tables.ts:358、records.ts:1088）也未另做库节点重算。故该窗口为**真实翻闸阻断项**，闭合方式：

- 在 add/remove 分支额外 upsert/delete 该角色库节点（nodeId("base", libraryId)）那一行（投影已在 `projected` 内，改动小、同事务、零额外查询面）；或在这些调用点改走 `rebuildScopePoliciesTx` 全量替换。
- scope 行写路径（roleLibraryScopes.ts:136，rebuildScopePoliciesTx）已覆盖「改表级授权」；软删库由 expectedRole 活库过滤覆盖。
- 补对拍测试：建表/删表后立即核对 edit_data ↔ legacy canEditData。

preflight 检测：preflightReachability.mismatches（聚合位对 legacy 等价）与 preflightScopeVisibility.orphanTableUsers 必须为 0。

## 5. 验证证据

- 枚举：packages/shared-types/src/authz.ts:19-46；投影：scopeProjection.ts:118-209；管理员隐含：implicitAdminProject.ts:68-89。
- 事务原语：scopeProjectionTx.ts:101-139；双写：scopeDoubleWrite.ts:125-134。
- 体检：preflightReachability.ts、preflightScopeVisibility.ts。
- 完整文件清单、七守表、十项翻 on 退出清单：见 docs/decisions/AUTHZ-ENGINE-ON-LIBRARY-SEMANTICS.md。
