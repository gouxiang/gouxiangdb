-- 回滚演练用（非正式迁移）：撤销 20260918090000_mcp_pat_ddl 的效果（DROP 两表）。
--
-- 主回滚路径仍是发布前快照；PAT 表无既有业务读取方（M6 唯一消费者是 /api/v1/pats 与 /mcp），
-- 代码摘除后 DROP 安全。mcp_idempotency 同理（S7 才读写，历史幂等记录丢弃可接受）。
-- 幂等：IF EXISTS，重复执行无副作用。
-- 注意：DROP 会连带删除该库全部已签发 PAT 明文对应的 hash 行（明文本就不入库、无法恢复）；
--       执行前确认无在用 PAT，或先导出 tokenPrefix/userId/name 供重新签发。

DROP TABLE IF EXISTS "mcp_idempotency";
DROP TABLE IF EXISTS "personal_access_tokens";
