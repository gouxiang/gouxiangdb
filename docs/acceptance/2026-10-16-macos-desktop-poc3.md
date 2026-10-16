# macOS 桌面 App PoC-3 验收报告：无 Apple 账号下 Tauri updater 旧版→新版闭环 + 篡改拒绝 + quarantine 实测

- 日期：2026-10-16（实跑至 10-17 00:1x）
- 对应设计：`docs/design/2026-10-node-mode/DESIGN-MACOS-APP.md` §9（自动更新）、§15 PoC-3、§9.5 quarantine
- 分支：`feat/macos-desktop-d0`（spike，独立于 0.2.5 主线；不进 web/api/fpk 四门）
- 前置：PoC-1（sidecar 干净 .app 建库，commit `2178dca`）、PoC-2（WKWebView 同源零 CORS，commit `2678eda`）已过
- 本 PoC 提交：`8cad631`（updater 接线 + 复现设施）、`b356801`（实测后修正更新校验时序的真 bug + 脚本加固）
- 结论：**核心三项（密钥流程 / 旧→新闭环 / 篡改拒绝）全部通过 ✅；quarantine 实测出明确结论与必做安装姿势（见第 4 节），方案成立、无需回退设计，但打包脚本必须加"整包 ad-hoc 重签"、分发必须引导"拖进应用程序"。**

---

## 0. 环境与产物

- 机：Darwin arm64（Apple Silicon），macOS 27.01；无 Apple Developer 账号（本期边界）。
- 依赖：`tauri-plugin-updater =2.13.3`（依赖约束 tauri `^2.12` / reqwest `^0.13`，与现锁 tauri 2.12.4 / reqwest 0.13.5 共存，**未拖核心升级**）；`default-features=false + rustls-tls`（关掉默认的 zip=^4——zip 4.0–4.6.1 全 yanked 会导致 resolve 失败；macOS 用 flate2+tar 的 `.app.tar.gz`）。
- 更新密钥对：`~/.tauri/gouxiangdb-desktop.key(.pub/.pass)`，权限 600/700，仓库外不入库；minisign keyid `8AB051BA84DBAD94`。`.sig` 为单行 base64（436 B），`latest.json.signature` 放整文件内容。
- 两版测试包（壳 sha 与 bundle 逐字节一致，脚本有硬校验防"包新壳旧"）：
  - 0.1.0：`构想工作台-0.1.0.app` + `GouXiangDB-0.1.0.app.tar.gz`（155,929,118 B）+ `.sig`
  - 0.2.0：`构想工作台-0.2.0.app` + `GouXiangDB-0.2.0.app.tar.gz`（155,929,088 B）+ `.sig`
- 静态更新源：`poc/poc3-static-server.mjs`（零依赖，只绑 127.0.0.1:18080，MIME/访问日志/目录穿越 404）；清单 `poc/make-poc3-manifest.mjs`（`--tamper` 翻转约 37% 处 1 字节）；驱动 `poc/run-poc3.sh`。
- 隔离：全程 `/tmp/gx-poc3`（art/src/install/data/quarantine/fixed），**不写 /Applications，不碰真实数据目录**（右键首装那次用真实 Application Support，但库幂等且已先整目录备份到 `/tmp/gx-poc3/realdata-backup`）。
- 构建成本实测：依赖预热后，两版串行 `tauri build` 约 2 分钟，`CARGO_BUILD_JOBS=2` + thin LTO 下内存无压力。

## 1. 验收① 密钥对流程 + 0.1.0→0.2.0 自动更新闭环 —— 通过

无交互自动判定（`GX_POC3=1`，更新过程写 `/tmp/gx-poc3-updater.log`）：旧版启动→内核就绪→`check()` 拉源→下载 155MB（进度逐块）→minisign 公钥校验通过→**优雅停 sidecar**→替换 .app→`restart()`→新版启动自检"已是最新"（无更新循环）。

关键日志（修正时序后的权威一次，run-old4）：

```
---- session begin pid=27775 ----
bundle_version=0.1.0
update available: current=0.1.0 remote=0.2.0 target=darwin url=http://127.0.0.1:18080/GouXiangDB-0.2.0.app.tar.gz
download bytes=4194304 total=Some(155930972)  …（逐块到完整字节数）…
download finished (signature not yet verified); keep sidecar running      ← 下载完但尚未校验，内核保持运行
signature OK (155928795 bytes verified); graceful stop sidecar before install  ← 仅校验通过才停内核
RESULT INSTALLED（新 .app 已落位），请求 restart
RESTART_EXIT_CODE received: stopping sidecar before relaunch
---- session begin pid=28040 ----
bundle_version=0.2.0
RESULT NONE reason=already-latest（静态源版本不高于当前，属正常分支）
```

