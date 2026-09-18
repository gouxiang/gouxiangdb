#!/usr/bin/env bash
# deploy/bin/deploy.sh — GouXiangDB 裸机幂等部署（M0 S8）。
#
# 在目标机以 root（或对 /srv、/etc/systemd 有权限的用户）运行：
#   sudo bash deploy/bin/deploy.sh --release /path/to/gouxiangdb-release-*.tar.gz
#
# 流程：环境检查 → 当前 readyz 探活 → 强制在线快照（无快照不继续）→ 解包到
#       releases/<ts> → checksum 校验 → prisma migrate deploy（生产 env，只增迁移）
#       → nav-reconcile --apply（迁移后 path 重算，M3-S11-A/AC-UPG-1）
#       → init-admin（仅首次部署创建超级管理员，幂等；无凭据则跳过）
#       → ln -sfn 原子切换 → systemctl restart → 轮询 readyz 最多 30s
#       → 失败自动回滚 → 成功则保留最近 N 个 release。
#
# 安全：本脚本只允许 `prisma migrate deploy`；任何“非交互迁移/重置”用法被自检拒绝。

set -euo pipefail

SRV_ROOT="/srv/gouxiangdb"
RELEASES_ROOT="${SRV_ROOT}/releases"
CURRENT="${SRV_ROOT}/current"
ENV_FILE="/etc/gouxiangdb/env.conf"
SERVICE="gouxiangdb-api"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
READY_TIMEOUT_S="${READY_TIMEOUT_S:-30}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_rst=$'\033[0m'
say() { printf '%s[deploy]%s %s\n' "$c_grn" "$c_rst" "$*"; }
warn() { printf '%s[deploy][warn]%s %s\n' "$c_yel" "$c_rst" "$*" >&2; }
die() { printf '%s[deploy][fatal]%s %s\n' "$c_red" "$c_rst" "$*" >&2; exit 1; }

TARBALL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) TARBALL="$2"; shift 2 ;;
    *) die "未知参数：$1（用法：deploy.sh --release <tar.gz>）" ;;
  esac
done
[[ -n "$TARBALL" ]] || die "必须用 --release 指定发布包"
[[ -f "$TARBALL" ]] || die "发布包不存在：$TARBALL"

[[ -f "$ENV_FILE" ]] || die "缺少 ${ENV_FILE}（先按 deploy/env.conf.example 建 600 配置）"
command -v systemctl >/dev/null || die "目标机无 systemctl（仅支持 systemd 裸机）"
[[ -x "$NODE_BIN" ]] || die "$NODE_BIN 不存在，可用 NODE_BIN=/path/node 覆盖"

