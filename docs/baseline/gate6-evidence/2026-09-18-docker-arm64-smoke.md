# 门⑥ Docker 容器冒烟证据（linux/arm64 原生）

- 日期：2026-09-18　执行人：项目总监（独立复验，非 worker 自报）
- 镜像：`gouxiangdb:m7probe`　ID `sha256:378fc41fbcb9`　Arch=arm64 OS=linux　Size 260635537（~261MB）
- 构建机：Apple Silicon（Docker Desktop linux/arm64 原生，非仿真）；Docker 29.2.1，**无 buildx**，仅单架构 amd64 CLI→实际 arm64 原生
- 修复提交：`982af97`（Step16 内联 node -e 抽独立脚本；copy-vec-native 相对路径 createRequire 崩溃 + 去 `|| echo` 吞错）
- 37/37 步全过；23 条迁移；三入口 dist/index.js(865KB)/mcp-stdio.js(430KB)/nav-reconcile.js(52KB)

## §7.4 冒烟矩阵（容器形态，默认发布姿态 ORG=on NAV=on AUTHZ=off EMBEDDING=off）

| 格 | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 健康 | /healthz 200；/readyz 五探针全 true | PASS | applied=23 latest=20260918090000；版本四端点单源 0.1.0 |
| 2 迁移 | 空库 deploy=23；二次重启幂等 | PASS | 重启后 "No pending migrations to apply"，applied 恒 23 |
| 3 核心链路 | 登录→建表→建记录→hydration→FTS→文档→画布→分享无痕 | PASS 7/7 | hydration 2 行+数值42回读；off态 /api/search 命中锚点；画布 JSON 读回 smoke_e1；匿名 /s/ 200、未分享 401 |
| 4a 企业 | org/nav 挂载；PAT；MCP initialize/tools/list 只读 | PASS 8/8 | serverInfo=gouxiangdb-mcp 0.1.0；只读 PAT 工具恰 7 个只读、写工具 0（双闸门）；/mcp 未认证 401 |
| 4b body档 | /mcp 2MB→200；/api 1.1MB→413 | PASS 3/3 | 11MB mcp 档放行 ping_echo(HTTP200)；1MB json 档 PAYLOAD_TOO_LARGE；小载荷不被误拦 |
| 5 降级 | 改名 vec0.so→重启 | PASS | 容器 healthy、readyz 全绿、无 vec 致命日志；FTS 仍命中、记录可读；另容器内 vec0 loadExtension OK+KNN rowid1 distance0+vec_version v0.1.9 |
| 6 R1 | GX_ENTERPRISE_ORG=off 独立容器(3002) | PASS 6/6 | 旧 auth/signup/login/healthz 存活；/api/v1/org、/api/v1/pats、/mcp 整面 404；23 迁移仍 apply（表保留无害） |
| 8 安全 | 安全头/错误信封/审计/PAT零泄漏 | PASS | 6 安全头齐（无CSP/HSTS 符设计）；404/401 信封无栈；audit.logl 640；PAT 库存 tokenPrefix(14)+tokenHash(sha256,64)，/data 与 stdout 明文零命中；镜像 ENV 无 JWT_SECRET |
| 子路径 | GX_BASE_PATH=/app/gouxiangdb 容器(3003) | PASS 5/5 + 静态 | {base}/api signup/login/PAT、{base}/mcp initialize200+tools/list；根副本 /assets、favicon、SPA 深路由 fallback 全 200 |

## 未实测（按 §6.2/§10.2 预批降级，不补编）

- **amd64 镜像 / buildx 双架构**：本机无 buildx、单 arm64 原生；标【未实测】，目标 x86 机签字。
- **Caddy 真机反代 + /mcp initialize**：docker.io 不可达（i/o timeout）拉不到 caddy 镜像、本地无 nginx/caddy。
  Caddyfile 静态已审计（:21 含 /mcp matcher；:37-39 request_body max_size 12MB > 11MB mcp 档）；直连 11MB 档已实测，反代一跳标目标机签字。
- **格6 R8 代码回滚（symlink 切换）**：属裸机 systemd 形态，门③已自动化覆盖 R1-R7 + R8/R9 手测模板。
- **格7 macOS tar 直跑 / 旧 Tauri 桌面端连新服务**：见 tar 形态证据（另文件）；Tauri UI 手测属签字项。
- **fnos fpk（x86/arm 真机）**：目标机不可达，标【未实测】。