- 静态源访问日志：完整 `GET /GouXiangDB-0.2.0.app.tar.gz (155,930,972 B)` 一次、`latest.json` 若干，字节数与产物一致。
- 安装目录 `Info.plist` 版本：启动前 0.1.0 → 更新后 0.2.0（脚本硬断言）。
- 重启协作：`restart()` 发 `RunEvent::ExitRequested{ code: Some(80) }`（`tauri::RESTART_EXIT_CODE=80`）；主 run 循环识别该 code 后**优雅停 sidecar 但不 prevent_exit**，放行 Tauri 重启。普通退出（code=None）仍走原 prevent_exit 序列，互不影响。
- `cargo check --release` 0 错 0 警。

## 2. 验收② 篡改/坏签名必须拒绝、不得安装 —— 通过（并修掉一个真 bug）

源里放宣称 0.3.0、但内容翻转 1 字节仍配 0.2.0 合法签名的包（客观核对：两包 `cmp` 仅 **1 字节**差异、sha256 不同）。实测：

```
update available: current=0.2.0 remote=0.3.0 …GouXiangDB-0.3.0.app.tar.gz
download finished (signature not yet verified); keep sidecar running
RESULT FAIL reason=download_or_verify error=The signature verification failed
NOTE 校验失败：未安装，且 sidecar 全程未被停止（旧版继续运行）
```

取证：拒绝后壳进程存活、**内核 sidecar 存活**（pid 28400，port 52051，`readyz` 五探针全绿、42 迁移）、安装版本仍 0.2.0、无 restart。

### ★实测发现并修复的真 bug（commit `b356801`）

第一版实现用 `download_and_install(on_chunk, on_download_finish)`，在 `on_download_finish` 里停 sidecar。实测源码 `tauri-plugin-updater-2.13.3/src/updater.rs:835-843` 证明：**`on_download_finish()` 在第 835 行（下载收齐）先于第 837 行 `verify_signature()` 触发**。于是坏签名虽在 843 行返回 Err，内核却已被回调误停（壳在、服务没了），违背"校验失败一切原样"。

修法（严格对齐真实时序）：
1. `update.download(on_chunk, on_finish_noop)` —— 完成回调**只记日志、绝不停内核**；坏签名在其内部 verify 阶段直接 Err，内核全程不动；
2. 仅在 `download()` 成功（字节已过 minisign 校验）后，才优雅停 sidecar；
3. `update.install(bytes)`（内部对字节**再 verify 一次** + 解压替换）；
4. `restart()`。

复测后坏签名场景内核零中断（上文 pid 28400 readyz 全绿）。**该修复对 D4 产品化更新器是直接可复用的正确时序，不是 PoC 专用 hack。**

## 3. 验收④ 安装时 sidecar 优雅停 + 旧库无 WAL 损坏 —— 通过

正常更新落新 .app 前，日志明确 `graceful stop sidecar before install`（SIGTERM 进程组，命中内核 flushAllAndClose→断 Prisma；主 run 循环 RESTART 分支再兜底一次）。更新后新版（壳 0.2.0 / 内核 0.2.5）用同一数据目录重启：

- `/readyz`：`status=ready`，dbPing/dbWritable/migrations/uploadsWritable/disk **全 true**，`migration.applied=42`；
- `dev.db-wal` 为 0 字节、`dev.db-shm` 正常（WAL 已干净 checkpoint 落盘，无损坏）；
- `dev.db` 765,952 B；启动序列按设计做了冷备 `dev.db.<ts>.bak`（冷备未轮转，见第 5 节遗留）。

## 4. 验收③ quarantine / Gatekeeper 实测（本 PoC 最有价值的发现）

四种状态分别取证（`xattr` / `codesign -dv` / `spctl -a -vvv`）：

| 场景 | quarantine | 签名 | spctl | 实际能否运行 / 怎么运行 |
| --- | --- | --- | --- | --- |
| 本地构建、未下载的 .app | 无 | adhoc（但**资源封条不完整**，见下） | `code has no resources but signature indicates they must be present` | 直接运行 OK（PoC-1/2 已证） |
| **updater 自动更新替换出的新 .app** | **无** | 同上 | — | **直接重启运行，零拦截**（验收①实测） |
| 模拟浏览器下载（写 `com.apple.quarantine`），Tauri 原始签名 | 有(0081→00c1) | adhoc 资源封条不全 | **rejected** | 右键→打开：能运行，但走 **App Translocation** |
| 同上，但先整包 ad-hoc 重签 | 有 | adhoc `Sealed Resources … files=6671`，Identifier=`cc.gouxiang.desktop` | 仍 rejected（无开发者身份，属预期） | 右键→打开运行；**去隔离+固定路径则原位运行** |

### 4.1 两个必须吸收进产品的硬结论

**A. Tauri 默认简易 ad-hoc 签名没封 Resources 里的 node_modules，必须整包重签。**
Tauri 只对主二进制 ad-hoc 签名，`Resources/server/node_modules` 内数千文件（实测重签后 `files=6671`）未被一致封进资源封条，`codesign` 报 "code has no resources but signature indicates they must be present"。无 quarantine 时不影响运行，但带下载隔离标记时 Gatekeeper 直接拒。
→ **D5/打包脚本必须在产出 .app 后执行 `codesign --force --deep --options runtime -s - "<.app>"`**（实测 1.7s 扫完 396MB，重签后 Identifier 正确为 `cc.gouxiang.desktop`、封条 files=6671、flags=adhoc,runtime）。这是设计 §9.5 预案 A，实测有效且必须做。

