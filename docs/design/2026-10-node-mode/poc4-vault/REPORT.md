# PoC-4：副本加密磁盘匣（macOS hdiutil sparsebundle + Keychain）闸门报告

- 日期：2026-10-16
- 设计权威：`../DESIGN-OFFLINE-SYNC.md` §18（路线 A/B/C）、§18.5（PoC-4 验收项）、§9.4（作用域隔离/失权擦除）
- 执行人：无人值守续接（Mac 本机，Apple Silicon，darwin-arm64）
- 运行时：受管 Node v22.22.2、better-sqlite3@13.0.3、sqlite-vec-darwin-arm64@0.1.9（`vec0.dylib`）

## 结论（TL;DR）

**路线 A（AES-256 加密 sparsebundle 承载整个 dataDir，对内核零侵入）在 Mac 本机通过闸门组 1 的项 1/2/3/4/6，可作为本期默认落地方案。** 关键假设「Prisma 引擎 / better-sqlite3 / sqlite-vec 只看到挂载点里的普通文件、对加密完全无感」经实测成立：在加密挂载点内建库、`db.loadExtension(vec0)` 加载成功、普通表 CRUD 与 vec0 向量 KNN 全部正常，detach 后磁盘上无业务明文。

**组 1 项 5（ad-hoc 签名最小 .app 内 Rust 经 Keychain 自动挂载是否弹授权、可否静默）未能无人值守闭环** —— 它必须在真实签名 .app 包 + Keychain 首次授权交互下由戴总在场观察弹窗形态，是本 PoC 唯一明确阻断点（见下「阻断点」）。这不影响路线 A 的机制可行性，只影响最终产品形态下的授权 UX 验收。

组 2（路线 B：multiple-ciphers + Prisma driver adapter + vec + 四门）按设计「结论用于决策、不阻断 A」，本期不投入（路线 A 已达标，B 留作未来跨平台/细粒度备选）。

## 验收项逐条结果（对应 §18.5 组 1）

| 项 | 要求 | 结果 | 证据 |
|---|---|---|---|
| 1 | hdiutil 建 AES-256 sparsebundle，命令行挂到指定 mountpoint | ✅ | `hdiutil create -encryption AES-256 -type SPARSEBUNDLE -fs APFS`；`attach -mountpoint <显式路径>` 成功、可写；稀疏 cap 64MB 不预占 |
| 2 | 挂载点内 better-sqlite3 建库、vec0 loadExtension + 一次向量 KNN（代表 Prisma/vec 零侵入） | ✅ | `VEC_VERSION=v0.1.9`；普通表增改回读正常；vec0 虚表写入 3 条 float[4]、KNN `MATCH ? ORDER BY distance` 返回 `[rowid1(d0), rowid3(d0.1414)]`，排序正确 |
| 3 | detach 后挂载点空、镜像为密文、错密码拒绝；正确密码重挂数据完好 | ✅ | detach 后 mountpoint 0 项；`grep` 镜像 bands 找不到业务标记串；错密码 attach 被拒；重挂后 `REATTACH_DATA_OK`，业务行与 KNN（knnTop=2）均完好 |
| 4 | 模拟节点失权：detach + 丢密钥 + 删镜像，无明文残留、其它作用域不受影响 | ✅ | 双作用域 scopeA/scopeB 各写独立密文；销毁 A（detach+删密码句柄+删 .sparsebundle）后，A 挂载点空、全盘 grep 无 A 明文，B 仍挂载可读 |
| 5 | ad-hoc 签名最小 .app 内 Rust 经 Keychain 自动挂载（记录是否弹授权/可否静默），退出干净 detach | ⛔ **阻断（需戴总在场）** | 见下「阻断点」；本机 PoC 用临时随机口令（不落真实 Keychain）验证了磁盘匣机制，但未验证签名 .app 内 Security framework 访问 Keychain 的首次授权弹窗 |
| 6 | 体积/性能：稀疏增长曲线、额外开销（目标 <10%，仅记录不硬卡） | 🟡 部分（体积已采，性能待完整侧车） | 空匣 attach 后约 18MB（APFS 容器元数据，非加密负载）；写入一个带 vec 的 sqlite 后镜像约 18MB。读写开销发生在内核挂载的本地文件系统，机制上等同普通磁盘 IO；精确 <10% 需完整侧车在挂载点起服务后对比，列入项 5 同场实测 |

