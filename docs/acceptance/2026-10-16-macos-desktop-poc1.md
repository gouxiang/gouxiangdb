# macOS 桌面 App PoC-1 验收报告：带原生模块的 Node sidecar 在干净 .app 里起来并建库

- 日期：2026-10-16
- 对应设计：`docs/design/2026-10-node-mode/DESIGN-MACOS-APP.md` §15 PoC-1、§5 原生依赖投递
- 分支：`feat/macos-desktop-d0`（spike，独立于 0.2.5 主线；默认不进 web/api/fpk 四门）
- 范围：仅 PoC-1。PoC-2（WebView 同源 CORS/WS）、PoC-3（无签名一键更新）另出报告。
- 结论：**通过 ✅**。五条验收全部在本机（macOS 27.01 / Apple Silicon / 系统 PATH 无 node）以随包 Node 实跑达成。

---

## 1. 环境与产物

- 机：Darwin arm64（Apple Silicon），macOS 27.01；`PATH=/usr/bin:/bin` 下 `node not found`（验证目标机零 Node 假设）。
- 工具链：Homebrew Rust 1.93.1（无 rustup）、Tauri CLI 2.12.3（装在受管 node workspace，不进项目依赖图）、官方 `node-v22.22.2-darwin-arm64` 单二进制作 sidecar。
- 壳：`apps/desktop/src-tauri`（Tauri v2，`tauri-plugin-shell = =2.2.1` 钉无漏洞版）。
- 组装脚本：`apps/desktop/scripts/stage-node-sidecar.mjs`（hoisted 生产依赖 + 三原生件 arm64 硬检 + 随包 Node 真建库冒烟）。
- 产物：`构想工作台.app`，**374.92 MiB**，ad-hoc 签名（`Signature=adhoc`，`Mach-O thin (arm64)`，无 TeamIdentifier）。
- 数据目录：`~/Library/Application Support/cc.gouxiang.desktop/`（`dev.db`、`.jwt-secret`、`.audit/`、`uploads/`、冷备 `dev.db.<ts>.bak`）。

## 2. 五条验收逐条结果

### ① sidecar 起 HTTP，/readyz 五探针全绿 —— 通过
`.app` 双击启动后，随包 `gxnode-aarch64-apple-darwin` 被 Rust 拉起，**只监听回环随机端口**：
```
gxnode ... TCP 127.0.0.1:58278 (LISTEN)        # lsof 实证，不绑 0.0.0.0/不对局域网
GET /readyz -> {"status":"ready","version":"0.2.5",
  "checks":{"dbPing":true,"dbWritable":true,"migrations":true,
            "uploadsWritable":true,"disk":true},
  "migration":{"applied":42,"latest":"20261015122228_sync_server_foundation"}}
```

### ② 自动建库 / nav-reconcile / init-admin 幂等 —— 通过
- **建库**：用随包 Node + 随包 prisma CLI/schema-engine 对全新空库 `migrate deploy`，**42 枚迁移全部 applied**，生成 `dev.db`（765,952 B）；全程不依赖系统 Node/网络。
- **启动序列**（Rust `main.rs`，与飞牛 install/upgrade 回调同序）：冷备 → migrate deploy → `nav-reconcile.js --apply` → 选回环端口 → 起 `dist/index.js`。最新包日志：`nav-reconcile --apply ok`（退出 0）。空库 `nav_nodes` 为 0 属正确（reconcile 只重算已有节点 path，不凭空造节点）。
- **init-admin 幂等**（随包 Node 在临时空库实测）：首次创建 owner 并标记首登强制改密；第二次输出「已初始化，跳过（users 表已有 1 个用户）」，users 恒为 1。桌面首启管理员引导走 WebView 现有页面（设计 §4.3 推荐），Rust 不另造表单。

### ③ 写记录 + sqlite-vec loadExtension + vec0 虚拟表 —— 通过
随包 Node 加载**包内** `better-sqlite3` 与 `native/darwin-arm64/vec0.dylib`（脚本 `/tmp/gx-poc1-vec.mjs`，不入库）：
```
普通表 INSERT 读回 OK（changes=1）
db.loadExtension(vec0.dylib) -> vec_version() = v0.1.9
CREATE VIRTUAL TABLE v USING vec0(embedding float[4])；插 3 行
KNN: [{rowid:1,distance:0},{rowid:3,distance:0.14142136}]   # 最近邻正确
```

