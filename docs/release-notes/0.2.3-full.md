# 构想工作台 v0.2.3 发版说明

- **版本号**：`0.2.3`（版本单一真源 = 根 `package.json` 的 `version`；运行时与 fpk `manifest.version`、esbuild `GX_VERSION` 同源，禁止硬编码）
- **展示名**：构想工作台（技术标识 `gouxiangdb`，仅包名/目录使用）
- **本轮主题**：**可扩展的应用版本更新机制**——应用内检查更新、安装包服务端代理下载、大包后台预缓存「本机秒取」、只读更新凭证的随包交付与升级自动刷新。
- **数据库迁移**：**本版本零新增迁移**，仍为 **40 枚**；rc/正式版之间也无迁移差异。升级不改动表结构。
- **发布日期**：2026-10-13（Gitea Release `v0.2.3`，tag `7881a88`）
- **安装包**：飞牛 x86_64 fpk `gouxiangdb-0.2.3-x86.fpk`（63,107,146 B，sha256 `e8dcb1f85716fe5020a176765cccaf3beb22f8bd91f11f877a72505765e121e2`）。

---

## 一、用户可见的变化（0.2.3 更新说明）

### 新增

- **应用内在线更新**：工作区所有者可在「工作区设置 → 系统更新」手动检查新版本、查看更新说明与安装包校验值，并一键下载与当前部署方式匹配的安装包，随后按页面图文指引在飞牛应用中心手动上传升级。
- **大包后台预下载（本机秒取，方案 A）**：发现新版本后可先点「后台预下载」，让 NAS 服务器在后台把安装包缓存到本机，面板实时显示进度；预下载完成后再点下载即从本地秒取，**不再受慢公网或飞牛 CGI 反代 30 秒硬超时影响**（解决此前 60MB 安装包在慢公网下经面板下载必 502 的问题）。
- 安装包下载经服务器统一代理，支持断点续传；下载链接为 **2 分钟内有效**的一次性安全票据（HMAC），**更新源访问令牌不会出现在浏览器、链接、URL query 或日志中**。
- 检查更新**不自动进行、无后台轮询/定时器**：唯一出网发生在所有者手动点击「检查更新」的瞬间。

### 改进

- 更新服务不可达 / 未配置 / 超时时，面板给出明确中文说明与重试入口，不再无响应或抛技术错误；上游错误体不透传给前端。
- 当前版本无法识别、部署方式未知等异常，在面板「当前环境」区域明确标注（version/channel/arch/platform）。
- 未配置任何 `GX_UPDATE_*` 时，存量部署行为零变化（更新分区隐藏、相关端点 404，等同未升级）。

### 修复（P0）

- **修复飞牛真机环境下升级后「检查更新」凭证可能不自动刷新的缺陷**：旧 `upgrade_callback` 只读 `${TRIM_APPDEST}/cmd/install_callback`，而 fnOS 1.2.0604 真机生命周期脚本实际落地在 `/var/apps/<app>/cmd/`，导致取不到新包内置令牌、静默不刷新，升级后无法再检测后续版本。新版改用 `${BASH_SOURCE[0]}` **脚本同目录自定位**（并保留两种历史布局回退），每次升级都能定点把新只读令牌同步进 `gouxiangdb.env` 的 `GX_UPDATE_TOKEN` 一行，`JWT_SECRET`/`DATABASE_URL` 等其它行逐字不动。（commit `7ecbfa0`）

---

## 二、质量门实数（2026-10-13，受管 Node v22，权威门 `scripts/ci-quality.sh`，VM15 复跑）

| 门 | 结果 |
|---|---|
| api 全量测试 | **3178 通过 / 0 失败 / 14 跳过** |
| web 测试 | **1717 通过 / 0 失败** |
| shared-types 测试 | **172 通过 / 0 失败** |
| canvas 测试 | **51 通过 / 0 失败** |
| 三包 `tsc --noEmit` | **0 错误** |
| eslint | **0 error**（web 仅历史 warning，低于卡控阈值） |
| 迁移干跑 | `prisma migrate deploy` 临时库 **40/40** 应用、`integrity_check=ok` |
| 生产构建 + 冒烟 | api/web build 成功，dist 产物 `/readyz` 五探针全 true |
| 零新第三方依赖 | 产品代码零新增依赖（测试缝 `__setUpdateRuntimeForTest` 仅 NODE_ENV=test 可用） |

