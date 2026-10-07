# 已退役：M4 权限引擎切 on 操作清单

> **本手册描述的机制已删除（2026-10-06，ADR-0057）。**
>
> 权限引擎已**永久单一化、无条件生效**，不再有 `GX_AUTHZ_ENGINE=off|shadow|on` 三态、
> READY 阶段门、shadow 对拍与"翻 on 五前置 / 总监下令"流程。即使环境变量里仍设
> `GX_AUTHZ_ENGINE`，该变量也会被完全忽略。
>
> 现行口径见：
> - [deploy.md §6.8](deploy.md)：引擎执法、fail-closed（503 / 403）、conjunction；
> - [deploy.md §6.7 / §6.7.1](deploy.md)：升级后的 authz 对账与存量 scope 投影；
> - [../adr/0057-authz-engine-permanent-single-implementation.md](../adr/0057-authz-engine-permanent-single-implementation.md)：
>   永久单一化的权威决策与影响面。
>
> 本文件保留仅为让历史链接不致 404，正文不再维护、勿据其操作。
