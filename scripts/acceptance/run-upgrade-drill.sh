#!/usr/bin/env bash
# scripts/acceptance/run-upgrade-drill.sh
# 门② AC-UPG-1：v0.1.0 -> 当前 HEAD 直升零损坏演练总驱动（G2）。
#
# 权威顺序（顺序本身是零损坏可信度的一部分，勿随意调整）：
#   阶段0  环境/负载自检，准备 RUN_DIR（/tmp 下），记录 node/两 commit/迁移计数。
#   阶段1  全新旧库：v0.1.0 worktree 内 prisma migrate deploy（11 迁移）。
#   阶段2  tsx 起 v0.1.0 真服务 -> seed-legacy（五类对象+20主体+5分享）-> 停服。
#   阶段3  before 取证（dump 全表+uploads sha + blocks roundtrip）+ 旧库在线备份+恢复校验。
#   阶段4  复制为 upgraded.db；当前仓 prisma generate + build dist（三入口 test -f）；migrate deploy（11->23，两次幂等）。
#   阶段5  check-nav-paths（补强①：故障态 path=''/depth0 -> dist 发布物 --apply depth2/3 -> 二次幂等）。
#   阶段6  【纯净态】after 取证 + blocks roundtrip + diff-snapshot（含旧行时间戳零改动）
#          + check-bootstrap（B5：23 applied/0 rolled_back、ws=1、roles=5、owner 唯一、reason 三态、
#          change_events 播种计数、PAT/mcp 表空、主库无 search 表）。
#          —— 必须在任何 HTTP 写/停用之前，否则会把演练写操作误判成升级损坏/自举污染。
#   阶段7  起候选 dist 服务 -> verify-golden（authz 对账幂等/黄金主体/LCG 对拍/
#          部门子树/继承中断/g8 停用）-> check-share-links（R7 5/5 对抗矩阵）-> 停服。
#   阶段8  check-search（补强④ FTS-only：HTTP reindex/status 轮询/三态零泄漏/删库自愈，自管服务）。
#   阶段9  check-body-limits（R6 双实例：默认档 1.1M->413 与 /mcp 11MB；GX_BODY_LIMIT_JSON=3
#          公开 2,000,000->200 / 2,000,001->400，自管服务）。
#   收尾  汇总 run-manifest.json + REPORT.md（末行 DRILL_VERDICT，含每门实数/附件产品限制/cuid 口径）。
#
# 纪律：只跑本门与其调用的 build/migrate；不跑全量 api 门/e2e/打包。只按 PID 停自己起的服务。
# 产出全部落 RUN_DIR（默认 /tmp/gx-upgrade-drill-<stamp>）。脚本零仓库写入（dist 除外，构建产物）。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AC_DIR="$REPO_ROOT/scripts/acceptance"
API_DIR="$REPO_ROOT/apps/api"
OLD_API_DIR="/tmp/gx-v010/apps/api"
OLD_COMMIT="637eb9d"

NODE_BIN="$(command -v node)"
TSX_NEW="$API_DIR/node_modules/tsx/dist/cli.mjs"
PRISMA_NEW="$API_DIR/node_modules/prisma/build/index.js"
TSX_OLD="$OLD_API_DIR/node_modules/tsx/dist/cli.mjs"
PRISMA_OLD="$OLD_API_DIR/node_modules/prisma/build/index.js"
DIST_ENTRY="$API_DIR/dist/index.js"
DIST_MCP="$API_DIR/dist/mcp-stdio.js"
DIST_NAV="$API_DIR/dist/nav-reconcile.js"

STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="${GX_DRILL_RUN_DIR:-/tmp/gx-upgrade-drill-$STAMP}"
BEFORE_DIR="$RUN_DIR/before"
AFTER_DIR="$RUN_DIR/after"
DATA_DIR="$RUN_DIR/data"
BACKUP_DIR="$RUN_DIR/backup"
OLD_UPLOADS="$OLD_API_DIR/uploads"
OLD_PORT="${GX_DRILL_OLD_PORT:-33930}"
NEW_PORT="${GX_DRILL_NEW_PORT:-33931}"