> **门② AC-UPG-1 零损坏升级演练（v0.1.0 `637eb9d` → HEAD 直升）**：team-lead 在 VM15 独立整跑 `scripts/acceptance/run-upgrade-drill.sh` 终判 **`DRILL_VERDICT=PASS`**，22 个步骤 rc 全 0、REPORT 第 9 节八门全 PASS。核心七类零损坏 **PASS**（before/after 全表 0-diff、旧行时间戳零改动、uploads 树路径/size/sha 0 diff、附件引用不悬空、blocks round-trip、在线备份可恢复）；迁移两次幂等；nav-reconcile 51 条故障路径修复后二次幂等。扩展断言本轮按新权限模型/新默认对齐验收脚手架：自举固定期望（迁移动态计数=40、系统角色实测 7 枚）、黄金主体手工 12/12 + LCG 对拍 24/24、部门子树/继承中断/停用闭环全成立、FTS（chunks=3307、coverage 全 0、三态零泄漏、删库自愈）、body 双实例边界 8/8、旧分享链接矩阵 12/12。
>
> 演练在迁移与 nav-reconcile 之后、起服务之前，按运维手册 §6.7.1 顺序幂等补跑 `reconcile-policies --apply` 与 `project-scope --apply`（把 `role_library_scope` 存量展开进 `auth_policies` 的 `scope:role` 投影，补 17 行、主体仅 `role_admin`，二次运行 0 变化）。本轮另修复一个真实的**运维自检工具互斥**缺陷（commit `3b2d4c7`，产品码一处）：巡检工具的 A3「疑似手工污染」判据此前未豁免机器生成的 `scope:role` 投影，导致补账命令产出的 13 条表节点投影被恒定误报且修不掉；现 A3 只针对非 legacy、非机器投影的手工行，机器投影的正确性仍由 S 段 S1–S4 专管。该巡检仅由运维/通电 CLI 调用，**不在 HTTP 服务运行时路径，不改变 fpk 运行行为、无需重打已验真机包**。
>
> 已知运维接线遗留（不阻断本版，登记发版后处理）：三套自动升级链（裸机/Docker/飞牛 fpk）目前只接了 nav-reconcile，尚未自动执行上述 §6.7.1 两条补账命令。因统一检索总门 `GX_M5_SEARCH` 出厂默认 **off**、飞牛包未开启，库/表 CRUD（走 `role_library_scope`）与现行全局搜索（走成员表）都不依赖该投影，**默认安装客户升级后权限与搜索均正常**；仅当客户升级后再手动开启统一检索/MCP 时，需先按运维手册补跑一次 `project-scope --apply`（详见「升级须知」第 9 条）。

> 本轮还修复了 3 条**测试宿主平台耦合**用例（commit `eeec021`）：更新机制路由集成测试写死"本机=darwin"，在 Linux 宿主上误命中 linux/x64 资产而误红；改用测试缝显式注入部署身份后，macOS/Linux 双宿主结论一致。**纯测试改动，产品码无变化。**

---

## 三、真机 183 端到端实证（2026-10-13，飞牛 fnOS 1.2.0604 / x86）

从 `0.2.3-rc1` 升级到正式 `0.2.3` 并逐项验证：

