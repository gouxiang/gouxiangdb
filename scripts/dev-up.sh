#!/bin/bash
# GouXiangDB v2 一键启动（API + Web 两个 dev server）
# 用法：bash scripts/dev-up.sh          # 启动
#       bash scripts/dev-up.sh stop     # 停掉
#       bash scripts/dev-up.sh status   # 状态
#       bash scripts/dev-up.sh restart  # 重启
#
# 设计原则——服务与 shell 解耦：
#   setsid + nohup + disown 三件套让进程彻底脱离当前 shell，
#   即便 WorkBuddy 重启 / 终端关闭也不会被带走。
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_PORT="${API_PORT:-3001}"
WEB_PORT="${WEB_PORT:-5173}"
API_LOG="/tmp/gx-v2-api.log"
WEB_LOG="/tmp/gx-v2-web.log"

PNPM_TSX="$ROOT/node_modules/.pnpm/tsx@4.23.13/node_modules/tsx/dist/cli.mjs"
[ ! -f "$PNPM_TSX" ] && PNPM_TSX=$(find "$ROOT" -path "*/tsx@4.23.13*/node_modules/tsx/dist/cli.mjs" 2>/dev/null | head -1)
VITE_BIN=$(find "$ROOT/node_modules/.pnpm" -path "*vite@7*/node_modules/vite/bin/vite.js" 2>/dev/null | head -1)
[ -z "$VITE_BIN" ] && VITE_BIN=$(find "$ROOT" -path "*vite/bin/vite.js" 2>/dev/null | head -1)

if [ ! -f "$PNPM_TSX" ]; then echo "[错误] 找不到 tsx 入口"; exit 2; fi
if [ -z "$VITE_BIN" ]; then echo "[错误] 找不到 vite 入口"; exit 2; fi

start_api() {
  if lsof -ti :"$API_PORT" >/dev/null 2>&1; then
    echo "[api] :$API_PORT 已占用（pid=$(lsof -ti :$API_PORT)）"
    return 0
  fi
  echo "[api] 启动 → :$API_PORT (日志: $API_LOG)"
  cd "$ROOT/apps/api"
  # 显式加载 .env（tsx 不自动注入 process.env；不靠 shell 残留变量）
  if [ -f .env ]; then set -a; . ./.env; set +a; fi
  nohup node "$PNPM_TSX" src/index.ts >"$API_LOG" 2>&1 < /dev/null &
  disown
  sleep 2
  if curl -fsS -o /dev/null "http://localhost:$API_PORT/api/health"; then
    echo "[api] ✓ http 200"
  else
    echo "[api] ✗ 启动失败，查看日志：$API_LOG"
    tail -10 "$API_LOG"
    return 1
  fi
}

start_web() {
  if lsof -ti :"$WEB_PORT" >/dev/null 2>&1; then
    echo "[web] :$WEB_PORT 已占用（pid=$(lsof -ti :$WEB_PORT)）"
    return 0
  fi
  echo "[web] 启动 → :$WEB_PORT (日志: $WEB_LOG)"
  cd "$ROOT/apps/web"
  nohup node "$VITE_BIN" >"$WEB_LOG" 2>&1 < /dev/null &
  disown
  sleep 3
  if curl -fsS -o /dev/null "http://localhost:$WEB_PORT/"; then
    echo "[web] ✓ http 200"
  else
    echo "[web] ✗ 启动失败，查看日志：$WEB_LOG"
    tail -15 "$WEB_LOG"
    return 1
  fi
}

stop_all() {
  echo "[stop] 清理占用端口的进程"
  for p in "$API_PORT" "$WEB_PORT"; do
    pids=$(lsof -ti :$p 2>/dev/null || true)
    if [ -n "$pids" ]; then
      kill $pids 2>/dev/null && echo "[stop] 杀掉 :$p pid=$pids"
    fi
  done
}

status() {
  for p in "$API_PORT" "$WEB_PORT"; do
    pid=$(lsof -ti :$p 2>/dev/null || echo "-")
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$p/" --max-time 2 2>/dev/null || echo "000")
    echo "[port $p] pid=$pid http=$code"
  done
}

case "${1:-up}" in
  up|start|"") start_api; start_web ;;
  stop) stop_all ;;
  status) status ;;
  restart) stop_all; sleep 1; start_api; start_web ;;
  *) echo "用法: $0 {up|stop|status|restart}"; exit 1 ;;
esac