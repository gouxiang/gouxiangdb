-- autoNumber 持久化高水位计数器表 auto_number_counters。
--
-- 它解决什么：旧算法（src/domain/defaults.ts resolveAutoNumber）用「数同表活记录」
-- 得到 counter 段序号，软删一条记录后下一个号就会与存量编号重复。改为每认领一个
-- 序号 value+1 的只增计数器：序号永不复用。
--
-- key 的口径（由 src/domain/defaults.ts 生成）：
--   `${编号字段Id}:${counter段索引}:${resetKind}:${bucket}`
--   resetKind/bucket：never→global/global；year→year/yyyy；month→month/yyyyMM；
--   day→day/yyyyMMdd；field→field/<resetField 值 comparable>。
-- 同一表可有多个 autoNumber 字段、多 counter 段，各自一行。
--
-- 存量活记录的高水位不由本迁移回填（需解析 fields.numberRule JSON 与 records 计数，
-- SQL 难稳妥实现）：由 scripts/backfill-auto-number-counters.mjs 在 migrate deploy
-- 之后执行，幂等可重跑。老记录已生成的编号字符串保持原样不动。
--
-- 实现纪律（照 20260924010000_form_layout_versions）：
--   1. 只新建本迁移自己的表与索引，不动任何既有表；存量数据零改动。
--   2. 不加物理外键：tableId 为软引用（表物理删时由应用级 purge 清理）。
--   3. 列名 camelCase（@@map 只映射表名，物理列名即 model 字段名）；表名 snake_case。
--   4. 重复执行的保护来自 _prisma_migrations（migrate deploy 对已应用迁移整体跳过）。

CREATE TABLE "auto_number_counters" (
    "id"      TEXT NOT NULL PRIMARY KEY,
    "tableId" TEXT NOT NULL,
    "key"     TEXT NOT NULL,
    "value"   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX "auto_number_counters_tableId_idx" ON "auto_number_counters"("tableId");
CREATE UNIQUE INDEX "auto_number_counters_tableId_key_key" ON "auto_number_counters"("tableId","key");
