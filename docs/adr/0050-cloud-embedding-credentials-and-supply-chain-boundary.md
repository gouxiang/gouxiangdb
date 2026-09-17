# ADR-0050：cloud embedding 凭据管理与供应链边界

**状态（Status）**：Accepted（M5 计划 §11 第 9 条、§4.4 凭据存储/§9 管理端点/§12 原生供应链定稿；S4/S9/S12 已过加密、轮换回落与零外网门；2026-09-17 M5 出口归档）
**作者**：架构师 高见远（M5-S14 归档；实现由后端 贝洛奇 落地）
**上游依据**：M5-implementation-plan.md §4.4（凭据 :386）、§9（管理端/审计 :690-691）、§12（供应链/CI :719-725）、§11（:715）、§15 Q5/Q6
**关联**：ADR-0045（cloud/off 两态、OpenAI 兼容单一契约）；ADR-0044（sqlite-vec 唯一原生面、glibc/非 musl）；ADR-0041（组织动作清单、不新增动作位）；ADR-0010（主库离线 age 加密的密钥边界区分）

---

## 1. 背景（Context）

启用 cloud embedding 需要管理员配置第三方兼容端的 API key。该密钥是 M5 唯一
新增的"对外出域凭据"，必须回答：怎么存（不能明文落库/进日志/进响应）、谁能
管（复用既有组织角色还是新增动作）、密钥轮换（尤其 JWT_SECRET 变更）后系统
会不会崩、以及整个 M5 到底往原生/网络供应链里引入了什么。约束基线是零新增
重型依赖、出厂零外网、唯一原生面为 sqlite-vec。

## 2. 决策（Decision）

### 2.1 apiKey AES-256-GCM，由 JWT_SECRET 派生密钥

- 算法 **AES-256-GCM**（node:crypto 内置，**零新依赖**）：随机 IV，库存
  `iv / tag / ciphertext`，落主库 `app_settings`（迁移 #21 建的 KV 表）。
- 数据密钥派生：`key = SHA-256(JWT_SECRET || "embedding-v1")`——复用既有
  JWT_SECRET 作为本机秘密，不引入第二套主密钥管理。
- env（`GX_EMBEDDING_API_KEY`）只作只读首启种子；管理员 PATCH/rotate 落加密
  后的 app_settings。

### 2.2 只回显存在性 + 末 4；轮换/清除；轮换后解密失败不 500

- GET/status 只回 `{ configured:boolean, source:env|db|none,
  maskedLast4:string }`，**任何响应/日志/审计都不返回明文或全文**。
- 提供独立 **rotate**（写新密文）与 **clear/DELETE**（清除）端点；审计事件
  `embedding_api_key_rotated` / `embedding_api_key_cleared` 只记动作、脱敏、
  无 key 值。
- **JWT_SECRET 轮换后旧密文解密失败：回落 `configured:false`，不抛 500**
  （S4 验收项）——系统降级为"未配置 cloud key"，FTS/LIKE 正常服役，管理员
  重新 rotate 即可恢复，绝不能因解不开凭据让启动/检索失败。

### 2.3 单一 OpenAI 兼容契约：无 SDK、无 vendor adapter

cloud 侧唯一外联是 `POST ${baseURL}/v1/embeddings`（Bearer，
encoding_format:"float"），用全局 fetch；**不引入任何云厂商 SDK，不做非兼容
供应商 adapter，不暴露 dimensions/MRL**。baseURL 指向任意 OpenAI 兼容端；
所有外联只朝配置的 baseURL host，无 telemetry/analytics/CDN/第三方方向流量。
cloud 出网必须管理员显式配置 + 二次确认（`confirmCloud:true`，否则
409 NEED_CLOUD_CONFIRM，该步本身零出网）。

### 2.4 管理端点 role_owner 限定，不新增 manage_search 动作

- 六枚管理端点（reindex、search/status、embedding config get/patch、
  api-key rotate、api-key clear）限 **role_owner**，复用 M2/M4 既有
  hasOrgAction/effective 设施与 `requireOrgAction` 语义。
- **不新增 `manage_search` 组织动作**（ADR-0041：新增动作要过八项清单 + owner
  幂等迁移；M5 无此必要）。语义搜索管理视为工作区 owner 的安装期配置，不向
  自定义角色下放。
- 审计事件（只增、脱敏、无 key 值）：`search_reindex_started/done/failed`、
  `embedding_config_changed`、`embedding_api_key_rotated/cleared`、
  `search_degraded`（状态降级跳变时采样）。