| 项 | 结果 |
|---|---|
| 版本 / manifest / readyz | `0.2.3`，五探针（dbPing/dbWritable/migrations/uploadsWritable/disk）全 true |
| 数据零丢失 | users/bases/存活表 升级前后 = 1/2/1；迁移 40、integrity ok |
| 登录态不丢 | `JWT_SECRET` 指纹升级前后一致（重装沿用原 env，不重生成密钥） |
| 只读令牌 | 随包内置、升级后保留；指纹一致，真实连通 Gitea 检查更新 200 |
| P0-1 凭证刷新 | 新 `upgrade_callback`(4568B，含 BASH_SOURCE) 真机自定位命中，旧失效路径确认不存在 |
| 后台预缓存（方案 A） | 旁路内网源（伪装 0.2.4、63MB 真包）：POST prefetch `202`→running→**ready**，字节数/sha 与内容寻址落盘一致 |
| **本地秒取** | 票据下载 63MB 仅 **591ms（约 102 MiB/s）**，**下载窗口源站 .fpk 访问计数 = 0（零回源）**，sha 一致 |
| 票据 | 2 分钟 HMAC 票、正确返回 `attachment; filename=...`；未带票/伪造票/过期票均被拒 |
| 令牌紧急吊销 | 失效令牌 force check → `502 UPDATE_SOURCE_AUTH`「更新源凭证无效」（不崩溃、不透传上游）；还原后 200 |

> 演练用旁路 `static` 内网镜像 + 独立缓存目录，全程不碰真实数据/真实 Gitea；验证后 env 已完全还原（指纹对账基线）、演练缓存与临时文件已清。

---

## 四、配置项（全部可选；不配则更新机制默认开启但不影响存量行为）

解析在独立文件 `apps/api/src/configUpdate.ts`（11 项，不进生产 fail-closed 必填）。

| env | 默认 | 说明 |
|---|---|---|
| `GX_UPDATE_ENABLED` | `on`（精确小写 `off` 关） | 更新检查总开关。零轮询零后台出网；off 时两端口 404、面板分区隐藏 |
| `GX_UPDATE_SOURCE` | `gitea` | `gitea`=Gitea Release 资产；`static`=清单直链（可指客户内网镜像） |
| `GX_UPDATE_GITEA_BASE_URL` | `https://gitea0.hn.takin.cc` | Gitea 站点根，不带尾斜杠 |
| `GX_UPDATE_REPO` | `GouXiang/gouxiangdb` | owner/repo |
| `GX_UPDATE_MANIFEST_URL` | 空 | static 源清单直链，或 gitea 源下对清单地址的强制覆盖（内网镜像） |
| `GX_UPDATE_TOKEN` | 空 | 更新源**只读**凭证，仅服务端持有，永不下发浏览器/不进审计明文/日志/URL |
| `GX_UPDATE_CHANNEL` | 自动识别 | 通道显式覆盖（如 `fnos-fpk`），非法值忽略并 warn |
| `GX_UPDATE_ALLOW_PRERELEASE` | `off` | 精确小写 `on` 才纳入预发布 release |
| `GX_UPDATE_TIMEOUT_MS` | `8000` | 清单/元数据请求超时 |
| `GX_UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS` | `30000` | 下载代理**空闲**超时（非总时长；连续 30s 收不到字节才断） |
| `GX_UPDATE_CACHE_TTL_MS` | `300000` | 清单进程内缓存 5 分钟；`status?force=1` 旁路（仅 owner） |
| `GX_UPDATE_TICKET_TTL_MS` | `120000` | 下载票据有效期 2 分钟 |
| `GX_UPDATE_PREFETCH_ENABLED` | `on` | 方案 A 后台预缓存开关；off 时不注册 prefetch 路由、下载仍走上游代理 |
| `GX_UPDATE_PREFETCH_DIR` | `<dataDir>/update-cache` | 预缓存成品目录（内容寻址 `<sha256>.fpk` + `latest.json`） |

---

## 五、接口（均要求工作区所有者 owner；挂在现有 v1 路由）

| 方法/路径 | 作用 | 关键行为 |
|---|---|---|
| `GET /api/v1/admin/update/status?force=1` | 检查更新（唯一检查端点） | owner；force 旁路 5 分钟清单缓存；返回 current(version/channel/arch/platform)、update(可更新版本+artifact)、prefetch 快照 |
| `POST /api/v1/admin/update/prefetch` | 方案 A 后台预缓存 | 现场重算「有更新且资产存在」，否则 `409 UPDATE_NOT_AVAILABLE`；启动返回 `202`，已就绪幂等 `200`；状态机 idle/running/ready/failed |
| `POST /api/v1/admin/update/download-ticket` | 换 2 分钟下载票 | 现场重算，无可用更新 `409`；返回 ticket + downloadPath |
| `GET /api/v1/admin/update/download?ticket=…` | 仅验票的流式下载 | **本地缓存命中优先（方案 A 秒取）**，否则服务端代理上游（带 Authorization、断点续传、空闲超时） |