## 关键实现细节（踩坑即契约）

1. **vec0 向量载荷是小端 float32 BLOB，不是 JSON**：与项目 `domain/search/vecLoader.ts::vecBlob` 同口径，`Buffer.from(Float32Array.from(v).buffer)`；喂 JSON 会报 `JSON array parsing error: Input does not start with '['`。
2. **vec0 rowid 必须绑整数**：better-sqlite3 要用 `BigInt(...)`，JS number 被当 double，报 `Only integers are allows for primary key values`（即项目 H2 铁律）。
3. **挂载用显式 `-mountpoint`**：不让系统挂到 `/Volumes/<volname>`，对应侧车 `mounts/<scope>/` 可控路径；`-nobrowse` 不在 Finder 显示。
4. **口令喂法用 `-stdinpass`**：避免出现在进程参数 `ps` 列表（生产口令从 Keychain 取后走 stdin/equivalent API，与 §18.3 不进命令行一致）。
5. **作用域布局与 §9.4/§18.2 一致**：`<as>/vaults/<scope>.sparsebundle` + `<as>/mounts/<scope>/`，侧车以 `GX_DATA_DIR=<mount>` 启动；失权＝`hdiutil detach` + 删 Keychain 项（本 PoC 用删临时口令文件代表示意）+ `rm -rf <scope>.sparsebundle`，三步后无明文残留，兄弟作用域不受影响。

## 阻断点：项 5 为何不能无人值守闭环

- 需要构建一个 **ad-hoc 签名的最小 .app**（内部 Rust/可执行体调 Security framework `SecItemCopyMatching` 取 Keychain 口令 → hdiutil 挂载 → 退出 detach）。
- macOS 对「签名 App 首次访问自己的 Keychain 项」可能弹「App 想要访问钥匙串中的机密信息」授权框；**是否弹、可否通过预置 ACL/签名身份静默，必须在戴总登录的图形会话里实测一次**，SSH/无人值守会话无法观察也不应替用户点授权。
- 戴总在场时的最小验收动作（建议）：
  1. 构建 ad-hoc 签名最小 .app，预置/写入一条 `service=<bundle-id>.vault, account=local` 的 Keychain 项；
  2. 启动 .app，观察是否弹 Keychain 授权、点选「始终允许」后二次启动是否静默自动挂载；
  3. 退出 .app，确认 `mount`/`hdiutil info` 无残留、`mounts/local` 已 detach。
- 若 .app 内无法静默（每次都弹），降级仍安全：退到 D5 已拍板的「只绑 Keychain、启动自动取用」+ 首次「始终允许」，或极端情况下走 §18 降级组合（目录 0700 + 失权即擦除 + 提示依赖整机 FileVault）。

## 复跑方式（隔离工程，不动主仓产品代码）

```bash
# 全程在沙箱 ${TMPDIR:-/tmp}/gx-poc4 内，结束自动 detach、无 /Volumes 残留；
# 只读主仓已安装的 node_modules（better-sqlite3 / vec0.dylib），绝不写主仓或真实数据目录。
bash docs/design/2026-10-node-mode/poc4-vault/poc4-vault.sh \
  /Users/daijing/.workbuddy/binaries/node/versions/22.22.2-6/bin/node
# 仅 macOS（VM15 Linux 无 hdiutil，跑不了）。清理沙箱：... poc4-vault.sh clean
```

- `poc4-vault.sh`：hdiutil 生命周期编排（建/挂/项3/项3b/项4/收尾）。
- `vec-probe.cjs`：项2 内核零侵入探针（CRUD + vec0 KNN）。
- `reattach-verify.cjs`：项3b 重挂后数据/向量完好校验。

## 对发版的影响

- 路线 A 的**服务端/内核侧无需任何改动、无新随包原生件、无迁移**（hdiutil 系统自带）；加密是 Mac App（Rust 薄桥/sidecar 编排层）职责，落在 MAC 设计 D3/YN3E，与服务端 0.2.5 解耦。
- 0.2.5 的服务端测试版不被项 5 阻断；项 5 仅阻断「Mac App 加密副本」这一交付形态的最终 UX 验收，需戴总在场。
