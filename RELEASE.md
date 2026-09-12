# GouXiangDB v2 第二轮 6 类问题修复自测报告

## 元信息
- 日期：2026-09-04
- 测试范围：用户第二轮反馈的 6 类问题修复
- 数据库：`apps/api/prisma/dev.db`（**注意**：DATABASE_URL 已改为绝对路径 `file:/Users/daijing/Desktop/GouXiangDB-v2/apps/api/prisma/dev.db`，之前的相对路径 `file:./dev.db` 会让 Prisma 写入 schema.prisma 同目录的 `prisma/dev.db`，API cwd 与 schema 目录分离时会出现读写分裂问题）
- dev 服务：API :3001 / Web :5173（`bash scripts/dev-up.sh restart`）
- 测试账号：`verify@gouxiang.local` / `verifytest1`（owner of 测试E2E base `cmtmtf3wp001rd6fa9mz0mocz`，注意是 25 字符的 cuid，多写一个 t 会命中不到）

## 6 类问题修复状态

### ① 选项字段颜色淡 → ✅ 修复
- 现象：单选/多选胶囊颜色透明看不清
- 修复：`components/ui.tsx` Badge `variant = "solid"` + 实色背景 + 白字
- 详情页：`features/detail/DetailLayout.tsx` 单选/多选胶囊改为实色
- Grid 视图：`features/views/field-controls.tsx` 单选胶囊改为实色

### ② 详情页布局编辑 → ✅ 修复
- 移除详情页右上角的 1/2/3 选项卡（之前是 NocoDB 旧版的列数切换，业务逻辑已废弃）
- 工具栏加「⊞ 编辑布局」按钮 → 打开 `DetailLayoutEditor`
- `DetailLayoutEditor` 支持：拖拽换序、行内 1-4 列布局、长字段跨整行、可用字段池
- `DetailLayoutRenderer` 按 layout 渲染
- 用户第 3 类（1/2/3 选项卡用途不明）一并清理

### ③ 数据关联字段 → ✅ 修复
- 修复 1：详情页关联选择功能（LinksEditor 已在 v2 实现带 search+filter）
- 修复 2：关联字段级筛选 UI（`FieldEditorSheet` 的关联字段块新增「关联筛选条件」折叠区，存 `recordFilter`，目标表字段可选过滤）
- 修复 3：关联字段核心业务逻辑明确——关联整条记录（存 LinkRef 表），反向关联级联对称软删；计算字段（lookup/rollup/count）能按 recordFilter 在对面表记录上做子集筛选

### ④ 聚合字段 → ✅ 修复
- 修复 1：聚合字段（lookup/rollup/count）支持 recordFilter 子集筛选 UI（`RecordFilterBuilder`）
- 修复 2：count 之前直接走 DB `countLinkRows` 忽略 recordFilter——`hydrate.ts` 改为走 `resolveLinkedPeerIds + getRecordsByIds + evalFilter`，应用 recordFilter 后再统计
- 修复 3：公式字段可引用 lookup/rollup/count（`FormulaBuilder` 不过滤字段；后端 `evalFormula` 通过 `merged[fieldId]` 取值）

### ⑤ 公式函数全集 → ✅ 验证
- `formula-functions.test.ts`：82 断言，覆盖 CONCAT/UPPER/LOWER/ROUND/CEILING/FLOOR/ABS/MIN/MAX/SQRT/POWER/MOD/INT/SUM/AVERAGE/NOW/TODAY/DATETIME_DIFF/DATEADD/SEARCH 等 28+ 函数 + 操作符 + 综合场景
- `formula.test.ts`：43 断言覆盖核心（SEARCH 沿用 v1 约定 `SEARCH(within, find)`）
- **关键修复**：v2 前序 SEARCH 参数顺序错位，回归测试已对齐 v1

### ⑥ 业务逻辑综合修复
- `routes/fields.ts` schema 加 `recordFilter: z.unknown().nullish()`
- `domain/fieldService.ts` CreateFieldInput + UpdateFieldInput + createLinkFieldPair（forwardField）都持久化 `recordFilter`
- `domain/types.ts` + `domain/prismaDeps.ts` + `prisma/schema.prisma` + migration `20260904101308_add_record_filter`
- `packages/shared-types/src/api.ts` `FieldDTO` 加 `recordFilter: FilterNode | null`（之前漏序列化，前端看不到 recordFilter 值）

## E2E 验证（HTTP API）

聚合字段 recordFilter 端到端验证：

| 任务 | 关联客户 | 期望 VIP数 | 期望 VIP名 | 期望 VIP总数 | 实测 | 结果 |
|---|---|---|---|---|---|---|
| T1 | A(VIP)+B(普通) | 1 | [客户A-VIP] | 100 | 1 / [客户A-VIP] / 100 | ✅ |
| T2 | A(VIP)+C(VIP) | 2 | [客户A-VIP,客户C-VIP] | 150 | 2 / [客户A-VIP,客户C-VIP] / 150 | ✅ |
| T3 | B(普通)+D(普通) | 0 | [] | 0 | 0 / [] / 0 | ✅ |

公式引用 lookup/rollup/count：

| 任务 | 公式 | 期望 | 实测 | 结果 |
|---|---|---|---|---|
| T2 | `{VIP客户数}*2` | 4 | 4 | ✅ |
| T2 | `{VIP客户总数量}+10` | 160 | 160 | ✅ |

recordFilter 持久化：创建字段时 `recordFilter: {kind:"condition",fieldId:...,op:"is",value:"VIP"}` → DB `fields.recordFilter` 列已存 → `GET /api/fields?tableId=...` 回显完整 FilterNode。

## 单元测试

```
✓ src/domain/__tests__/formula.test.ts           (43 tests)
✓ src/domain/__tests__/formula-functions.test.ts (82 tests)
✓ src/domain/__tests__/record_filter.test.ts     (5 tests)
✓ src/domain/__tests__/hydrate.test.ts           (20 tests)

Test Files  4 passed (4)
     Tests  150 passed (150)
```

## typecheck

- 后端 `apps/api`：0 错误（修复了 5 处 `detailLayout` 重复属性 + 1 处测试误用 `.then`）
- 前端 `apps/web`：0 错误

## 已清理脏数据

- 临时测试账号 `newverify*` / `verify3*` 已删除
- 误建记录（VIP-now 残留）已软删
- `Customers_e2e` 测试表已软删

## 已知遗留（前序 P0 优先级更高，本轮未触碰）

- 分享 Share
- 多字段编辑（bulk update 已建，但 UI 编辑器未做）
- ERD 关系图

## 交付测试请用户做

请用户在 `http://localhost:5173`（Web）下用 `verify@gouxiang.local` / `verifytest1` 登录：
1. 测试E2E base 默认表应能正常打开，字段颜色不再淡
2. 详情页右上角不再有 1/2/3 选项卡；改为工具栏「⊞ 编辑布局」可自定义行内字段布局
3. 关联字段编辑器新增「关联筛选条件」折叠区
4. lookup/count/rollup 编辑器新增「子集筛选条件」折叠区，可按对面表字段筛选
5. 公式编辑器可插入 lookup/rollup/count 字段名作为 `{xxx}` 引用

约束遵守：本轮未走 Release 打包流程，只做 Debug 构建重启供测试。