### ④ file/otool 所有原生件 arm64、无构建机绝对路径依赖 —— 通过
组装脚本硬门槛逐件 `file` 校验：随包 Node、`better-sqlite3/prebuilds/darwin-arm64.node`、`@prisma/engines/libquery_engine-darwin-arm64.dylib.node`、`schema-engine-darwin-arm64`、`native/darwin-arm64/vec0.dylib`，**全部 `Mach-O ... arm64`**。`otool -L vec0.dylib` 依赖仅 `dist/vec0.dylib`（相对）+ `/usr/lib/libSystem.B.dylib`（系统），无指向构建机的绝对路径。node_modules hoisted、**符号链接 0 个**（.bin 已实体化）。

### ⑤ ad-hoc 签名后首次可运行、不被立即 kill —— 通过
本地构建产物**无 `com.apple.quarantine` 属性**，`open` 直接运行，未被 Gatekeeper kill；壳与 sidecar 均稳定常驻直到主动退出。
> 注：双击分发（经 AirDrop/浏览器下载）会带 quarantine，无公证时需「右键→打开」或 `xattr -dr`，属 PoC-3 与 D5 runbook 范围。

## 3. 关键工程结论 / 踩坑（回写设计用）

1. **最小后端增量已落地**：新增可选 env `GX_BIND_HOST`（`apps/api/src/config.ts` 可选适配区 + `index.ts` `server.listen(port, bindHost)`）。默认 `0.0.0.0`，与裸机/容器/飞牛逐字节一致；桌面显式传 `127.0.0.1`。additive，不进生产必填校验。
2. **退出收尸必须挂 `RunEvent::Exit`**：`osascript quit`/Cmd+Q 在 Tauri 里不触发可拦截的 `ExitRequested`（直接到 `Exit`），只挂窗口 `CloseRequested` 会留孤儿 node。现实现：`ExitRequested` 里 `prevent_exit`→线程内优雅停→`app.exit(0)`；并在 `Exit` 做有界 SIGTERM(进程组)→SIGKILL 兜底。实测 Cmd+Q 后**无孤儿、端口关闭**。sidecar 用 `process_group(0)` 自成进程组，整组收割。
3. **内核脚本要过生产配置闸门**：migrate 走 prisma CLI 不读内核 config（无需 JWT）；但 `nav-reconcile.js`/`init-admin.js` 是内核入口，需完整 `JWT_SECRET/CORS_ORIGIN/...`，否则退出码 2。已在 Rust 注入。
4. **iCloud 桌面会把打包拖死**：`~/Desktop` 在 iCloud 文件提供者管理下，逐文件写 6670 个资源会被同步拖到数十分钟（node 0% CPU）。对策：把 `apps/desktop/.stage`、`src-tauri/target` 移到本地 `~/Library/Caches/gouxiangdb-desktop/build/` 并软链（两目录本就 gitignore）。迁移后打包稳定 **~75–90s**。后续在主力 Mac 开发务必沿用。
5. **构建期必须 `prisma generate`（darwin-arm64 引擎）**：prod 依赖默认不含 prisma CLI/schema-engine，脚本显式把 `prisma` 提到 deps 并 generate，目标机无 CLI/无网仍可 migrate（已验证）。
6. **待办（不阻塞 PoC-1，进 D2/D5）**：
   - JWT_SECRET 现 PoC 存数据目录 `.jwt-secret` 文件；**D2 换 macOS Keychain**（首次会弹系统授权，需产品负责人在场）。
   - 冷备每次启动一份，需**备份轮转**（保留最近 N 份，测试期已积 5 份 `dev.db.*.bak`）。
   - 包体积 375MB（随包 Node 108MB + hoisted node_modules 158MB + web 14MB），正式版可裁 prisma 引擎/无关平台件瘦身。
   - 健康判据当前为「回环端口可连」（migrate 已先行同步完成）；D2 可加 `/readyz` JSON 五探针断言。
   - `.jwt-secret`/`dev.db` 等已在数据目录而非包内，升级替换 .app 不触数据；D5 出卸载/数据说明。

## 4. 复现命令（本机）
```
# 组装（含真建库冒烟）
node apps/desktop/scripts/stage-node-sidecar.mjs
# vec 扩展验证
apps/desktop/.stage/gxnode-aarch64-apple-darwin /tmp/gx-poc1-vec.mjs apps/desktop/.stage/server
# 打包（重产物已软链到本地缓存）
tauri build --bundles app
open apps/desktop/src-tauri/target/release/bundle/macos/构想工作台.app
```

## 5. 回滚
删 `apps/desktop` 与分支 `feat/macos-desktop-d0` 即可；web/api/fpk 默认构建矩阵不含 desktop，四门基线不受影响。后端唯一改动 `GX_BIND_HOST` 为 additive，默认行为不变，可独立保留或回退。
