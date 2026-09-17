# ADR-0045：embedding 默认仅远端——cloud/off 两态半，local 为未来可选 provider

**状态（Status）**：Accepted（依据 PLAN-ADJUST-nas-min-hardware §4，2026-09-12，记录主理人原话「向量暂不考虑本地模型、仅远端 API」；M5 计划 §11 第 4 条 :710、§15 Q1/Q3/Q5/Q6 定稿；2026-09-17 M5 出口归档）
**作者**：架构师 高见远（M5-S14 归档；实现由后端 贝洛奇 落地）
**上游依据**：M5-implementation-plan.md §4.4（:351-386）、§11（:710）、§15 Q1/Q3/Q5/Q6（:748-753）；PLAN-ADJUST-nas-min-hardware.md §4
**关联**：ADR-0044（vec0 唯一原生面与降级）；ADR-0050（cloud 凭据与供应链边界）；ADR-0042（独立 search.db）

---

## 1. 背景（Context）

embedding 来源在 M5 设计早期有 cloud/local/off 三选项。本地推理意味着在 NAS/
裸机上引入 onnxruntime-node 或 @huggingface/transformers、模型权重分发、
postinstall 拉二进制、Worker Thread 推理调度与离线校验/版本钉死，原生运行时
面与供应链显著膨胀。主理人 2026-09-12 在最低硬件裁决中明确：「向量暂不考虑
本地模型、仅远端 API」（PLAN-ADJUST §4）。Q1 终审据此裁决**回归 cloud/off**，
取消 local 片（本期不做，非 spike-gated），切片 16->15。

## 2. 决策（Decision）

### 2.1 本期只有 cloud / off 两态半，不做 local

- `EmbeddingMode = "off" | "cloud"`（类型上不声明 "local"）。
- **本期不引入** @huggingface/transformers、onnxruntime-node、任何模型权重
  文件、Worker Thread 本地推理；原生运行时面**只有 sqlite-vec**（ADR-0044）。
  因此无模型分发、无 onnx postinstall 拉二进制、无离线校验/版本钉死事项
  （PLAN-ADJUST §4.2 删除项）；本期**不存在** `embedding/local.ts` /
  `embedding/local.worker.ts` / 模型投放脚本。

### 2.2 off 是出厂默认，零外网

切 on 后 `GX_EMBEDDING_MODE` 出厂默认 `off`，未知值保守回 off。off provider
不加载任何网络/原生资源，`embed()` 不被调用（worker 跳过向量步），检索 =
FTS/LIKE。off 态与 `GX_M5_SEARCH=off` 态全程零外联有抓包留证（S12，见
ADR-0050 供应链边界与 runbook）。存量用户升级后不建向量、不出网。

### 2.3 cloud 锁 OpenAI 兼容 `/v1/embeddings` 单一契约

- 唯一契约：`POST ${baseURL}/v1/embeddings`，Bearer，
  `{model,input:[...],encoding_format:"float"}`，按 `data[].index` 对齐回序；
  baseURL 任意 OpenAI 兼容端、自带 /v1 归一。
- 用全局 `fetch`，**无 SDK、无专用 vendor adapter、不做非兼容供应商适配**。
- **不暴露 dimensions / MRL**：dim 由 model 元数据决定（首次成功 embed 的
  返回长度落 `index_meta.embedding_dim`），降维靠选模型，MVP 不做运行时维度
  参数。
- 网络错/5xx/超时指数退避（3 次，基数 1s），4xx 不重试；401/403 置
  unhealthy；信号量限流 + AbortController 超时；空文本不调用，单条超 ~8000
  字符在抽文本层截断。
- cloud **无默认 model，必须显式配置**；启用必须管理员显式配置 + 二次确认
  （`confirmCloud:true`，否则 409 NEED_CLOUD_CONFIRM，该步本身零出网）。

### 2.4 local 仅留接口未来位（加本地无需重构）

`EmbeddingProvider` 接口（domain/search/embedding/types.ts）按 ARCH §7.2
保留 `LocalEmbeddingProvider` 未来位：接口/search.db schema/RRF/scope 收敛
均不随来源变化。未来加 local = 新增一个 provider 实现文件 +
optionalDependencies 并 opt-in，**接口/search.db/RRF/权限收敛零改动，无需
重构**；`dispose?()` 已预留给未来 Local provider 终止 Worker（cloud/off 为
no-op）。

### 2.5 dim 随 model，变更强制两步 reindex

dim 取首响应长度，非管理员配置项（设置面板无 dim 输入，状态页只读展示）。
model 变更导致首响应 dim 与旧库不符即 `dim_mismatch`，拒向量路、回 FTS/LIKE
并提示 reindexRequired；PATCH config 改 mode/model **不自动重建**（拒绝请求
体 `reindex:true`，400 EMBEDDING_CONFIG_INVALID），须管理员显式再调 reindex
（两步走，见 ADR-0049）。

## 3. 被否决的备选

1. **本期本地推理（onnx/transformers + 权重 + Worker）**：违反主理人
  2026-09-12 裁决；原生面/分发/离线校验成本与低端 NAS 不相称；Q3 判 moot，
  相关分发事项全部移除。
2. **三态（cloud/local/off）本期全开**：local 未做却进联合类型会造成半接线
   状态；定稿类型只两态，local 留实现位而非联合成员。
3. **多家供应商专用 adapter / 引入 SDK**：供应链与适配面扩大；OpenAI 兼容
   单一契约 + 全局 fetch 已覆盖兼容端。
4. **暴露 dimensions/MRL 运行时降维**：增加矩阵复杂度与 dim 不一致风险；
   MVP 以选模型控维。

## 4. 后果（Consequences）

- 默认部署零模型权重、零本地推理依赖、零外网；唯一原生供应链是 sqlite-vec
  平台包（ADR-0050）。
- cloud 下向量仍**本地 KNN**（数据出域仅限 embedding 文本，经二次确认）；
  扫描/存储真机门保留（ADR-0044）。
- 未来加 local 是纯增量（新 provider + optionalDependencies + opt-in），
  不动既有接口与派生 schema。
- cloud 故障期 FTS 照常服役、向量欠账恢复后补齐（ADR-0043）。

## 5. 验证证据

- 裁决依据：PLAN-ADJUST-nas-min-hardware.md §4（2026-09-12 主理人原话）；
  M5 计划 §15 Q1（回归 cloud/off）、Q3（local moot）、Q5（单一契约）、
  Q6（两层门）。
- 实现：domain/search/embedding/{types,cloud,off}.ts、embeddingConfig.ts；
  types.ts 保留 LocalEmbeddingProvider 未来位注释。
- 零外网：M5-S12 AC-M5-5 抓包/拦截 fetch 双证据；docs/runbooks/m5-search.md
  §2（off->cloud 二次确认、唯一 baseURL 方向流量）。
- dim 两步：M5 计划 §5.4；S9 openapi 中无 dim 写入口、status 只读 dim。
