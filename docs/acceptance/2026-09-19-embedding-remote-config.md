# 语义检索（embedding）远端模型 API 配置补齐 · 验收记录

日期：2026-09-19 · 分支 `main` · 环境：本机 dev（api `127.0.0.1:3001`，`GX_M5_SEARCH=on`；web `localhost:5173`）

## 1. 补齐了什么

| 项 | 实现位置 | 口径 |
|---|---|---|
| provider（cloud / openai-compatible / self-hosted） | `packages/shared-types/src/api.ts` 的 `EmbeddingProviderKind` + `EMBEDDING_PROVIDER_PRESETS`；后端 `embeddingConfig.ts` `embedding.provider` 键 | 预设的「维度能否手填」是前后端**同一真源**（`providerAllowsManualDim`） |
| dimension 按形态放行 | `adminEmbeddingFields.ts` `applyProviderAndDim` | cloud 档出现 `dim` → 400「当前服务形态的维度由 model 元数据决定…」；自建/兼容档接受 1..4096；切回 cloud 自动清掉手填维度 |
| concurrency / retry | `embedding.concurrency` / `retry_max_attempts` / `retry_base_ms` | 真消费：`embedding/cloud.ts` 信号量用配置并发、重试循环用配置次数、`queryRuntime`/`reindexPump`/`adminStatus` 三处都把配置喂进 provider |
| 总门 db 覆盖键 | `search.enabled`（on/off/inherit）+ `searchGate.ts` | 检索接口请求期读覆盖值→即时生效；索引 worker 启动期决定→需重启；env=off 时路由未挂载→覆盖键救不回来，UI 红字明说 |
| 测试连接（加分） | `POST /admin/embedding/test-connection` + `embeddingProbe.ts` + 面板按钮 | 按已保存配置发单次探活（并发 1、不重试、超时钳 8s），不落库、不回凭据 |

## 2. 向后兼容怎么做的

- `parseEmbeddingProvider`：`undefined`/空串/未知值一律回 `cloud`——老库根本没有 `embedding.provider` 键，读配置绝不因缺字段失败。
- `resolveView` 读 provider：`db 键不存在 → 回 env 种子 → 再缺省 cloud`，与既有 cloud 行为逐字节一致。
- `dim` 字段此前是硬拒；现改为「按目标形态判定」，cloud 档语义不变（依旧不能改），老配置无需迁移。
- 未新增任何 Prisma 迁移（全部落在既有 `app_settings` 表）；apiKey 仍 AES-256-GCM，GET 只回 `configured/source/maskedLast4`。

## 3. 总门能否热切换（如实）

- **检索接口：能。** `routes/v1/search.ts` 在请求期 `loadSearchGateFlag`（10s TTL 缓存）。实测：覆盖值设 `off` → `/api/v1/search` 立刻 `404 统一检索未启用`；改回 `inherit` → 立刻恢复返回。
- **索引 worker：不能，需重启。** worker 只在启动期 spawn，`workerRuntime.ts` 读到 `off` 就不起。
- **env=off 时：两者都不行**，必须先改 `GX_M5_SEARCH` 并重启。
- 面板把这三条按行写死在「检索总门」分区里，不做点了没反应的假开关。

## 4. 真机结论（真浏览器，owner `test@gx.dev`）

1. 四项控件可见：服务形态下拉三档、并发数 / 重试次数 / 退避基数、检索总门覆盖值下拉、测试连接按钮。
2. 维度按形态：自建/兼容档出现「向量维度」输入框；切成「云端服务」后输入框消失，改为「由模型决定」只读提示。
3. 改值可存 + 刷新仍在：UI 存为 provider=self-hosted / dim=512 / 并发=12 / 重试=5 / 退避=800，刷新后逐项仍是新值（GET 配置第二证据一致）。
4. 非法值有明确校验：并发数 0 → 前端「并发数必须是 1..64 的整数」（未发请求）；后端 `dim:0` → 400「dim 必须是 1..4096 的整数」、`concurrency:0` → 400、cloud 档带 `dim` → 400。
5. 测试连接：密钥齐全时对本地探针端点返回「连接正常，返回维度 1024（耗时 13ms）」；密钥缺失返回「配置不完整，未发起连接」；**前后 GET 配置逐字节一致 → 探活不落库**。
6. 非 owner 整块不可见：侧栏分区只有 通用/通讯录/导航编排/MCP 接入/资产（无「语义检索」），直戳 `/workspace/settings/search` 回落到「通用」分区，管理端点返回 403「检索管理面仅工作区 owner 可用」。

## 5. 顺带修掉的缺陷

面板原 `useEffect([configQ.data])` 无条件用服务端数据回灌表单：改「检索总门」触发的失效重取会把刚填未存的并发/维度静默打回原值（表现为"改了没生效"）。现加 `dirtyRef`：任何一次手改都打标记，保存成功后才清，此后服务端数据才能覆盖表单。

## 6. 截图

`docs/acceptance/screenshots/nav-governance/`：`embedding-01-owner-config`、`embedding-02-cloud-dim-locked`、`embedding-04-saved-toast`、`embedding-05-after-reload`、`embedding-06-test-connection-ok`、`embedding-06-test-connection`、`embedding-07-invalid-validation`、`embedding-08-nonowner-hidden`、`embedding-09-nonowner-no-section`。
