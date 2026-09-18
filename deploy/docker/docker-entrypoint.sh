#!/usr/bin/env bash
# GouXiangDB 容器入口：
#   1) 只允许 `prisma migrate deploy`（只增、已应用跳过），绝不跑 migrate dev/reset/db push；
#   2) 迁移成功后跑 dist/nav-reconcile.js --apply 全量重算 nav path/depth（M3-S11-A/AC-UPG-1）；
#   3) 重算成功后、接流量前跑 dist/init-admin.js 创建超级管理员（仅首次部署，幂等；
#      未配置 GX_INIT_ADMIN_EMAIL/PASSWORD 则跳过，详见 docs/deployment/first-admin-init.md）；
#   4) 最后 exec node dist/index.js（由 tini 转发信号，node 做优雅关闭）。
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

# 首次部署：创建超级管理员（幂等；users 表已有任何用户则打印"已初始化，跳过"并 exit 0）。
# 必须在 migrate deploy 之后（users 表要存在）、exec 起服务之前执行。
# 凭据由 compose 的 env_file（deploy/docker/gouxiangdb.env）注入；两者任一为空即跳过且
# 不阻断启动——首个通过 /api/auth/signup 注册的用户会自动成为所有者
# （apps/api/src/domain/org/members.ts 的 bootstrapFirstOwnerTx）。
# 退出码：0=已创建/检测到已初始化而跳过；64=生产环境未提供凭据；1=执行失败。
# 失败即非零退出、不 exec：容器按 compose restart 策略重启，此时尚未接任何流量。
if [[ -n "${GX_INIT_ADMIN_EMAIL:-}" && -n "${GX_INIT_ADMIN_PASSWORD:-}" ]]; then
  log "创建初始超级管理员：${GX_INIT_ADMIN_EMAIL}"
  rc=0
  node dist/init-admin.js || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    log "init-admin 失败（退出码 ${rc}）：未创建初始超级管理员，不启动 API"
    exit "$rc"
  fi
else
  log "未配置初始管理员凭据，跳过自动初始化（首个通过 /api/auth/signup 注册的用户会自动成为所有者）"
fi

log "迁移与导航重算完成，启动 GouXiangDB API（port=${PORT:-3001}）"
exec node dist/index.js
