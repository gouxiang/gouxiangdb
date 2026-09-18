# 门⑥ Docker 面：总监**亲自**复验记录（与 worker 证据分离登记）

- 日期：2026-09-18 12:2x　执行人：项目总监（本文件每一行都是我本机实跑的输出，不是转述）
- 目的：`072930a` 两份形态证据由执行 worker 自报；本文件是我用自己的眼睛打的补刀验，
  只验**能否独立复现的关键几格**，不重复它那 37 步构建表（那属于它的工作）。

## 1. 候选镜像确实存在

`docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}'` 实跑：

```
gouxiangdb:m7-final 965a891054f0 1.06GB
gouxiangdb:m7probe 378fc41fbcb9 1.06GB
gouxiangdb:ci-test  fd6e644c2dcc 1.01GB
```

（`m7probe` 的 `378fc41fbcb9` 与 arm64 证据文档记载的 ID 一致。）

## 2. 裸起会被生产配置闸门拦住（**正面证据**，不是缺陷）

不注入任何配置直接 `docker run`：

```
All migrations have been successfully applied.
[entrypoint] 迁移后导航 path 重算（nav-reconcile --apply）
[config] 启动配置校验失败，服务拒绝启动（退出码 2）：
  - JWT_SECRET: 生产环境必填（至少 16 位随机字符串），开发默认值不可用于生产
  - CORS_ORIGIN: 生产环境必填（逗号分隔的前端域名），禁止裸跨域放行
```

即 D3 配置闸门在容器形态真的生效：缺生产必配项时**拒绝启动**，而不是带着弱默认跑起来。

## 3. 注入配置后真的能服务，且 vec0 白名单真的就位

`docker run -d -p 3913:3001 -e JWT_SECRET=… -e CORS_ORIGIN=… gouxiangdb:m7-final`

```
=== healthz ===
200
=== readyz ===
{"status":"ready","service":"gouxiangdb-api","version":"0.1.0",
 "checks":{"dbPing":true,"dbWritable":true,"migrations":true,"uploadsWritable":true,"disk":true},
 "migration":{"applied":23,"latest":"20260918090000_mcp_pat_ddl"}}
```

容器内 vec0 原生：

```
/app/apps/api/native/linux-arm64/vec0.so
/app/apps/api/node_modules/.pnpm/sqlite-vec-linux-arm64@0.1.9/node_modules/sqlite-vec-linux-arm64/vec0.so
```

**这一格是全链路最值得钉死的**：`982af97` 修的就是 `copy-vec-native.mjs` 因相对 `--app-dir .`
导致 `createRequire` 抛错、又被 Dockerfile 的 `|| echo` 吞成"合法 fts-only 降级"，
于是 `native/<triplet>/vec0.so` **从来不生成**。现在 arm64 镜像里它真的在了。

## 4. 我没亲自复验的（不伪称验过）

- 完整 37 步构建（耗时长，采信 worker 证据 + 上面 §3 的产物面）
- §7.4 冒烟矩阵其余格（登录/记录/FTS/PAT/MCP/body 档/子路径）
- **x86_64 面、Caddy 真机反代、fnos fpk、Tauri 桌面手测** —— 均已派 be-deploy-adapter 在
  x86 VM（192.168.31.15）上补，跑不出就如实记【未实测】