# 载入生产环境变量（set -a 使 source 的变量 export；env 文件仅 KEY=VALUE 与注释）。
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${NODE_ENV:=}"; : "${DATABASE_URL:=}"; : "${PORT:=3001}"
[[ "$NODE_ENV" == "production" ]] || die "env.conf 必须 NODE_ENV=production（当前 '${NODE_ENV}'）"
[[ "$DATABASE_URL" == file:/* ]] || die "DATABASE_URL 必须是绝对 file:/ 路径（当前 '${DATABASE_URL}'）"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
NEW_REL="${RELEASES_ROOT}/${STAMP}"

# ---------------------------------------------------------------------------
# 1) 当前实例探活（仅信息性）；首次部署无 current 时跳过。
# ---------------------------------------------------------------------------
PREV_REL=""
if [[ -L "$CURRENT" || -d "$CURRENT" ]]; then
  PREV_REL="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  say "当前版本：${PREV_REL}"
  if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/readyz" >/dev/null 2>&1; then
    say "当前实例 /readyz 健康"
  else
    warn "当前实例 /readyz 不健康或未运行，仍继续（部署可能用于修复）"
  fi
else
  warn "未发现 ${CURRENT}，按【首次部署】处理（无在线快照可做）"
fi

# ---------------------------------------------------------------------------
# 2) 发布前强制在线快照：有在运行版本时，没有成功快照绝不继续。
# ---------------------------------------------------------------------------
if [[ -n "$PREV_REL" && -f "${PREV_REL}/api/scripts/backup/online-backup.mjs" ]]; then
  say "执行发布前在线一致性快照（S6）"
  ( cd "${PREV_REL}/api" && "$NODE_BIN" scripts/backup/online-backup.mjs ) \
    || die "发布前在线快照失败；为安全起见中止部署。修好备份后重试（恢复见 docs/runbooks/restore.md）"
else
  if [[ -n "$PREV_REL" ]]; then
    die "当前版本缺少备份脚本，无法做发布前快照，中止（请勿绕过）"
  fi
fi

# ---------------------------------------------------------------------------
# 3) 解包到新版本目录并校验 checksum（先解到 .stage，校验通过再原子 rename）。
# ---------------------------------------------------------------------------
STAGE="${NEW_REL}.stage"
rm -rf "$STAGE"; mkdir -p "$STAGE"
say "解包 $TARBALL -> $STAGE"
tar -xzf "$TARBALL" -C "$STAGE"
[[ -f "$STAGE/api/dist/index.js" ]] || die "包内缺少 api/dist/index.js"
[[ -f "$STAGE/web/index.html" ]] || die "包内缺少 web/index.html"
[[ -f "$STAGE/checksums.txt" ]] || die "包内缺少 checksums.txt"
( cd "$STAGE" && shasum -a 256 -c checksums.txt >/dev/null ) \
  || die "checksum 校验失败，拒绝部署（包可能损坏/被篡改）"
say "checksum 校验通过"

# 显式禁带物最后一道闸（env.conf 与任何库/日志都不应来自发布包）。
if find "$STAGE" -path "*/node_modules" -prune -o \( -name ".env" -o -name "*.db" -o -name "*.db-wal" -o -name "*.db-shm" -o -name "*.logl" \) -print | grep -q .; then
  die "发布包含禁带文件（.env/*.db*/*.logl），拒绝部署"
fi

# ---------------------------------------------------------------------------
# 4) 在新版本目录用生产 env 跑迁移（仅 migrate deploy，只增、已应用则跳过）。
#    白名单守卫：迁移子命令必须是 deploy；出现 dev/reset/diff 等即拒绝（防误改丢数据）。
# ---------------------------------------------------------------------------
MIGRATE_ARGS=(migrate deploy --schema=prisma/schema.prisma)
GUARD="${MIGRATE_ARGS[*]}"
case "$GUARD" in
  "migrate deploy"*) ;;
  *) die "非法迁移命令 '${GUARD}'；部署只允许 'migrate deploy'" ;;
esac
if printf '%s' "$GUARD" | grep -Eq '(^|[[:space:]])(dev|reset|diff|db[[:space:]]+push)([[:space:]]|$)'; then
  die "迁移参数含禁止子命令（dev/reset/diff/db push）：$GUARD"
fi
say "迁移（prisma migrate deploy）"
( cd "$STAGE/api" && DATABASE_URL="$DATABASE_URL" \
    "$NODE_BIN" node_modules/prisma/build/index.js "${MIGRATE_ARGS[@]}" ) \
  || die "migrate deploy 失败；新版本未切换，现网不受影响。按 restore.md 评估后处理。"

# ---------------------------------------------------------------------------
# 4b) 迁移后、原子切换前：nav path 全量重算（M3-S11-A / AC-UPG-1）。
#     迁移 B 只给根节点（base/kb）path，非根节点 path/depth 留空；必须在此跑一次
#     dist/nav-reconcile.js --apply 重建，否则深层 tree 索引缺节点、菜单 shortcut 全 disabled。
#     必须先于 symlink 切换与 systemctl restart：失败即 die，与 migrate 失败同姿态，
#     现网仍跑旧版本完全不受影响。exit 1=仍有 A/B/C 阻断差异；64=用法/环境/库缺失。
# ---------------------------------------------------------------------------
say "迁移后导航 path 重算（nav-reconcile --apply）"
( cd "$STAGE/api" && DATABASE_URL="$DATABASE_URL" \
    "$NODE_BIN" dist/nav-reconcile.js --apply ) \
  || die "nav reconcile 失败；新版本未切换，现网不受影响。"