### 2.5 供应链边界：唯一原生面 sqlite-vec，bookworm/非 musl；无本地推理链

- **唯一原生供应链** = sqlite-vec 0.1.9 平台 optionalDependencies 子包 +
  投放的 `vec0.<ext>`（文件名恒 vec0）：
  - 构建显式拷 `native/<triplet>/vec0.<ext>` 到白名单产物 + `file` 架构自检；
    运行时 resolveVecPath 按 platform/arch（必要时判 libc）拼绝对路径，
    `GX_VEC_EXT_PATH` 可覆盖。
  - Docker 基准 **node:22-bookworm-slim（glibc：vec0 x64 ≤2.14 / arm64
    ≤2.17）**；runbook **禁 alpine/musl（vec0 无 musl 版）**，musl 只做静态
    文档论证、不跑 alpine 镜像。
  - fpk 基准 `${TRIM_APPDEST}/server/native/<triplet>/vec0.so`（目录 0755 /
    文件 0644）。
- **无本地推理供应链**：不引入 transformers/onnxruntime/模型权重，故无
  postinstall 拉二进制、无模型分发/离线校验/版本钉死（ADR-0045）。
- CI：平台中立 Linux 常规质量门 +(a) darwin 本机 vec0 load+1 KNN，(b) buildx
  linux/amd64 与 linux/arm64 目标平台内安装冒烟 vec_version+1 KNN（发版门），
  (c) 故意缺 .so -> 启动正常降级断言，(d) musl 仅文档论证，(e) **off 零外网
  抓包断言**（代理见零外联记录）。
- 不依赖客户机装 sqlite3/age；扩展投放失败不阻断主服务启动（降级，
  ADR-0044）。

## 3. 被否决的备选

1. **apiKey 明文落 app_settings / 回显全文**：库文件/备份/日志泄漏即泄密；
   定稿 AES-256-GCM + 仅存在性与末 4。
2. **新引一套独立主密钥/KMS**：MVP 单机部署无 KMS，徒增密钥管理面；复用
   JWT_SECRET 派生即可，并接受"JWT_SECRET 轮换后需重新配置 key"的明确回落
   语义（configured:false，不 500）。
3. **新增 manage_search 动作下放自定义角色**：要过 ADR-0041 八项清单 + owner
   迁移，M5 无下放需求；定稿 role_owner 限定。
4. **引入云 SDK / 多家 vendor adapter**：供应链与出网面扩大；OpenAI 兼容
   单一契约 + 全局 fetch 足够。
5. **alpine/musl 作为部署基准**：vec0 无 musl 构建；定稿 bookworm/glibc。
6. **随 M5 引入本地推理依赖**：违反主理人 2026-09-12 裁决（ADR-0045），原生
   面扩大到模型权重/onnx；定稿唯一原生面 sqlite-vec。

## 4. 后果（Consequences）

- 密钥静态加密、最小回显、轮换/清除可审计；JWT_SECRET 轮换不会导致服务故障，
  只要求重配 cloud key（须在运维文档明示此绑定）。
- cloud 出网面收敛为单一可配置 host + 单一路径，便于出网白名单/抓包核验；
  出厂与 off 态零外网有自动 + 人工双证据。
- 自定义角色无法管理语义检索（仅 owner），与"安装期基础设施配置"定位一致。
- 平台支持以 glibc x86_64/arm64 为主：arm64 有 CI 交叉构建冒烟但**性能未做
  真机实测**（ADR-0044 §3.6）；musl 用户纯 FTS 降级，文档明示不支持向量路。

## 5. 验证证据

- 凭据加密/轮换回落：M5-S4（cloud/off provider、embeddingConfig
  AES-256-GCM、JWT_SECRET 变更解密失败 configured:false 不 500、GET 仅
  configured/source/maskedLast4）。
- 管理端点/契约：M5-S9 六端点 + openapi 冻结（role_owner、409/400、
  reindexRequired）。
- 零外网：M5-S12 AC-M5-5（fail-closed fetch 拦截用例 A/C + 人工 mitm/抓包：
  off 零出站 SYN、无 confirmCloud 改 cloud 得 409 且零连接、启用后仅 baseURL
  host 的 POST /v1/embeddings）；docs/runbooks/m5-search.md §2。
- 原生供应链：spike-sqlite-vec.md §5（平台子包/vec0 文件名 dlsym 坑）；
  M5 计划 §12（bookworm/非 musl/CI 矩阵/fpk 权限）。
- 角色边界：ADR-0041（不新增动作位的复用义务）；M5 计划 §9（:690 role_owner）。
