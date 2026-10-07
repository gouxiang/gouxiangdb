# 已退役：M4 权限引擎策略双写与开关往返

> **本手册描述的机制已删除（2026-10-06，ADR-0057）。**
>
> 旧三表（`members` / `kb_members` / `kb_doc_acls`）不再是参与放行的"物化投影"，
> 权限引擎（读 `auth_policies` + `nav_nodes`）是唯一、无条件、永久的执法路径。
> 与 `GX_AUTHZ_ENGINE` 三态开关、READY 门相关的"开关往返 / shadow 对拍"流程一并废止；
> 环境里仍设该变量也会被忽略。
>
> 仍然有用的部分已迁移：
> - 升级后 authz 对账（A/B/C 漂移）：[deploy.md §6.7](deploy.md)；
> - 存量 `role_library_scope` 投影：[deploy.md §6.7.1](deploy.md)；
> - 引擎执法与 fail-closed：[deploy.md §6.8](deploy.md)；
> - 权威决策：[../adr/0057-authz-engine-permanent-single-implementation.md](../adr/0057-authz-engine-permanent-single-implementation.md)。
>
> 本文件保留仅为让历史链接不致 404，正文不再维护、勿据其操作。
