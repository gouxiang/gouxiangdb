# 门⑥ 裸机 tar 发布物冒烟证据（macOS arm64 本机直跑）

- 日期：2026-09-18　执行人：项目总监（独立复验）
- 打包：`node deploy/bin/package-release.mjs` → `release/gouxiangdb-release-0.1.0-20260918035748.tar.gz`（56MB）
- 校验：checksums.txt 4163 文件 `shasum -a 256 -c` **0 失败**；禁带扫描通过（无 .env/*.db*/.log/.workbuddy）
- 投递模拟：tar 解压到干净 `/tmp/gxtar`（顶层 api/web/checksums.txt），独立 `/tmp/gxtar-data`，受管 node 22.22.2 直跑 dist（dev-up 等价）
- 产物：dist 三入口 index.js(880KB)/mcp-stdio.js(431KB)/nav-reconcile.js(52KB)；web/index.html；node_modules 仅生产；prisma client 已 generate

## 启动序列（等价 deploy.sh）

1. `prisma migrate deploy`（独立 data）→ 23 迁移 "All migrations successfully applied"
2. `dist/nav-reconcile.js --apply` → 空库 A=B=C=0 no changes
3. `node dist/index.js` PORT=3010 + 独立 GX_DATA_DIR/DATABASE_URL/GX_WEB_DIST → authz effective=off，/healthz 200 version 0.1.0

## §7.4 冒烟矩阵（tar 形态，默认发布姿态）

| 格 | 项 | 结果 |
|---|---|---|
| 1 健康 | /healthz 200；启动 env 注入正确（web 指向发布物 /tmp/gxtar/web） | PASS |
| 3 核心链路 | 登录→建表→记录→hydration(数值42回读)→off态FTS命中→文档→画布JSON读回→分享无痕+未分享401 | PASS 7/7 |
| 4a 企业 | org/nav 200；/mcp 未认证 401；只读 PAT；initialize serverInfo=gouxiangdb-mcp 0.1.0；tools/list 恰 7 只读、写工具 0 | PASS 8/8 |
| 4b body档 | /mcp 2MB→200；/api 1.1MB→413 PAYLOAD_TOO_LARGE；小载荷非413 | PASS 3/3 |
| 5/7 降级 | 发布姿态 embedding=off，vec0 非启动依赖（启动不 load）；主应用与 FTS 不依赖向量扩展；on 态五故障→fts-only 自愈由 M5-S12 ac-m5-1.degrade 测试组在 G0 覆盖 | 发布姿态 PASS（on 态见测试组，非部署冒烟重放） |
| vec0 原生 | `native/darwin-arm64/vec0.dylib`（file 自检 Mach-O arm64）loadExtension OK + KNN rowid1 distance0 + vec_version v0.1.9 | PASS（第二平台原生链路） |
| 优雅关闭 | SIGTERM → 日志"收到 SIGTERM，开始优雅关闭"，进程干净退出（5f2455b TCP disconnect 修复在 tar 形态坐实） | PASS |

与 Docker arm64 逐格结果一致（跨两部署形态复现）。

## 未实测（目标机/真机签字项，不补编）

- 旧 Tauri 桌面端连新服务端"升级提示、不白屏/死连"（SPEC:133）：需桌面 UI 手测，标【未实测】。
- Linux x86 裸机直跑 / vec0 linux-x64 原生：无 x86 目标机，标【未实测】（Docker arm64 已覆盖 Linux 内核族应用行为）。
- deploy.sh / rollback.sh symlink 原子切换在 systemd 真机：门③ R8/R9 手测模板 + 目标机签字。