# ---------------------------------------------------------------------------
# 4c) 迁移 + nav 重算之后、原子切换之前：首次部署创建超级管理员（幂等）。
#     users 表已有任何用户时脚本打印"已初始化，跳过"并 exit 0，绝不重复创建；
#     这是为了不与"首个注册用户自动成为所有者"抢跑（bootstrapFirstOwnerTx 仅在
#     该用户是唯一用户且尚无 user 级 owner 授予时才授予）。
#     凭据来自 /etc/gouxiangdb/env.conf（本脚本开头已 set -a; source 注入本进程环境）。
#     两者任一为空即跳过（warn，不阻断部署）；失败与 migrate/nav 同姿态：die 在 symlink
#     切换之前，现网仍跑旧版本完全不受影响。详见 docs/deployment/first-admin-init.md。
# ---------------------------------------------------------------------------
if [[ -n "${GX_INIT_ADMIN_EMAIL:-}" && -n "${GX_INIT_ADMIN_PASSWORD:-}" ]]; then
  say "创建初始超级管理员：${GX_INIT_ADMIN_EMAIL}"
  ( cd "$STAGE/api" && DATABASE_URL="$DATABASE_URL" \
      "$NODE_BIN" dist/init-admin.js ) \
    || die "init-admin 失败；新版本未切换，现网不受影响。修好 GX_INIT_ADMIN_EMAIL/GX_INIT_ADMIN_PASSWORD 后重跑 deploy.sh 即可（脚本幂等）。"
else
  warn "未配置初始管理员凭据，跳过自动初始化（首个通过 /api/auth/signup 注册的用户会自动成为所有者）"
fi

# ---------------------------------------------------------------------------
# 5) 原子切换 current → restart → 30s readyz 轮询；失败自动回滚。
# ---------------------------------------------------------------------------
mv "$STAGE" "$NEW_REL"
ln -sfn "releases/${STAMP}" "$CURRENT"
say "current -> releases/${STAMP}；systemctl restart $SERVICE"
systemctl restart "$SERVICE"

rollback_to_prev() {
  warn "开始回滚到上一版本：${PREV_REL:-（无，首次部署）}"
  if [[ -n "$PREV_REL" && -d "$PREV_REL" ]]; then
    local prev_link
    prev_link="$(basename "$PREV_REL")"
    ln -sfn "releases/${prev_link}" "$CURRENT"
    systemctl restart "$SERVICE" || true
    if wait_ready; then say "已回滚到 ${prev_link} 且 readyz 健康"; else warn "回滚后仍不健康，请人工介入（journalctl -u ${SERVICE}）"; fi
  else
    systemctl stop "$SERVICE" || true
    warn "首次部署失败已停服；数据未迁移破坏时可排查后重新部署"
  fi
}

wait_ready() {
  local i
  for ((i = 0; i < READY_TIMEOUT_S; i++)); do
    if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/readyz" 2>/dev/null \
         | grep -q '"status":"ready"'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if wait_ready; then
  say "新版本 readyz 健康（${READY_TIMEOUT_S}s 内）"
else
  printf '%s[deploy][fatal]%s 新版本 %ss 内未就绪\n' "$c_red" "$c_rst" "$READY_TIMEOUT_S" >&2
  rollback_to_prev
  exit 1
fi

# ---------------------------------------------------------------------------
# 6) 保留最近 KEEP_RELEASES 个 release（按时间戳名排序），其余删除（不删备份）。
# ---------------------------------------------------------------------------
mapfile -t old < <(find "$RELEASES_ROOT" -maxdepth 1 -mindepth 1 -type d -name '20*' \
                    ! -name "$STAMP" ! -path "*.stage" | sort -r | tail -n "+$((KEEP_RELEASES + 1))")
for d in "${old[@]:-}"; do
  [[ -n "$d" ]] && { warn "清理旧 release：$d"; rm -rf "$d"; }
done

say "部署完成：releases/${STAMP}"
say "健康检查：curl -fsS https://<域名>/readyz"
