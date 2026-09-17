#!/usr/bin/env bash
# GouXiangDB 容器入口：
#   1) 只允许 `prisma migrate deploy`（只增、已应用跳过），绝不跑 migrate dev/reset/db push；
#   2) 迁移成功后跑 dist/nav-reconcile.js --apply 全量重算 nav path/depth（M3-S11-A/AC-UPG-1）；
#   3) 重算成功后 exec node dist/index.js（由 tini 转发信号，node 做优雅关闭）。
# 迁移失败即以非零退出，容器按 compose 的 restart 策略重启；此时尚未切换到新版本流量。
set -euo pipefail

API_DIR="/app/apps/api"
SCHEMA="${API_DIR}/prisma/schema.prisma"
PRISMA_BIN="${API_DIR}/node_modules/prisma/build/index.js"

log() { printf '[entrypoint] %s\n' "$*"; }

log "应用数据库迁移（prisma migrate deploy）：DATABASE_URL=${DATABASE_URL:-<unset>}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL 必须由运行时注入}" \
  node "$PRISMA_BIN" migrate deploy --schema="$SCHEMA"

# M3-S11-A/AC-UPG-1：迁移只给根节点 path，迁移成功后、接流量前必须全量重算非根节点
# path/depth，否则深层 tree 索引缺节点、菜单 shortcut 全 disabled。set -euo pipefail 下
# 失败即非零退出：容器按 restart 策略重启，此时尚未 exec 服务，不接任何流量。
log "迁移后导航 path 重算（nav-reconcile --apply）"
cd "$API_DIR"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL 必须由运行时注入}" node dist/nav-reconcile.js --apply

log "迁移与导航重算完成，启动 GouXiangDB API（port=${PORT:-3001}）"
exec node dist/index.js
