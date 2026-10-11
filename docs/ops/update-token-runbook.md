# 应用更新只读令牌运维手册（GouXiangDB Gitea PAT）

适用版本：0.2.3 起的「应用内更新检查 + 下载代理」机制。
唯一设计依据：[`../design/2026-10-app-update/DESIGN.md`](../design/2026-10-app-update/DESIGN.md) §5.3、§6、§8.1、§8.2、D1。

> 大白话：客户 NAS 里的工作台要能查到新版本、帮客户把安装包下载下来，就得持有一张**只能读这一个仓库**的 Gitea 令牌。这张令牌随安装包悄悄带过去（客户看不见、摸不着），本手册讲怎么建、怎么换、怎么吊销。

---

## 0. 两种令牌必须分清（最容易出事的一点）

| 令牌 | 环境变量 | 谁持有 | 权限 | 用途 |
|------|----------|--------|------|------|
| **只读令牌**（本手册主角） | 构建机 `GX_READER_TOKEN`；客户机内落为 `GX_UPDATE_TOKEN` | 专用服务账号（如 `gouxiang-reader`） | 仅 `GouXiang/gouxiangdb` 单仓 **Read** | fpk 内置；后端查更新/代理下载时用 |
| **发布令牌** | 发布机 `GX_GITEA_TOKEN` | 发布人本人账号 | 对该仓的 **write**（挂 release、传资产） | 仅发布脚本 `publish-gitea-release.mjs` 用 |

铁律：

1. **两张令牌永远不是同一张**。只读令牌能被所有安装包带到客户现场，绝不能有写权限；发布令牌只存在发布人自己的机器上，绝不打进任何包。
2. 只读令牌的定位是「防匿名爬取」，**不是保密凭证**——Gitea 的单仓协作者 PAT 物理上仍能读仓库源码（2026-10-11 实测，已接受的已知残余风险，DESIGN §8.1 #7）。因此它一旦泄露，最坏后果是「能读这个私有仓」，必须能随时吊销。
3. 令牌值**绝不进 git、不进日志、不进审计、不进错误信息、不进任何 URL query**。仓库里只允许出现占位符 `__GX_UPDATE_TOKEN__`。

---

## 1. 首次创建只读令牌

在 Gitea 1.27.3 上（单仓可见性收窄只能靠「协作者」机制）：

1. **建服务账号**：注册一个独立账号（如 `gouxiang-reader`），使用独立强密码；**不加入任何团队/组织的其它分组**。
2. **单仓授权**：用 owner 账号打开 `GouXiang/gouxiangdb` → 仓库设置 → 协作者（Collaborators）→ 添加 `gouxiang-reader`，权限选 **Read（只读）**。
3. 用该服务账号登录 → 右上角设置 → 应用（Applications）→ 生成新的「经典访问令牌（classic token）」，只勾只读 scope（与 2026-10-11 实测封板的 8 项 scope 集一致）：
   `read:activitypub, read:misc, read:notification, read:organization, read:package, read:issue, read:repository`
   - **不要勾** `write:repository`、`read:user`（该账号本就不该有用户信息读取；代码也从不调 `/user` 端点，见 DESIGN §8.1 #1）。
4. 立即复制令牌（只显示一次），在构建机上 `export GX_READER_TOKEN=<令牌>` 用于打 fpk。

验证（可选，在构建机上）：

```bash
# 应恰好只看到 1 个仓 GouXiang/gouxiangdb，private=true，permissions.pull=true、admin/push=false
curl -s -H "Authorization: token $GX_READER_TOKEN" \
  https://gitea0.hn.takin.cc/api/v1/repos/search?limit=50
# /user 端点应 403（证明没有 read:user）
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: token $GX_READER_TOKEN" \
  https://gitea0.hn.takin.cc/api/v1/user
```

---

## 2. 令牌如何进入客户机（注入链路，排障用）

```
构建机 env GX_READER_TOKEN
  └─ deploy/fnos/build-fpk.mjs 在 fnpack 前一刻，把【打包副本】
     deploy/fnos/gouxiangdb/cmd/install_callback 里的占位符 __GX_UPDATE_TOKEN__
     就地替换成真实令牌；fnpack 一结束（成功/失败/被 Ctrl-C）立即逐字节还原源模板
       └─ 封进 fpk
            └─ 客户首装：install_callback 把 GX_UPDATE_TOKEN=<值> 写进
               $TRIM_PKGETC/gouxiangdb.env（该文件 umask 077，仅应用可读）
                 └─ cmd/main 启动 node 前 set -a; source，注入后端进程
                      └─ 后端代理 Gitea 时加 Authorization: token 头；浏览器全程不可见
```

关键安全机制：

- 仓库源模板 `cmd/install_callback` 里**永远是占位符**，真实令牌只存在于打包副本的几秒钟。`build-fpk.mjs` 开头有**早检**：若发现源模板里占位符没了（疑似上次被强杀导致真实令牌残留），直接 fail-fast，杜绝令牌进 git。
- 占位符是普通文本 `__GX_UPDATE_TOKEN__`（不是 `${...}` 形态），不会触发 fnpack 向导变量替换。
- 后端只在请求头用令牌，从不放 URL query（避免进访问日志/浏览器历史）。