错误码：`UPDATE_SOURCE_UNCONFIGURED`（未配置源/凭证）、`UPDATE_SOURCE_AUTH`（凭证无效，等同紧急吊销现场表现）、`UPDATE_SOURCE_UNREACHABLE`、`UPDATE_SOURCE_TIMEOUT`、`UPDATE_MANIFEST_INVALID`、`UPDATE_NOT_AVAILABLE`。

---

## 六、只读更新凭证运维（要点，全文见 `docs/ops/update-token-runbook.md`）

- **双令牌严格分离**：随包内置的是**单仓只读 PAT**（构建机 `GX_READER_TOKEN` → 客户机落为 `GX_UPDATE_TOKEN`，仅 `GouXiang/gouxiangdb` Read）；发布用的是发布人本人 **write** PAT（`GX_GITEA_TOKEN`，仅发布脚本持有，绝不打进包）。
- 令牌只在请求头（`Authorization: token …`），**绝不进 git/日志/审计/错误/URL query**；仓库源模板只允许占位符 `__GX_UPDATE_TOKEN__`，由 `build-fpk.mjs` 在打包副本替换、打包后立即逐字节还原（开头有残留早检 fail-fast）。
- **轮换**：新旧 PAT 重叠一个发布周期，发布内置新令牌的版本，客户升级时 `upgrade_callback` 定点刷新 env，观察一周期后再吊销旧 PAT。
- **紧急吊销**：Gitea 删除该 PAT 即时生效，无需改客户机；最坏影响面仅限"能读该私有仓"，客户现场面板收到中性「更新源凭证无效，请联系部署人员」，不影响正常使用。

---

## 七、升级须知（重要）

1. **本版本零数据库迁移**（仍 40 枚），升级不改动表结构；飞牛安装升级包前平台仍会自动做一次在线备份，失败会中止升级。数据库与上传文件保存在共享存储 `gouxiangdb/data`，升级/卸载应用默认都不删除它们。
2. **建议升级前自行留一份备份**：产品内置在线快照（`scripts/backup/online-backup.mjs`，better-sqlite3 backup API）。升级回调先做在线快照、失败即中止，再跑迁移与 nav-reconcile。
3. **登录态**：fpk 升级保留原 `gouxiangdb.env`（含 `JWT_SECRET`），不会踢出已登录会话；请勿手工删除该 env。
4. **飞牛版本号判定注意（面向内部测试）**：飞牛按 fpk `manifest.version` 的数字段判定升级，**不识别 semver 预发布后缀**。因此测试机若装过 `x.y.z-rcN`，再装同基础号正式版 `x.y.z` 会被提示「已安装相同或更高版本」而拒绝覆盖。真实客户从更低正式版升级不受影响（数字段递增即正常识别为升级）；测试机遇此情况可「卸载（保留数据）后重装正式包」，数据与登录态保留。
5. **权限模型行为沿承（自 0.2.1 起的有意变更，非本版回归，特此公告）**：库可见性以「角色 × 库视野」（`role_library_scope`）为唯一裁决，升级迁移**只给超级管理员/管理员补存量库的库视野行，不对旧的逐库成员做猜测性放权**。因此从极旧版本升级后，历史上以「逐库成员(viewer/commenter/editor/creator)」身份加入的非管理员成员，需要管理员在「角色编辑器」里为相应角色逐库勾选库视野后才能在库列表看到/进入原库；其表/记录级内容动作投影仍在。新增成员请走角色授权。
6. **旧的「可编辑文档分享链接」升级后退回只读（有意安全收紧）**：早于 shareCreatedBy 字段版本创建的可编辑分享，因 sharerId 为空被一律按只读处理，以消灭无法降级的残留匿名写通道；需要继续开放编辑的，请在升级后重新创建该文档的可编辑分享链接。
7. **健康检查**：升级后确认 `/healthz` 与 `/readyz`（含迁移对账/磁盘/WAL/uploads 探针）。
8. Node **22 为硬要求**（飞牛 `nodejs_v22`；better-sqlite3 13 的 NAPI 档位在 Node 20 会 SIGSEGV）。子路径部署鉴权头沿用 `X-GX-Token`（飞牛 CGI 网关会吞 `Authorization`），服务端两者都收。
9. **统一检索/MCP 的存量权限投影（仅在你要开启该功能时才需要）**：库/表增删改查与现行全局搜索升级后即正常，无需任何操作。若你计划在升级后**手动开启统一语义检索（`GX_M5_SEARCH=on`）或 MCP 检索工具**，请在开启前于 `apps/api` 目录按顺序幂等执行一次 `node/tsx scripts/authz/reconcile-policies.ts --apply` 再 `… project-scope.ts --apply`（依据运维手册 §6.7.1，把存量「角色×库视野」展开进检索授权投影；二次运行为 0 变化、安全可重复）。不开该功能则可忽略本条；后续版本会把这一步自动接入升级流程。

