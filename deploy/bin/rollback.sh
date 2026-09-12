#!/usr/bin/env bash
# deploy/bin/rollback.sh — GouXiangDB 30 秒级应用回滚（M0 S8）。
#
# 在目标机以 root 运行：
#   sudo bash deploy/bin/rollback.sh            # 回滚到上一版
#   sudo bash deploy/bin/rollback.sh 20260920-1 # 回滚到指定 release（releases/ 下目录名）
#
# 语义：只回“应用”，不回“数据”。M0 迁移只增且向后兼容，切回旧二进制通常仍能跑新库；
#       只有迁移本身损坏/需撤销时才按 docs/runbooks/restore.md 做数据库时间点恢复。

set -euo pipefail

SRV_ROOT="/srv/gouxiangdb"
RELEASES_ROOT="${SRV_ROOT}/releases"
CURRENT="${SRV_ROOT}/current"
ENV_FILE="/etc/gouxiangdb/env.conf"
SERVICE="gouxiangdb-api"
READY_TIMEOUT_S="${READY_TIMEOUT_S:-30}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_rst=$'\033[0m'
say() { printf '%s[rollback]%s %s\n' "$c_grn" "$c_rst" "$*"; }
warn() { printf '%s[rollback][warn]%s %s\n' "$c_yel" "$c_rst" "$*" >&2; }
die() { printf '%s[rollback][fatal]%s %s\n' "$c_red" "$c_rst" "$*" >&2; exit 1; }

command -v systemctl >/dev/null || die "目标机无 systemctl"
[[ -L "$CURRENT" || -d "$CURRENT" ]] || die "没有 ${CURRENT}，无法回滚"

CUR_NAME="$(basename "$(readlink -f "$CURRENT")")"

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  # 选 releases/ 中严格早于当前版本的最近一个（按时间戳名倒序取第一个不等于当前的）。
  TARGET="$(find "$RELEASES_ROOT" -maxdepth 1 -mindepth 1 -type d -name '20*' \
              | sed 's#.*/##' | sort -r | awk -v cur="$CUR_NAME" '$0<cur{print; exit}')"
fi
[[ -n "$TARGET" ]] || die "找不到可回滚的历史 release（当前 ${CUR_NAME}）"
TARGET_DIR="${RELEASES_ROOT}/${TARGET}"
[[ -f "${TARGET_DIR}/api/dist/index.js" ]] || die "目标 release 不完整：${TARGET_DIR}"

say "当前 $CUR_NAME -> 回滚到 $TARGET"

# env 仅用于拿 PORT 做 readyz 轮询；读取失败不阻断回滚本身。
PORT=3001
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  PORT="$(set -a; source "$ENV_FILE" 2>/dev/null; set +a; printf '%s' "${PORT:-3001}")"
fi

ln -sfn "releases/${TARGET}" "$CURRENT"
systemctl restart "$SERVICE"

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
  say "已回滚到 ${TARGET}，/readyz 健康（${READY_TIMEOUT_S}s 内）"
  say "提示：应用已回滚但数据库未动。若问题源于某次迁移，按 docs/runbooks/restore.md 恢复数据。"
else
  printf '%s[rollback][fatal]%s 回滚后 %ss 内仍未就绪：journalctl -u %s\n' "$c_red" "$c_rst" "$READY_TIMEOUT_S" "$SERVICE" >&2
  exit 1
fi
