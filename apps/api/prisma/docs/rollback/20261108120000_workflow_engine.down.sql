-- 回滚：撤掉自研工作流引擎（需求 #1296）刀 A 地基的三张 workflow_* 表，回到"无工作流面"形态。
-- 对应迁移：20261108120000_workflow_engine。
-- 仅回退本迁移效果（只增表，主数据 records/fields/bases/... 与本迁移无任何外键依赖）。
--
-- 影响面：这三张表只服务工作流引擎（GX_WORKFLOW_ENGINE=on 时才挂路由、才启动 runtime、才写入）。
--   - off（出厂默认）时应用从不写这些表，DROP 不影响任何现有功能；
--   - on 且已产生工作流数据时，DROP 会丢失流程定义 / 运行实例 / 审批记录，
--     故【只在确认无工作流数据、或明确要废弃工作流能力时手动执行】。
--
-- 回滚前置：
--   1. 先把 GX_WORKFLOW_ENGINE 置 off 并重启/等路由刷新，确保没有在途 runtime 轮询与审批写；
--   2. 停掉 API 进程（SIGTERM），避免回滚瞬间仍有工作流写；
--   3. 需要留档先导出三张表。
--
-- 顺序：先删唯一/普通索引（随表 DROP 一并清，SQLite 下 DROP TABLE 自动级联删其索引），
-- 再删表；这里直接 DROP TABLE IF EXISTS 即可，索引随之删除。按子表到父表顺序：
-- 先审批（workflow_approvals），再运行（workflow_runs），最后定义（workflow_defs）。

DROP TABLE IF EXISTS "workflow_approvals";
DROP TABLE IF EXISTS "workflow_runs";
DROP TABLE IF EXISTS "workflow_defs";
