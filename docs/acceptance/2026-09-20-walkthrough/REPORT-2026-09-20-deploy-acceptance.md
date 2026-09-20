# 192.168.31.167 部署与五项真机终验报告

## 部署路径
- Mac 直连 167 SSH 可用，密码 `[REDACTED-PASSWORD]`，未走跳板。
- 同步方式：rsync 本地工作树 → 167 `/home/daijing/gouxiangdb`（该目录历史无 `.git`）。
- 本地 HEAD：`3a00afa`；rsync 后 167 文件与本地工作树一致。
- 构建：167 上 `pnpm install --frozen-lockfile`（已是最新）、`pnpm --filter @gx/api build`、`pnpm --filter @gx/web build`，`sync-help-center.mjs` 无缺图通过。
- 静态根：覆盖 `/var/www/gouxiangdb/{assets,help-assets,index.html}`；不回写 `dist/help`（该目录仅含 assets，作为目录放在静态根会导致 nginx 403）。
- 服务：`systemctl restart gouxiangdb-api` → active。

## 健康检查
`/readyz` 五探针全 `true`：`dbPing`、`dbWritable`、`migrations`、`uploadsWritable`、`disk`。`applied=25`，最新迁移 `20260919102128_entity_icon_ddl`（仓库当前共 25 个迁移，非 23）。

## 真机终验
| 项 | 结果 | 证据 |
|---|---|---|
| A 复制链接 | 通过 | 分享弹窗开外部链接后点「复制」，toast「链接已复制」`A-06-复制链接结果.png` |
| B 链接长度 | 通过 | 链接 `http://192.168.31.167/s/ir4xJ240mwFX1Gf1unpaXUa9-8uxP3E0`，token 32 字符 |
| C 数据表视图 | 通过 | 视图切换器为横排选项卡独占首行；设置项在第二行；新建两个额外视图后横向展开 `C-04-三个视图选项卡.png` |
| D 帮助中心 | 通过 | `/help` 返回 200，61 张配图，brokenCount=0 `D-02-help截图.png` |
| E 回归抽查 | 现象仍在 | 把文档 A 拖到文档 B 下后，B 折叠 `E-02-拖拽文档A到B.png`；未引入新问题 |

截图存放：`docs/acceptance/2026-09-20-walkthrough/*.png`。