---

## 八、已知限制

- arm64 fpk / Docker / 裸机 tar / Tauri 桌面：本轮未逐一实测（x86 飞牛 fpk 已实证）；需要时另行构建验收。
- 更新面板的最后一步仍是「下载 fpk → 在飞牛应用中心手动安装」（飞牛三方应用不开放免人工的自升级通道）；本机制解决的是"找到对的包 + 稳定快速地把包取到本机"。
- 只读 PAT 物理上仍能读私有仓源码（Gitea 单仓协作者 PAT 限制，已接受的残余风险，靠"可随时吊销"兜底）。
- 无通用附件托管/下载通道（全仓上传端点仅 `POST /me/avatar`），附件仍是记录 fields JSON 内引用 + 静态落 `uploads/at/`。

---

## 九、相关文件

| 想找什么 | 去哪 |
|---|---|
| 更新机制设计依据 | `docs/design/2026-10-app-update/DESIGN.md`（§5.3 配置、§6 接口、§8 发布/令牌） |
| 用户向更新说明 | `docs/release-notes/0.2.3.md` |
| 令牌运维手册 | `docs/ops/update-token-runbook.md` |
| 后端更新域 | `apps/api/src/domain/update/`（service/sourceGitea/sourceStatic/prefetch/download/manifest） |
| 配置解析 | `apps/api/src/configUpdate.ts` |
| 路由 | `apps/api/src/routes/v1/adminUpdate.ts`、`adminUpdateDownload.ts`、`serveLocalArtifact.ts` |
| fpk 打包/令牌注入 | `deploy/fnos/build-fpk.mjs`、`deploy/fnos/gouxiangdb/cmd/{install,upgrade}_callback` |
| 发布脚本 | `scripts/release/publish-gitea-release.mjs` |
| 部署/升级细则 | `docs/deployment/` |

---
---

# （历史）构想工作台 v0.2.1 发版说明

> 以下为 v0.2.1 当时的原始记录，保留作历史追溯；版本/迁移/测试数字已被上方 0.2.3 口径取代（当前 40 枚迁移、api 3178 测试等）。

- **展示名**：构想工作台（技术标识 `gouxiangdb` / `gouxiangdb-v2`）。M0–M6 全部收口，六项产品需求（响应式 / 表级权限 / 视图管理员 / 层级视图甘特 / 多模态语义检索 / MCP 全功能）代码完成。
- **权限真实口径**：执法唯一＝M4 统一权限引擎（`engine.decide()`，读 `auth_policies` + `nav_nodes`），永久、无条件、唯一生效（ADR-0057）；引擎抛错 503 fail-closed，资源无活 nav 节点 403。第一代旧三表仅台账、不参与放行。
- **当时复验实数（HEAD `138933f`）**：api 2986 通过/0 失败/14 skip；web 1636 / shared 103 / canvas 51；三包 tsc 0、eslint 0 error；迁移 40。
- **MCP 工具总数 28**；飞牛 x86 fpk、五档响应式真机验收通过。
- 更早的 v0.1.x（含 0.1.7 七项需求明细、UI 重构、帮助中心、图标颜色、分享链接修复等）详见 git 历史与 `docs/` 下对应验收记录，本文件不再展开。