**B. 从随机临时目录/下载目录直接运行会触发 App Translocation，会让自动更新失效；标准安装姿势必须是"拖进应用程序 + 去隔离"。**
戴总右键→打开虽然成功运行（readyz 全绿），但系统把 .app 复制到只读随机路径执行，进程路径实测为：

```
/private/var/folders/.../T/AppTranslocation/<UUID>/d/构想工作台.app/Contents/MacOS/gouxiangdb-desktop
```

App Translocation（Gatekeeper 对"带隔离标记且未固定位置的未签名 App"的随机只读挂载）下，updater 无法把新 .app 写回那个只读随机目录，自动更新会落空。
→ 实测的可接受标准姿势（设计 §9.5 的 **C + B 组合**）：
1. dmg 里放「应用程序」文件夹替身，引导用户把 **GouXiangDB 拖进 /Applications**（固定位置）；
2. 首次右键→打开过一次 Gatekeeper（或安装引导执行一次 `xattr -dr com.apple.quarantine /Applications/GouXiangDB.app`）。

验证：对副本 `xattr -dr com.apple.quarantine` 后从**固定路径**启动，实测进程**原位运行、无 AppTranslocation、readyz 全绿**——此形态下 updater 替换原 .app 有效，且更新产物本就不带 quarantine，后续更新不再有任何拦截。

### 4.2 对"以后会不会每次更新都被拦"的明确回答

**不会。** 只有【第一次安装一个从网上下载、未公证的 App】需要处理一次 Gatekeeper（拖进应用程序 + 右键打开）。此后所有"点一下自动更新"：updater 解压出的新 .app **不带 quarantine**（验收①实测无标记、直接重启运行），且 App 已在固定路径不触发 translocation，**无二次拦截、无需再右键**。

## 5. 实测暴露的遗留项（进 D2/D5，不阻断 PoC-3 结论）

1. **打包必须整包 ad-hoc 重签**（§4.1-A）：加进 `build-desktop.mjs`（D5），在 tauri build 后 `codesign --force --deep --options runtime -s -`。
2. **dmg 安装引导 + 去隔离 runbook**（§4.1-B）：拖进应用程序、首次右键打开（或一条 xattr 命令）；文案讲清仅首次。
3. **包瘦身**：396MB（随包 Node ~108MB + hoisted node_modules ~158MB + web）。已见 node_modules 内同时存在 `darwin-arm64` 与**未签名的 x86_64 件**（如 `better-sqlite3/prebuilds/darwin-x64`）——D5 应剔除非 arm64 预编译件，顺带减重、减封条面。
4. **冷备轮转**：每次启动在数据目录生成 `dev.db.<ts>.bak`，测试期已积 7 份；D2 加保留最近 N 份。
5. updater 进度目前只落日志；D4 做"检查更新对话框/进度条/更新说明"（U4：每次打开只查不装、点了才装、保留手动检查菜单）。endpoint 最终配 Gitea Release 公网 https（§17.1 已证匿名可拉），PoC 用 http 回环仅为机制验证（`dangerousInsecureTransportProtocol` 只在 PoC 构建的 `--config` 注入，正式 conf 不含）。

## 6. 复现命令（戴总在场，仅 Mac arm64）

```
# 密钥（一次性，已生成在 ~/.tauri，勿入库勿外泄）
tauri signer generate -w ~/.tauri/gouxiangdb-desktop.key -p <pass> --ci

# 两版构建（出 .app / .app.tar.gz / .sig，约2分钟；含壳指纹一致性硬校验）
bash apps/desktop/poc/run-poc3.sh buildall
# 放正常 0.2.0 清单 + 起回环源 + 装0.1.0自动升到0.2.0（看 /tmp/gx-poc3-updater.log）
bash apps/desktop/poc/run-poc3.sh manifest-ok
bash apps/desktop/poc/run-poc3.sh run-old
# 篡改 0.3.0（翻转1字节）验证拒绝且内核不中断
bash apps/desktop/poc/run-poc3.sh tamper
# 更新后 .app 的 xattr/codesign/spctl/原生件/库完整性取证
bash apps/desktop/poc/run-poc3.sh forensic
bash apps/desktop/poc/run-poc3.sh stop
```

quarantine/translocation 为人工 + 命令混合取证（写隔离标记、整包重签、右键打开、看 `ps` 路径是否 AppTranslocation、去隔离后固定路径复跑）。

## 7. 回滚

仅 `apps/desktop` + spike 分支；web/api/fpk 默认矩阵不含 desktop，四门基线不受影响。updater 插件虽注册，但正式 `tauri.conf.json` 无 updater 段、且非 `GX_POC3` 永不 check，默认零自动行为；删除 `apps/desktop` 与本分支即可完全回滚。