mkdir -p "$RUN_DIR" "$BEFORE_DIR" "$AFTER_DIR" "$DATA_DIR" "$BACKUP_DIR"
STEPS_LOG="$RUN_DIR/steps.tsv"
: > "$STEPS_LOG"

log()  { printf '\n\033[1;36m[drill]\033[0m %s\n' "$*"; }
die()  { printf '\n[drill] FATAL: %s\n' "$*" >&2; exit 64; }

# 递归杀进程树：tsx 会派生一个真正监听端口的 node 子进程，只 kill 父会留孤儿占端口。
kill_tree() {
  local pid="$1" child
  [[ -z "$pid" ]] && return 0
  while read -r child; do
    [[ -n "$child" ]] && kill_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null)
  kill "$pid" 2>/dev/null || true
}

# 轮询等待进程树真正退出（递归子进程也须消失）。硬 SIGTERM 后若立刻让下一个 node 打开同一
# SQLite WAL 库，旧连接可能尚未释放热 WAL 帧——在 macOS 上曾观测到新进程首个 kbDoc.findMany()
# 报 SQLITE_CORRUPT(11) "database disk image is malformed"，而库事后 integrity_check=ok、
# 独立重跑稳定通过（典型热 WAL 交接竞态，非产品确定性缺陷）。故交接前必须等旧句柄彻底死亡。
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

# 从静止（无任何进程持有）的源库复制一致三件套到 scratch 目标，供阶段8/9 各自独立开库。
# 必须连同 -wal/-shm 一起复制，才能拿到含最新已提交帧的完整一致集；缺 wal 会丢 stage7 的写。
clone_db_triplet() {
  local src="$1" dst="$2"
  rm -f "$dst" "$dst-wal" "$dst-shm"
  cp "$src" "$dst"
  [[ -f "$src-wal" ]] && cp "$src-wal" "$dst-wal"
  [[ -f "$src-shm" ]] && cp "$src-shm" "$dst-shm"
}