---

## 3. 轮换令牌（新旧重叠窗口法，推荐）

**为什么需要重叠窗口**：已经装到客户那里的旧 fpk 内置的是旧令牌；如果先吊销旧令牌，所有存量客户在升级到「内置新令牌的版本」之前都会检查更新失败（面板报「更新源凭证无效」）。所以要让新旧令牌在一个发布周期内同时有效。

步骤：

1. **建新令牌**：按 §1 再建一张服务账号 PAT（同一账号新建第二张即可，Gitea 允许并存），构建机 `export GX_READER_TOKEN=<新令牌>`。
2. **新旧并存**：此刻**先不要吊销旧令牌**。
3. **发布内置新令牌的版本**：用新 `GX_READER_TOKEN` 重新打 fpk 并走正常发布（`GX_GITEA_TOKEN=<发布令牌> node scripts/release/publish-gitea-release.mjs --tag vX.Y.Z`）。
4. **升级自动换令牌**：客户通过飞牛应用中心升级到这个版本时，`cmd/upgrade_callback` 会从新包模板里提取新令牌，**只定点刷新 `gouxiangdb.env` 里的 `GX_UPDATE_TOKEN` 这一行**（逐行重建 + 临时文件原子 mv），`JWT_SECRET`/`DATABASE_URL` 等其它行一字不动。模板里仍是占位符或为空时则跳过、维持现状。
5. **观察一个发布周期**，确认存量客户基本都已升级（现场检查更新不再依赖旧令牌）。
6. **吊销旧令牌**：在 Gitea 该服务账号的 Applications 页面删除旧 PAT。此后仍停在极旧版本、没升级的客户会收到中性的「更新源凭证无效，请联系部署人员」，不影响其正常使用，引导其升级即可。

---

## 4. 紧急吊销（怀疑泄露时）

1. Gitea → 服务账号 Applications → **立即删除涉事令牌**。吊销即时生效，无需改客户机。
2. 影响面评估：该令牌仅单仓只读，泄露的最坏后果是「他人可读取 `GouXiang/gouxiangdb` 私有仓内容」；**不能**改 release、不能读其它仓、不能读用户信息。
3. 按 §3 重新建令牌并发布一个内置新令牌的版本，让客户升级后恢复更新检查。
4. 在正式版本发布前，旧的/演练用令牌都应在 Gitea 后台作废清理（S6 rc 演练后尤其注意）。

---

## 5. 现场排障（客户机）

| 面板 / 接口现象 | code | 可能原因 | 处置 |
|---|---|---|---|
| 「更新源尚未配置，请联系部署人员」 | `UPDATE_SOURCE_UNCONFIGURED` | fpk 未内置令牌（打包时没设 `GX_READER_TOKEN`），或 env 被清空 | 在 `$TRIM_PKGETC/gouxiangdb.env` 补 `GX_UPDATE_TOKEN=<有效只读令牌>` 后重启应用；或重装内置令牌的正式包 |
| 「更新源凭证无效，请联系部署人员」 | `UPDATE_SOURCE_AUTH` | 令牌被吊销/失效，或被误换成非只读令牌 | 换新只读令牌，重启 |
| 「暂时无法连接更新服务」 | `UPDATE_SOURCE_UNREACHABLE` | 客户网络不通 / Gitea 5xx | 稍后重试；检查客户出网 |
| 「连接更新服务超时」 | `UPDATE_SOURCE_TIMEOUT` | 弱网，超过 `GX_UPDATE_TIMEOUT_MS`（默认 8s） | 稍后重试 |
| 检查更新正常但无任何版本 | `UPDATE_MANIFEST_INVALID` | 最新 release 缺 `update-manifest.json` 资产，或清单结构坏 | 发布侧重发清单资产 |

现场手动核对（注意不要把令牌回显到截图/工单里）：

```bash
# 只确认「有没有配置」，不打印值
grep -q '^GX_UPDATE_TOKEN=.' "$TRIM_PKGETC/gouxiangdb.env" && echo "token configured" || echo "token missing"
```

---

## 6. 相关文件与配置

- 打包注入与强制还原：`deploy/fnos/build-fpk.mjs`（§5.9）
- 首装写入：`deploy/fnos/gouxiangdb/cmd/install_callback`
- 升级定点刷新：`deploy/fnos/gouxiangdb/cmd/upgrade_callback`（第 4 步）
- 后端配置解析：`apps/api/src/configUpdate.ts`（`GX_UPDATE_TOKEN` 等 11 项）
- 后端源实现与硬约束：`apps/api/src/domain/update/sourceGitea.ts`
- 发布脚本（写令牌）：`scripts/release/publish-gitea-release.mjs`、`scripts/release/lib-gitea.mjs`

配置项全表见 DESIGN §5.3；其中与令牌直接相关：

- `GX_UPDATE_TOKEN`：运行期只读令牌（fpk 自动注入，裸机/Docker 可在 env 里手动配；默认空）。
- `GX_READER_TOKEN`：**仅构建机**使用，组装期注入，不进运行期配置。
- `GX_GITEA_TOKEN`：**仅发布机**使用，写权限，与只读令牌严格分离。
