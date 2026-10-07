# 已退役：M4 权限引擎漂移排查与应急处置

> **本手册描述的 shadow / drift 机制已删除（2026-10-06，ADR-0057）。**
>
> 引擎永久单一化后，不再有"旧决策 vs 引擎决策"的逐请求 D 类漂移，也没有 shadow 对拍。
> 原四章里仍然成立的处置方式与现入口：
>
> - **成员被误授 / 需收权**：直接移除其来源（角色授予、部门归属或 `role_library_scope`），
>   引擎下次判定即生效；没有"关引擎"这条路（开关已删）。
> - **成员被误拒（本应放行却 403）**：先按 [deploy.md §6.7.1](deploy.md) 跑
>   `project-scope.ts --apply` 补存量投影，再按 §6.7 对账；引擎抛错则查事件
>   `authz_engine_error`（503），资源无活节点查 `authz_engine_unresolved`（403）。
> - **inheritance 误关恢复 / 旧表投影不一致**：属数据投影问题，统一走 §6.7 / §6.7.1 的
>   `reconcile-policies.ts` 与 `project-scope.ts`（均幂等），权威口径见
>   [../adr/0057-authz-engine-permanent-single-implementation.md](../adr/0057-authz-engine-permanent-single-implementation.md)。
>
> 本文件保留仅为让历史链接不致 404，正文不再维护、勿据其操作。
