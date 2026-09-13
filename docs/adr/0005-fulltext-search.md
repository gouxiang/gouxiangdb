# ADR-0005：全文检索与中文子串召回（M1 只定边界，正式方案在 M5）

**状态（Status）**：Proposed / 占位（M1 不建主库 FTS；trigram 边界已实测，正文随 M5 统一检索补全，2026-09-13）
**作者**：后端（mvp-dev-expert-team-backend）
**编号来源**：生产化架构 §6「新增 ADR 清单」预留 0005「FTS5 全文检索与中文子串召回策略（含 better-sqlite3 预案）」。企业版 M5 的 FTS5 trigram 细化另编号 ADR-0018。

---

## 背景（Background）

M1 之前全局/库内搜索是"每表最多取 2000 条活记录进内存做 JS `includes`"
（`routes/records.ts` 的 `/api/records/search`、`routes/search.ts` 的 `/api/search`
记录支路），存在两个边界：①每表 2000 行截断，超过部分召不回；②短中文词的子串
召回质量依赖扫描而非索引。M1 的范围是数据底座（写队列、sidecar、hydration、
keyset、压测门），**不含**统一检索改造；架构 §3.1 A3 的 FTS5 全文检索排在
后续阶段（企业架构对应 M5，ADR-0015 检索变更管道 / ADR-0018 trigram 细化）。

为避免 M5 重复踩坑，M1 先用一天内可复跑的探针把 FTS5 trigram 的中文短词
召回边界钉死，作为"短词 LIKE 回退是必需而非可选"的事实前提。

## M1 已实测事实（SQLite 3.53.4 / better-sqlite3 13.0.3）

在内存库 `CREATE VIRTUAL TABLE f USING fts5(t, tokenize='trigram')` 上，
对中文文档集直接 MATCH（2026-09-13 复跑，临时探针用后即删）：

| 查询 | 命中数 | 说明 |
|---|---|---|
| `订单`（2 字中文） | **0** | trigram 需至少 3 字符切词，2 字词产生不了 trigram |
| `离职`（2 字中文） | **0** | 同上 |
| `订单编`（3 字中文） | 1 | ≥3 字命中 |
| `离职申`（3 字中文） | 1 | ≥3 字命中 |

结论：**FTS5 trigram 对 2 字中文词不命中（不是报错，是零召回），≥3 字才命中。**
因此 M5 即便上 trigram，也必须保留"短词（<3 字）走 LIKE/旁路表回退"的路径，
否则中文双字词（订单、离职、合同等高频业务词）会静默漏召回。企业 ADR-0018
拟的"trigram + 短词 LIKE 回退"由此得到实测支撑。

## 决策（Decision，M1 范围）

- **M1 不在主库建任何 FTS 虚表。** 理由：M5 会建独立可重建的检索派生库
  （企业 ADR-0015 outbox + 派生库），M1 提前在主库建 FTS5 会造成两套全文
  索引重复建设与迁移负担，且 trigram 对 2 字中文词本就不完整。
- M1 保留两处 `take: 2000` 内存搜索，但其**截断边界显式化**：响应/代码注释/
  runbook 统一登记为"有界预览（bounded preview），非全量召回"，由 M5 统一
  检索替换（见 baseline §搜索边界 与 runbook 已知限制）。M1 不扩成全表扫、
  不引 FTS、不改召回语义。
- 短词 LIKE 回退作为已验证前提写入 M5 输入，不在 M1 实现。

## 后果（Consequences）

- M1 全局/库内搜索在单表超过 2000 行时仍会漏召回——这是**已知且显式登记**的
  限制，不是回归；产品文案/提示按"预览"口径，不承诺全量。
- 不引入 FTS 虚表意味着 sidecar（ADR-0004）与全文检索职责清晰分离：
  sidecar 管物理标量的等值/范围/排序/COUNT 走索引，FTS 管任意子串/分词召回，
  两者在 M5 分别落位，不互相借道。
- M5 正式方案待决项（本 ADR 占位、不在 M1 固化）：独立派生库还是主库虚表、
  中文分词（trigram 与 LIKE 回退的阈值、是否叠加 jieba/zh 分词）、写时变更
  管道（outbox）、跨记录/知识库的统一召回与高亮。

## 相关（Related）

- [ADR-0004](0004-eav-sidecar-index.md)：物理标量 EAV 旁路索引（管结构化谓词，不管全文）
- 企业 ARCH §10.4 ADR-0015（检索变更管道 / 可重建派生库）、ADR-0018（FTS5
  trigram 中文检索与短词 LIKE 回退，细化本 ADR）
- 现状搜索：`apps/api/src/routes/records.ts`（`/api/records/search`）、
  `apps/api/src/routes/search.ts`（`/api/search` 记录支路）
- 边界登记：`docs/baseline/2026-09-13-m1-gate.md` §搜索边界、
  `docs/runbooks/deploy.md` 已知限制
