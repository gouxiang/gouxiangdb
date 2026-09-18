#!/usr/bin/env bash
# scripts/acceptance/rollback-lib.sh
# 门③回滚演练共享生命周期函数（被 run-rollback-drill.sh source）。单一职责：
# 端口守卫、按自记 PID 杀进程树、等待树消失、静止库三件套复制、WAL checkpoint、
# 以指定 flag 姿态起 dist 服务、轮询 /readyz 并测恢复秒数、停服后核对端口归属。
#
# 纪律：只 kill 本演练记录的 PID（绝不 pkill）；只操作 RUN_DIR(/tmp)；负载>8 不自启。

# 由驱动导出：REPO_ROOT API_DIR AC_DIR NODE_BIN DIST_ENTRY DIST_MCP PRISMA RUN_DIR ROLL_DIR RB_PORT

kill_tree() {
  local pid="$1" child
  [[ -z "$pid" ]] && return 0
  while read -r child; do
    [[ -n "$child" ]] && kill_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null)
  kill "$pid" 2>/dev/null || true
}

wait_tree_gone() {
  local root="$1" i
  for i in $(seq 1 120); do
    if ! kill -0 "$root" 2>/dev/null && [[ -z "$(pgrep -P "$root" 2>/dev/null)" ]]; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

assert_port_free() {
  local port="$1"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[rb-lib] FATAL 端口 $port 被占：$(lsof -nP -iTCP:$port -sTCP:LISTEN | tail -n +2 | awk '{print $1"/pid="$2}')" >&2
    return 1
  fi
}

listening_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -n1; }

# 对静止库 WAL checkpoint(TRUNCATE)，固化成确定一致快照（须在 apps/api 下解析 better-sqlite3）。
checkpoint_db() {
  local db="$1"
  ( cd "$API_DIR" && env CODEBUDDY_SAFE_DELETE_ENABLED=0 "$NODE_BIN" -e '
const Database = require("better-sqlite3");
const db = new Database(process.argv[1]);
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();
' "$db" )
}

# 从静止源库复制 db/-wal/-shm 三件套到 stage 目标。
clone_db_triplet() {
  local src="$1" dst="$2"
  rm -f "$dst" "$dst-wal" "$dst-shm"
  cp "$src" "$dst"
  [[ -f "$src-wal" ]] && cp "$src-wal" "$dst-wal"
  [[ -f "$src-shm" ]] && cp "$src-shm" "$dst-shm"
}

# 通用停服：kill 自记 PID -> 等树消失 -> 确认端口释放。
stop_stage_server() {
  local stage="$1"
  local pidfile="$RUN_DIR/stages/$stage.pid"
  [[ -f "$pidfile" ]] || return 0
  local pid; pid="$(cat "$pidfile" 2>/dev/null)"
  kill_tree "$pid"
  if ! wait_tree_gone "$pid"; then
    echo "[rb-lib] WARN $stage 进程树未在 30s 内全退（继续，但见热 WAL 风险）" >&2
  fi
  rm -f "$pidfile"
  local i owner
  for i in $(seq 1 40); do
    owner="$(listening_pid "$RB_PORT")"
    [[ -z "$owner" ]] && return 0
    sleep 0.25
  done
  echo "[rb-lib] FATAL $stage 停服后端口 $RB_PORT 仍被 pid=$owner 占用" >&2
  return 1
}

now_ms() { "$NODE_BIN" -e 'process.stdout.write(String(Date.now()))'; }

# start_stage <stage> <db_abs> <data_dir> <netguard:0|1> <env assignments...>
# 起 dist 服务，把起始毫秒写入 $stage.t0；调用方随后用 wait_readyz_stage 轮询。
start_stage() {
  local stage="$1" db="$2" datadir="$3" netguard="$4"; shift 4
  assert_port_free "$RB_PORT" || return 1
  mkdir -p "$datadir" "$RUN_DIR/checks"
  local pidfile="$RUN_DIR/stages/$stage.pid" logfile="$RUN_DIR/stages/$stage.log"
  local -a extra=("$@")
  # 所有环境变量统一经 env KEY=VALUE 传给 node（env 在非赋值参数处停止取赋值）。
  local -a envargs=(
    NODE_ENV=development
    PORT="$RB_PORT"
    DATABASE_URL="file:$db"
    JWT_SECRET="drill-secret-0123456789abcdef"
    GX_RATE_LIMIT=off
    GX_DATA_DIR="$datadir"
    GX_SEARCH_DB_PATH="$datadir/search.db"
    GX_EMBEDDING_MODE=off
  )
  envargs+=("${extra[@]}")
  if [[ "$netguard" == "1" ]]; then
    : > "$RUN_DIR/stages/$stage.netlog"
    envargs+=(GX_NETGUARD_LOG="$RUN_DIR/stages/$stage.netlog"
      NODE_OPTIONS="--import $ROLL_DIR/netguard.mjs")
  fi
  # exec：让后台记录的 PID 就是监听端口的 node 本身（而非中间 subshell），PID 归属核查才成立。
  ( cd "$API_DIR" && exec env "${envargs[@]}" "$NODE_BIN" "$DIST_ENTRY" >"$logfile" 2>&1 ) &
  echo $! > "$pidfile"
  now_ms > "$RUN_DIR/stages/$stage.t0"
}

# wait_readyz_stage <stage> ：轮询 /readyz 至 200，stdout 输出恢复秒（毫秒精度，3 位小数）；
# 并核对监听 PID==自记 PID，杜绝探针打在旧进程。失败返回非零。
wait_readyz_stage() {
  local stage="$1"
  local pidfile="$RUN_DIR/stages/$stage.pid"
  local pid; pid="$(cat "$pidfile")"
  local i
  for i in $(seq 1 120); do
    if curl -sf -o /dev/null "http://127.0.0.1:$RB_PORT/readyz"; then
      local t0 now ms owner rec
      t0="$(cat "$RUN_DIR/stages/$stage.t0")"; now="$(now_ms)"; ms=$((now - t0))
      owner="$(listening_pid "$RB_PORT")"
      if [[ "$owner" != "$pid" ]]; then
        echo "[rb-lib] FATAL ${stage} readyz 命中非本进程：监听 pid=${owner} 自记 pid=${pid}（探针可能打在旧进程）" >&2
        return 1
      fi
      rec="$("$NODE_BIN" -e "process.stdout.write(($ms/1000).toFixed(3))")"
      echo "$rec"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[rb-lib] FATAL $stage 服务提前退出，见 $RUN_DIR/stages/$stage.log" >&2
      tail -n 20 "$RUN_DIR/stages/$stage.log" >&2 || true
      return 1
    fi
    sleep 0.5
  done
  echo "[rb-lib] FATAL $stage /readyz 60s 未就绪" >&2
  return 1
}
