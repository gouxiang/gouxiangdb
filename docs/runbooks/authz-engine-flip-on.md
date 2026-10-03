# M4 权限引擎：切 on（enforce）操作清单

- 下令权：**仅项目总监**（ADR-0037 / M4 计划 §4.8 裁决 A-3）。运维与开发无权自行翻门。
- 适用：M4 出口（代码默认 `GX_AUTHZ_ENGINE=off`，生产建议值 `shadow`）之后，
  五个前置全部满足时，把七守资源可达性从「旧三表为准」切到「引擎 decide 为准」。
- 相关文档：[deploy.md §6.8](deploy.md#68-权限引擎-shadow-对拍gx_authz_enginem4-s3-起)（三态与观测）、
  [authz-policy-dual-write.md](authz-policy-dual-write.md)（双写与开关往返）、
  翻门证据 [../baseline/2026-09-16-m4-gate.md](../baseline/2026-09-16-m4-gate.md)。

> 现状边界（2026-09-16 S10 末态，重要，先读）：
>
> - 七守（guards.ts 五个 require*、routes/kb requireKb/requireDocAccess）当前**只挂 shadow 对拍**，
>   尚无「以引擎 decide 为准放行/拒绝」的 enforce 生产分支；`AUTHZ_ENFORCE_READY=false`，
>   env 设 `on` 会被运行时降级为 shadow 并打一次 warn。
> - 已经在 `on` 语义下真实生效的是两件只减不增的能力：fieldMask 五出口（S6，
>   `FIELD_MASK_ENFORCE_READY=true`）与 tree/menu 剪枝 + 面包屑截断（S7，
>   `NAV_PRUNE_ENFORCE_READY=true`），它们读原始 env，env=on 即生效。
> - 因此本清单第 0 步是「部署含七守 enforce 接线、且总门可翻的构建」——这是总监下令后的
>   **独立切片**（不在 M4 里程碑内默认发生，M4 不删旧守卫分支）。下列步骤描述切 on 的
>   完整操作面，供该切片落地后照此执行与签收。

## 0. 前置 0：enforce 构建就位（独立切片交付后）

- [ ] 七守在「生效模式 = on」时以引擎 decide 为权威结果（allow 放行 / deny 403），
      旧决策仅用于反向 shadow 计数；接线不改变 off/shadow 两态任何行为。
- [ ] `AUTHZ_ENFORCE_READY` 经独立评审翻为 true（或等价的受控发布机制），
      代码默认值仍保守，生产取值不由代码默认决定。
- [ ] 旧守卫决策分支保留（A-3：on 稳定后再保两个迭代，删除在另开切片，M4 不删）。
- [ ] 该构建自身通过 40RC + S0 golden + M4 全量回归。

## 1. 切 on 五条前置（§4.8，全满足才下令）

1. **characterization 对拍双零**：S0 旧三表决策 golden（五角色 x 三资源族 x 继承/ACL 组合，
   覆盖 ARCH 18 条越权矩阵）在 shadow 下 `DRIFT_OVERDENY=0`、`DRIFT_OVERALLOW=0`。
   自动化对应 `characterization/*` + `shadow-integration` + `s10-ac-authz-matrix`。
2. **升级副本对账双零**：升级副本库跑 `scripts/authz/reconcile-policies.ts` A/B/C=0；
   随机 20 主体 x 20 节点新旧判定全等（`s10-ac-upgrade-20x20`），全量小库逐判定 0 漂移。
3. **类生产演练库确定性流量双零**：500 用户/6 层部门/万节点/约 3000 策略夹具上
   scope 与 decide 12000 次布尔对拍 0 差异、SQL 定数、EXPLAIN 无 SCAN、P95 达标
   （证据：2026-09-16-m4-gate.md §1；命令 `GX_M4_GATE=1 ... vitest run scope-scale
   s10-scale-gate --fileParallelism=false`）。
4. **生产影子连续一个迭代双零**：`GX_AUTHZ_ENGINE=shadow` 连续运行一个完整迭代，
   期间 `DRIFT_OVERALLOW=0` 且 `DRIFT_OVERDENY=0`（M4 比 M1 更严，可用性漂移也不灰度容忍）；
   `authz_shadow_error=0`（或全部错误有归因结论）。观测面见 deploy.md §6.8。
5. **回滚演练通过 + 本清单经总监签收**：翻转演练 off -> shadow -> on -> 反向 shadow -> off
   全程逐值恢复（s5-toggle-roundtrip + S10 flip-drill），权威行往返不丢（A-5 不可映射授权
   重开即恢复）；本文件由项目总监书面签收。

## 1.5 通电前数据面体检（存量投影 + 体检，翻门前必做）

> 头号风险：通电瞬间引擎只认 `auth_policies` 里有什么。第二代 `role_library_scope` 的存量配置
> 若没完整投影进 `auth_policies`，用户配好的权限会整体失准。双写只覆盖写路径，存量必须补一次全量投影。

```bash
cd /srv/gouxiangdb/current/api
# 1) 存量全量投影（幂等；第二次必须 no changes）
DATABASE_URL=file:/var/lib/gouxiangdb/app.db pnpm tsx scripts/authz/project-scope.ts --apply
# 2) 一次回答「能不能通电」（READY exit 0 / NOT_READY exit 1）
DATABASE_URL=file:/var/lib/gouxiangdb/app.db pnpm tsx scripts/authz/preflight.ts
```

- [ ] `project-scope.ts --apply` 退出码 0，二次复跑打印 `no changes`。
- [ ] `preflight.ts` 覆盖缺口=0（`auth_policies` 里 `reason='scope:role'` 行数 == 期望行数）。
- [ ] `preflight.ts` 对账 S=0（存量投影逐值一致）、A1/A2/B/C=0（legacy 投影无漂移）。
- [ ] `preflight.ts` 判定 READY（A3 与 legacy 残留是提示项，不阻断；见脚本 [4][5] 段输出）。
- [ ] 体检用【升级副本库】先跑一遍，再在目标库跑；任一项不通电即停，不要"先试试"。

命令出处与完整口径见 [deploy.md §6.7.1](deploy.md#671-通电前存量-scope-投影与体检翻-enforce-门之前必跑)。

## 2. 切换步骤（前置 0 + 五条齐备后）

1. 按 [backup.md](backup.md) 做一次在线备份；确认 `/readyz` 五探针绿、当前 env=shadow。
2. 记录切换前 drift 计数快照（环形缓冲 + 结构化日志聚合），存档作为基线。
3. 在 systemd EnvironmentFile（`/etc/gouxiangdb/env.conf`）置 `GX_AUTHZ_ENGINE=on`，
   灰度重启 API（单实例：滚动重启一次进程）。
4. 启动行必须显示 `[authz] GX_AUTHZ_ENGINE configured=on effective=on`
   （**不得**出现 `(on 阶段降级 shadow)`；出现说明总门未就绪，立即停止并查前置 0）。
5. 发布后立即冒烟（用真实账号，勿用他人数据）：
   - 成员可访问其 base/kb/doc；非成员被 403；停用用户旧 JWT 401；
   - fieldMask 表只读不泄漏隐藏列；tree/menu 不出现无权节点；
   - v1 policies/effective/scope 正常；
   - 反向 shadow 计数开始累积（引擎为准，旧结果仅对比）。

## 3. 切换后观测（反向 shadow 一个迭代）

- 引擎决策生效，旧守卫结果只做对比记录；任一 `DRIFT_OVERALLOW` 出现 = 越权信号，
  **立即按 §4 回滚**并启动故障排查（不等待、不灰度）。
- `DRIFT_OVERDENY` 出现 = 误拒/锁外风险，评估影响面；本里程碑要求双零，出现即应回滚或停发。
- `authz_shadow_error` 非零先判引擎自身故障（此时请求按引擎结果为准，需确认不是引擎误拒）。
- 反向 shadow 满一个迭代且双零后，旧守卫分支进入「再保两个迭代」观察期，
  期满后在**另开切片**评审删除（M4/S11 只出裁决与删除清单，不在此 runbook 执行）。

## 4. 回滚（一步）

```bash
# /etc/gouxiangdb/env.conf
GX_AUTHZ_ENGINE=off      # 或退回 shadow 保留对拍
# 重启 API；启动行应显示 configured=off effective=off
```

- 回滚后旧七守立即以旧三表决策为准，响应逐值恢复；auth_policies 权威数据保留，
  旧表在双写期保持新鲜，无需数据修复或迁移。
- on 期间经 v1 写入的 A-5 类授权（角色/部门/fieldMask 等不可映射行）在 off 下对旧守不生效，
  但**行不丢**，重开 on 即恢复（见 authz-policy-dual-write.md §4）。
- 回滚属总监授权动作；故障现场可先执行后补签，但必须同步通报总监。

## 5. 禁止事项

- 禁止为「先试试」把 env=on 当灰度手段：总门未就绪时它静默降级 shadow（给人已切 on 的错觉），
  就绪后它是硬切换（无灰度比例）。中间态只有 shadow。
- 禁止改代码默认值来切 on；生产取值只由部署 env + 总监下令决定。
- 禁止在双零证据不足、或本清单未签收时切 on。
- 禁止 M4 内删除旧守卫决策分支（A-3 时间线）。