# 在 apps/api 下跑 better-sqlite3（pnpm 依赖只在该目录可解析）对静止库做 WAL checkpoint(TRUNCATE)，
# 把热 WAL 帧固化进主文件，给后续阶段一个确定一致的快照。库路径用绝对路径，与 cwd 无关。
checkpoint_db() {
  local db="$1"
  ( cd "$API_DIR" && env CODEBUDDY_SAFE_DELETE_ENABLED=0 "$NODE_BIN" -e '
const Database = require("better-sqlite3");
const db = new Database(process.argv[1]);
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();
' "$db" )
}

# 任何中途 die/退出都回收本演练自起的服务（只按自记 PID，绝不碰无关 dev server）。
cleanup_servers() {
  local pf
  for pf in "$RUN_DIR/old.pid" "$RUN_DIR/new.pid"; do
    [[ -f "$pf" ]] && kill_tree "$(cat "$pf" 2>/dev/null)"
  done
}
trap cleanup_servers EXIT

# 启动前端口守卫：若已被占（几乎必是上次演练遗留孤儿），直接失败并点名，不再静默打到别人。
assert_port_free() {
  local port="$1"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    die "端口 $port 已被占用（疑似上次演练遗留服务）：$(lsof -nP -iTCP:$port -sTCP:LISTEN | tail -n +2 | awk '{print $1"/pid="$2}')。请先清理再跑"
  fi
}

# step <name> <cmd...> ：运行并记录 名称/退出码/耗时毫秒；非零不立即退出，由末尾汇总。
step() {
  local name="$1"; shift
  local start end dur rc
  start=$(node -e 'process.stdout.write(String(Date.now()))')
  log "$name"
  "$@"
  rc=$?
  end=$(node -e 'process.stdout.write(String(Date.now()))')
  dur=$((end - start))
  printf '%s\t%s\t%s\n' "$name" "$rc" "$dur" >> "$STEPS_LOG"
  printf '[drill]   -> exit=%s %sms\n' "$rc" "$dur"
  return $rc
}

# ---------------- 阶段0：环境自检 ----------------
log "RUN_DIR=$RUN_DIR"
command -v node >/dev/null || die "缺 node"
command -v curl >/dev/null || die "缺 curl"
[[ -d "$OLD_API_DIR" ]] || die "v0.1.0 worktree 不在 $OLD_API_DIR"
[[ -f "$TSX_NEW" && -f "$PRISMA_NEW" ]] || die "当前仓 tsx/prisma 未安装"
[[ -f "$TSX_OLD" && -f "$PRISMA_OLD" ]] || die "v0.1.0 tsx/prisma 未安装"
LOAD1=$(uptime | sed -E 's/.*load averages?: //' | cut -d. -f1 | awk '{print $1}')
if [[ "$LOAD1" -gt 8 ]]; then die "1 分钟负载 $LOAD1 > 8，按纪律暂停重型演练"; fi
NODE_VERSION="$(node -v)"
NEW_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
log "node=$NODE_VERSION old=$OLD_COMMIT new=$NEW_COMMIT load1=$LOAD1"

LEGACY_DB="$RUN_DIR/legacy.db"
UPGRADED_DB="$RUN_DIR/upgraded.db"
export DATABASE_URL="file:$LEGACY_DB"

# ---------------- 阶段1：全新旧库 11 迁移 ----------------
rm -f "$LEGACY_DB" "$LEGACY_DB-wal" "$LEGACY_DB-shm"
step "1-old-migrate-deploy" "$NODE_BIN" "$PRISMA_OLD" migrate deploy --schema "$OLD_API_DIR/prisma/schema.prisma" \
  || die "v0.1.0 migrate deploy 失败"

# ---------------- 阶段2：起旧服务 + 旧库播种 ----------------
start_old() {
  log "起 v0.1.0 旧服务 port=$OLD_PORT"
  assert_port_free "$OLD_PORT"
  ( cd "$OLD_API_DIR" && \
    NODE_ENV=development PORT="$OLD_PORT" DATABASE_URL="file:$LEGACY_DB" \
    JWT_SECRET="drill-secret-0123456789abcdef" GX_RATE_LIMIT=off \
    "$NODE_BIN" "$TSX_OLD" src/index.ts >"$RUN_DIR/old-server.log" 2>&1 ) &
  echo $! > "$RUN_DIR/old.pid"
}
start_old
# server.mjs 的健康轮询等价物：bash 轮询 /api/health
for i in $(seq 1 120); do
  if curl -sf -o /dev/null "http://127.0.0.1:$OLD_PORT/api/health"; then break; fi
  if ! kill -0 "$(cat "$RUN_DIR/old.pid")" 2>/dev/null; then die "旧服务提前退出，见 $RUN_DIR/old-server.log"; fi
  sleep 0.5
done
curl -sf -o /dev/null "http://127.0.0.1:$OLD_PORT/api/health" || die "旧服务健康检查超时"

mkdir -p "$OLD_UPLOADS"
step "2-seed-legacy" "$NODE_BIN" "$AC_DIR/seed-legacy.mjs" \
  --base-url "http://127.0.0.1:$OLD_PORT" \
  --db "$LEGACY_DB" --uploads "$OLD_UPLOADS" --out "$BEFORE_DIR" \
  || die "旧库播种失败"

OLD_PID="$(cat "$RUN_DIR/old.pid")"
log "停旧服务 pid=${OLD_PID}（含其 tsx 子进程）"
kill_tree "$OLD_PID"
wait_tree_gone "$OLD_PID" || log "警告：旧进程树未在 30s 内全部退出（继续，但见热 WAL 风险）"
rm -f "$RUN_DIR/old.pid"
# 旧连接彻底退出后固化 legacy WAL（它随后要被 dump/备份/复制为 upgraded.db，必须静止一致）。
checkpoint_db "$LEGACY_DB" || die "阶段2后 checkpoint 旧库失败"

# ---------------- 阶段3：before 取证 + 旧库备份/恢复校验 ----------------
step "3a-dump-before" "$NODE_BIN" "$AC_DIR/dump-records.mjs" \
  --db "$LEGACY_DB" --uploads "$OLD_UPLOADS" --out "$BEFORE_DIR"
step "3b-roundtrip-before" bash -c "cd '$API_DIR' && '$NODE_BIN' '$TSX_NEW' '$AC_DIR/blocks-roundtrip.mts' --snapshot '$BEFORE_DIR/snapshot.json' --out '$BEFORE_DIR/roundtrip.json'"
step "3c-online-backup" env DATABASE_URL="file:$LEGACY_DB" BACKUP_DIR="$BACKUP_DIR" UPLOAD_ROOT="$OLD_UPLOADS" \
  "$NODE_BIN" "$API_DIR/scripts/backup/online-backup.mjs"
# 恢复校验：online-backup 产物为扁平 daily/app-<stamp>.{db,manifest.json}（一次演练一个 stamp），
# 候选目录即 daily/（verify-restore 在该目录内找 app-*.db + manifest 对账 sha/迁移/计数）。
CANDIDATE="$BACKUP_DIR/daily"
[[ -n "$(ls -1 "$CANDIDATE"/app-*.db 2>/dev/null)" ]] || die "备份未产出 daily/app-*.db"
step "3d-verify-restore" "$NODE_BIN" "$API_DIR/scripts/backup/verify-restore.mjs" "$CANDIDATE"

# ---------------- 阶段4：复制升级库 + generate + build + migrate 11->23 ----------------
cp "$LEGACY_DB" "$UPGRADED_DB"
step "4a-prisma-generate" "$NODE_BIN" "$PRISMA_NEW" generate --schema "$API_DIR/prisma/schema.prisma"
# 候选构建必须真实成功：esbuild 先 rmSync 整个 dist（合法产品构建动作）。WorkBuddy agent shell
# 经 NODE_OPTIONS 注入 node-language-shim，把 fs.rmSync 劫持成走 genie-trash 的"安全删除"，
# 实测在该步 spawnSync 该二进制 ETIMEDOUT 致 build.mjs exit1（真实 CI/裸机/Docker 无此 shim，
# 走原生 rmSync），故仅对本构建步骤 CODEBUDDY_SAFE_DELETE_ENABLED=0 关 shim；且失败必须 die——
# 绝不允许在残留 dist 上继续验收（否则后续全绿也是在旧候选物上跑的，无意义）。
step "4b-build-dist" env CODEBUDDY_SAFE_DELETE_ENABLED=0 "$NODE_BIN" "$API_DIR/scripts/build.mjs" \
  || die "候选构建（build.mjs）失败；拒绝在残留 dist 上继续门②验收"
# 三发布入口必须齐全（缺件即环境错 exit 64，不继续往下打空发布物）。
for f in "$DIST_ENTRY" "$DIST_MCP" "$DIST_NAV"; do
  [[ -f "$f" ]] || die "build 后发布入口缺失：$f"
done
log "三发布入口齐全：index.js / mcp-stdio.js / nav-reconcile.js"
step "4c-migrate-deploy-upgrade" env DATABASE_URL="file:$UPGRADED_DB" \
  "$NODE_BIN" "$PRISMA_NEW" migrate deploy --schema "$API_DIR/prisma/schema.prisma" || die "升级 migrate deploy 失败"

# ---------------- 阶段5：补强① nav 故障态/修复/幂等 ----------------
step "5-check-nav-paths" "$NODE_BIN" "$AC_DIR/check-nav-paths.mjs" \
  --db "$UPGRADED_DB" --out "$AFTER_DIR" --api-dir "$API_DIR" --dist "$DIST_NAV"

# ---------------- 阶段6：纯净态 after 取证 + 零损坏 diff ----------------
step "6a-dump-after" "$NODE_BIN" "$AC_DIR/dump-records.mjs" \
  --db "$UPGRADED_DB" --uploads "$OLD_UPLOADS" --out "$AFTER_DIR"
step "6b-roundtrip-after" bash -c "cd '$API_DIR' && '$NODE_BIN' '$TSX_NEW' '$AC_DIR/blocks-roundtrip.mts' --snapshot '$AFTER_DIR/snapshot.json' --out '$AFTER_DIR/roundtrip.json'"
step "6c-diff-snapshot" "$NODE_BIN" "$AC_DIR/diff-snapshot.mjs" "$BEFORE_DIR" "$AFTER_DIR"
# B5 新表面自举固定期望（纯净态、纯只读裸 SQL；此时尚无任何候选服务写/PAT/MCP 流量，
# reason 三态恰为迁移投影，PAT/mcp 表为空）。embedding off 旁证在阶段8 经 search status 留。
step "6d-check-bootstrap" "$NODE_BIN" "$AC_DIR/check-bootstrap.mjs" \
  --db "$UPGRADED_DB" --out "$AFTER_DIR"

# ---------------- 阶段6e：通电前 authz 存量投影（runbook §6.7.1 钦定序列） ----------------
# 必须排在 6d【之后】：6d 断言纯迁移态 reason 恰为三态 legacy:*、无 scope:role，先投影会污染。
# 必须排在起候选服务（阶段7）之前：让首次对外服务时 scope:role 投影已就位，模拟真实升级流程。
# 顺序固定为 reconcile-policies --apply -> project-scope --apply：
#   前者修 legacy 投影漂移（A1/A2/B1-B3，顺带按 S 段重建 scope 角色）；
#   后者是 runbook §6.7.1 指定的【存量 scope 投影】专用入口（单事务幂等，只写 scope:role）。
# 两 CLI 无 dist 发布入口（禁止为此改 build.mjs），用仓内 tsx 直跑源码，cwd=apps/api。
# 注：role_owner 被 scopeBackfill 硬短路、永不投 scope:role（owner 授权走 legacy:member），
# 故投影主体仅 role_admin；A3 已豁免机器 scope:role 行（其漂移只由 S 段对账）。
step "6e1-reconcile-policies-apply" bash -c \
  "cd '$API_DIR' && DATABASE_URL='file:$UPGRADED_DB' '$NODE_BIN' '$TSX_NEW' scripts/authz/reconcile-policies.ts --apply"
step "6e2-project-scope-apply" bash -c \
  "cd '$API_DIR' && DATABASE_URL='file:$UPGRADED_DB' '$NODE_BIN' '$TSX_NEW' scripts/authz/project-scope.ts --apply"
# 二次只读复核：project-scope 已幂等（no changes，rc=0）。reconcile 的 A/B/C/S 全 0 + no changes
# 由阶段7a verify-golden 的 D 段在服务流量介入前再独立复核一次。
step "6e3-project-scope-readonly-idempotent" bash -c \
  "cd '$API_DIR' && DATABASE_URL='file:$UPGRADED_DB' '$NODE_BIN' '$TSX_NEW' scripts/authz/project-scope.ts --json"

# ---------------- 阶段7：候选服务 -> golden + share ----------------
start_new() {
  log "起候选 dist 服务 port=$NEW_PORT"
  assert_port_free "$NEW_PORT"
  ( cd "$API_DIR" && \
    NODE_ENV=development PORT="$NEW_PORT" DATABASE_URL="file:$UPGRADED_DB" \
    JWT_SECRET="drill-secret-0123456789abcdef" GX_RATE_LIMIT=off \
    GX_DATA_DIR="$DATA_DIR" UPLOAD_ROOT="$OLD_UPLOADS" \
    "$NODE_BIN" "$DIST_ENTRY" >"$RUN_DIR/new-server.log" 2>&1 ) &
  echo $! > "$RUN_DIR/new.pid"
}
start_new
for i in $(seq 1 120); do
  if curl -sf -o /dev/null "http://127.0.0.1:$NEW_PORT/healthz"; then break; fi
  if ! kill -0 "$(cat "$RUN_DIR/new.pid")" 2>/dev/null; then die "候选服务提前退出，见 $RUN_DIR/new-server.log"; fi
  sleep 0.5
done
curl -sf -o /dev/null "http://127.0.0.1:$NEW_PORT/healthz" || die "候选服务健康检查超时"

NEW_BASE="http://127.0.0.1:$NEW_PORT"
step "7a-verify-golden" "$NODE_BIN" "$AC_DIR/verify-golden.mjs" \
  --base-url "$NEW_BASE" --db "$UPGRADED_DB" --manifest "$BEFORE_DIR/manifest.json" \
  --out "$AFTER_DIR" --api-dir "$API_DIR"
step "7b-check-share-links" bash -c \
  "bash '$AC_DIR/check-share-links.sh' '$NEW_BASE' '$BEFORE_DIR/manifest.json' | tee '$AFTER_DIR/share-links.log'"

NEW_PID="$(cat "$RUN_DIR/new.pid")"
log "停候选服务 pid=${NEW_PID}（含其 tsx 子进程）"
kill_tree "$NEW_PID"
wait_tree_gone "$NEW_PID" || log "警告：候选进程树未在 30s 内全部退出（继续，但见热 WAL 风险）"
rm -f "$RUN_DIR/new.pid"
# 旧连接彻底释放后，固化 WAL 帧到主库文件（TRUNCATE），给阶段8/9 一个静止、确定的库快照。
# 历史故障：硬杀后只 sleep 1 就让新 node 打开同一 20MB 热 WAL 库，曾触发 SQLITE_CORRUPT(11)
# 误报（库本身 integrity_check=ok）；checkpoint 到静止态彻底消除该交接竞态。
checkpoint_db "$UPGRADED_DB" || die "阶段7后 checkpoint 升级库失败"

# ---------------- 阶段8：搜索 FTS-only（独立副本库，纯净态之后） ----------------
# 用静止 upgraded.db 的一致副本，物理隔离热 WAL；search 内部还会做删库自愈，绝不碰证据主库。
SEARCH_DB="$RUN_DIR/search-scratch.db"
clone_db_triplet "$UPGRADED_DB" "$SEARCH_DB"
step "8-check-search" "$NODE_BIN" "$AC_DIR/check-search.mjs" \
  --db "$SEARCH_DB" --data-dir "$DATA_DIR" --dist "$DIST_ENTRY" \
  --manifest "$BEFORE_DIR/manifest.json" --out "$AFTER_DIR" --api-dir "$API_DIR"

# ---------------- 阶段9：body 边界双实例（独立副本库，最后跑：会大尺寸改写 scratch） ----------------
# 阶段9 会对库做 2MB/10MB 大尺寸写，再复制一份，避免污染阶段8/最终证据库 upgraded.db。
BODY_DB="$RUN_DIR/body-scratch.db"
clone_db_triplet "$UPGRADED_DB" "$BODY_DB"
step "9-check-body-limits" "$NODE_BIN" "$AC_DIR/check-body-limits.mjs" \
  --db "$BODY_DB" --data-dir "$DATA_DIR" --dist "$DIST_ENTRY" \
  --manifest "$BEFORE_DIR/manifest.json" --out "$AFTER_DIR" --api-dir "$API_DIR"

# ---------------- 收尾：run-manifest.json ----------------
OLD_MIG_COUNT=$(find "$OLD_API_DIR/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
NEW_MIG_COUNT=$(find "$API_DIR/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')

"$NODE_BIN" "$AC_DIR/build-manifest.mjs" \
  --run-dir "$RUN_DIR" --node-version "$NODE_VERSION" \
  --old-commit "$OLD_COMMIT" --new-commit "$NEW_COMMIT" \
  --old-mig "$OLD_MIG_COUNT" --new-mig "$NEW_MIG_COUNT" \
  || die "run-manifest.json 汇总失败"

log "演练完成。产物：$RUN_DIR"
log "run-manifest: $RUN_DIR/run-manifest.json"

# REPORT.md（末行 DRILL_VERDICT；即使有门失败也生成，便于定位）。build-report 自身按汇总 verdict 退 0/1。
step "10-build-report" "$NODE_BIN" "$AC_DIR/build-report.mjs" --run-dir "$RUN_DIR"
REPORT_RC=$?
log "REPORT: $RUN_DIR/REPORT.md"
tail -n 1 "$RUN_DIR/REPORT.md" 2>/dev/null || true

# 汇总各门 exit（备份/roundtrip 等非关键门失败也在 steps 留痕，但主门 fail 则非零退出）
FAILED_STEPS=$(awk -F'\t' '$2!=0{n=n" "$1} END{print n}' "$STEPS_LOG")
if [[ -n "$FAILED_STEPS" ]]; then
  log "存在失败步骤：$FAILED_STEPS"
  exit 1
fi
if [[ "$REPORT_RC" -ne 0 ]]; then
  log "REPORT 汇总 DRILL_VERDICT=FAIL（见 REPORT.md 各门判定）"
  exit 1
fi
log "所有步骤 exit=0 且 DRILL_VERDICT=PASS（注意：是否过闸以 team-lead 独立重跑为准，本脚本不宣称门②过闸）"
