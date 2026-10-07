#!/usr/bin/env bash
# scripts/acceptance/run-rollback-drill.sh
# M7 门③：R1-R9 回滚演练自动化总驱动。对【当前 HEAD 的真 dist 服务】实演旗标翻转，
# 每旗 on/默认起服务 -> readyz -> 改 env=off -> 停旧(wait_tree_gone+端口归属核查)
# -> 重启 -> readyz 恢复(毫秒计时) -> 断言旧行为(404/旧形状/FTS可用)。R8/R9 产手测记录表。
#
# 阶段：
#   0 环境/负载自检 + RUN_DIR(/tmp)；1 当前 schema 全新库 migrate；2 全开姿态 HTTP 最小种子
#   -> 停服 checkpoint 得静止黄金库；每旗复制独立库副本实演；R8 rollback.sh 静态核查；收尾 REPORT。
#
# 纪律：仅新增 scripts/acceptance/，零生产码改动；只 kill 自记 PID（不 pkill）；产物全落 /tmp；
#       负载>8 自停；不碰 prisma/dev.db；本机跑绿但不宣称过闸（以 team-lead 独立重跑为准）。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AC_DIR="$REPO_ROOT/scripts/acceptance"
ROLL_DIR="$AC_DIR/rollback"
API_DIR="$REPO_ROOT/apps/api"
NODE_BIN="${NODE_BIN:-/Users/daijing/.workbuddy/binaries/node/versions/22.22.2-3/bin/node}"
command -v "$NODE_BIN" >/dev/null 2>&1 || NODE_BIN="$(command -v node)"
PRISMA="$API_DIR/node_modules/prisma/build/index.js"
DIST_ENTRY="$API_DIR/dist/index.js"
DIST_MCP="$API_DIR/dist/mcp-stdio.js"
ROLLBACK_SH="$REPO_ROOT/deploy/bin/rollback.sh"
RESTORE_MD="$REPO_ROOT/docs/runbooks/restore.md"

STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="${GX_RB_RUN_DIR:-/tmp/gx-rollback-drill-$STAMP}"
RB_PORT="${GX_RB_PORT:-33941}"
export RB_PORT RUN_DIR NODE_BIN API_DIR AC_DIR ROLL_DIR DIST_ENTRY DIST_MCP REPO_ROOT PRISMA

mkdir -p "$RUN_DIR/stages" "$RUN_DIR/checks"
RESULTS="$RUN_DIR/results.tsv"; : > "$RESULTS"
log() { printf '\n\033[1;36m[rb]\033[0m %s\n' "$*"; }
die() { printf '\n[rb] FATAL: %s\n' "$*" >&2; exit 64; }

source "$AC_DIR/rollback-lib.sh"
trap 'for pf in "$RUN_DIR"/stages/*.pid; do [[ -f "$pf" ]] && kill_tree "$(cat "$pf")"; done 2>/dev/null' EXIT

# record <Rid> <recSec> <hits> <rc> <note>
record() { printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" >> "$RESULTS"; }

# check <tag> <checkfile> [args...]：运行一次探针，stdout 落 checks/<tag>.log，
# 用全局变量 CHK_RC / CHK_HITS 回传（避免 process substitution 子 shell 丢值）。
check() {
  local tag="$1" file="$2"; shift 2
  local hitfile="$RUN_DIR/checks/$tag.hits"
  "$NODE_BIN" "$ROLL_DIR/$file" --context "$RUN_DIR/context.json" --hit-file "$hitfile" "$@" \
    >"$RUN_DIR/checks/$tag.log" 2>&1
  CHK_RC=$?
  CHK_HITS=0; [[ -f "$hitfile" ]] && CHK_HITS="$(grep -c '^HIT' "$hitfile" || true)"
  log "  check $tag exit=$CHK_RC hits=$CHK_HITS"
  [[ "$CHK_RC" == 0 ]] || { echo "---- $tag 探针失败，末尾日志 ----" >&2; tail -n 25 "$RUN_DIR/checks/$tag.log" >&2; }
}

# ---------------- 阶段0：自检 ----------------
log "RUN_DIR=$RUN_DIR"
command -v curl >/dev/null || die "缺 curl"
[[ -f "$PRISMA" ]] || die "prisma 未安装：$PRISMA"
[[ -f "$DIST_ENTRY" && -f "$DIST_MCP" ]] || die "dist 未构建（先在 apps/api 跑 scripts/build.mjs）"
LOAD1="$(uptime | sed -E 's/.*load averages?: //' | cut -d. -f1 | awk '{print $1}')"
[[ "$LOAD1" -le 8 ]] || die "1 分钟负载 $LOAD1 > 8，按纪律暂停"
HEAD="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
MIG_COUNT="$(ls -d "$API_DIR"/prisma/migrations/*/ 2>/dev/null | wc -l | tr -d ' ')"
log "node=$($NODE_BIN -v) head=$HEAD load1=$LOAD1 migrations=$MIG_COUNT"

# netguard 探针自检：先证明出网包装确实会记账，否则 R5 零外网结论不可信。
"$NODE_BIN" "$ROLL_DIR/selftest-netguard.mjs" >"$RUN_DIR/checks/netguard-selftest.log" 2>&1 \
  || { cat "$RUN_DIR/checks/netguard-selftest.log"; die "netguard 自检失败（探针未生效，拒绝给 R5 假绿）"; }

# ---------------- 阶段1：全新库 migrate（当前 schema） ----------------
GOLD="$RUN_DIR/golden.db"
rm -f "$GOLD" "$GOLD-wal" "$GOLD-shm"
log "全新库 prisma migrate deploy -> $GOLD"
DATABASE_URL="file:$GOLD" "$NODE_BIN" "$PRISMA" migrate deploy --schema "$API_DIR/prisma/schema.prisma" \
  >"$RUN_DIR/migrate.log" 2>&1 || { cat "$RUN_DIR/migrate.log"; die "migrate deploy 失败"; }

# ---------------- 阶段2：全开姿态起服务 + HTTP 种子 -> 黄金静止库 ----------------
log "全开姿态起 dist 服务 + HTTP 最小种子"
GOLD_DATA="$RUN_DIR/stages/seed-data"
# seed 阶段是隔离临时库：首 owner 自举在公开注册关闭时也成立，但 member/outsider 靠自助
# signup 建立，需在此临时库显式打开公开注册（产品默认 fail-closed，见 configSignup.ts）。
start_stage seed "$GOLD" "$GOLD_DATA" 0 \
  GX_ENTERPRISE_ORG=on GX_ENTERPRISE_NAV=on GX_M5_SEARCH=on GX_SEARCH_WORKER=off GX_ALLOW_PUBLIC_SIGNUP=on
REC_SEED="$(wait_readyz_stage seed)" || die "全开姿态服务未就绪"
log "全开基线服务就绪（${REC_SEED}s）"
"$NODE_BIN" "$ROLL_DIR/seed.mjs" --base-url "http://127.0.0.1:$RB_PORT" --out "$RUN_DIR/context.json" \
  >"$RUN_DIR/checks/seed.log" 2>&1 || { cat "$RUN_DIR/checks/seed.log"; die "HTTP 种子失败"; }
stop_stage_server seed || die "停 seed 服务失败"
checkpoint_db "$GOLD" || die "黄金库 checkpoint 失败"

# stage_prep <name> -> echo "db|data"（复制静止黄金库三件套，互不污染）
stage_prep() {
  local name="$1" db="$RUN_DIR/stages/$name.db" data="$RUN_DIR/stages/$name-data"
  clone_db_triplet "$GOLD" "$db"; mkdir -p "$data"
  echo "$db|$data"
}

# serve <name> <netguard> <env...> -> echo "recSec|db|data"
serve() {
  local name="$1" ng="$2"; shift 2
  local prep db data rec
  prep="$(stage_prep "$name")"; db="${prep%%|*}"; data="${prep##*|}"
  start_stage "$name" "$db" "$data" "$ng" "$@" || return 1
  rec="$(wait_readyz_stage "$name")" || return 1
  echo "${rec}|${db}|${data}"
}

# ---------------- R1：org off（nav 仍 on） ----------------
log "R1 GX_ENTERPRISE_ORG=off（nav 仍 on）"
P="$(serve r1 0 GX_ENTERPRISE_ORG=off GX_ENTERPRISE_NAV=on)" || die "R1 服务未就绪"
check r1 check-mounts.mjs --mode orgoff
record R1 "${P%%|*}" "$CHK_HITS" "$CHK_RC" "nav 200 / org,pats,meta,mcp 404 / legacy+readyz 200"
stop_stage_server r1 || die "R1 停服失败"

# ---------------- R2：nav off（org 仍 on） ----------------
log "R2 GX_ENTERPRISE_NAV=off（org 仍 on）"
P="$(serve r2 0 GX_ENTERPRISE_ORG=on GX_ENTERPRISE_NAV=off)" || die "R2 服务未就绪"
check r2 check-mounts.mjs --mode navoff
record R2 "${P%%|*}" "$CHK_HITS" "$CHK_RC" "org,pats 200 / tree,menu 404 / legacy+readyz 200"
stop_stage_server r2 || die "R2 停服失败"

# ---------------- R3：authz 引擎永久生效（旧开关被忽略） ----------------
log "R3 GX_AUTHZ_ENGINE=off 已无效（引擎永久单一化，恒走 nav auth_policies 守卫）"
P="$(serve r3 0 GX_ENTERPRISE_ORG=on GX_ENTERPRISE_NAV=on GX_AUTHZ_ENGINE=off)" || die "R3 服务未就绪"
check r3 check-authz.mjs --log-evidence "$RUN_DIR/stages/r3.log"
record R3 "${P%%|*}" "$CHK_HITS" "$CHK_RC" "owner/member 200、outsider 403、viewer 写 403、启动日志无旧 [authz] 块"
stop_stage_server r3 || die "R3 停服失败"

# ---------------- R4：m1 read+keyset on 基线 -> off 旧形状 ----------------
log "R4 GX_M1_SIDECAR_READ/KEYSET：on 基线（游标三键在）"
P="$(serve r4on 0 GX_M1_SIDECAR=on GX_M1_SIDECAR_READ=on GX_M1_KEYSET=on)" || die "R4-on 服务未就绪"
check r4on check-keyset.mjs --mode on
RC_ON=$CHK_RC; HITS_ON=$CHK_HITS
stop_stage_server r4on || die "R4-on 停服失败"

log "R4 GX_M1_SIDECAR_READ/KEYSET：off 回滚（游标三键消失，回 S0 形状）"
P="$(serve r4off 0 GX_M1_SIDECAR_READ=off GX_M1_KEYSET=off)" || die "R4-off 服务未就绪"
check r4off check-keyset.mjs --mode off
RC4=0; { [[ "$RC_ON" == 0 && "$CHK_RC" == 0 ]]; } || RC4=1
record R4 "${P%%|*}" "$((HITS_ON+CHK_HITS))" "$RC4" "on 游标三键在(hits=$HITS_ON)；off 三键消失回 S0(hits=$CHK_HITS)"
stop_stage_server r4off || die "R4-off 停服失败"

# ---------------- R5：embedding off（FTS 命中 + 零外网） ----------------
log "R5 GX_EMBEDDING_MODE=off + netguard（纯 FTS、零外网）"
P="$(serve r5 1 GX_ENTERPRISE_ORG=on GX_ENTERPRISE_NAV=on GX_M5_SEARCH=on)" || die "R5 服务未就绪"
check r5 check-embedding.mjs --net-log "$RUN_DIR/stages/r5.netlog" --audit-out "$RUN_DIR/net-audit.json"
record R5 "${P%%|*}" "$CHK_HITS" "$CHK_RC" "旧面 FTS 命中 + netguard 外网出网计数=0"
stop_stage_server r5 || die "R5 停服失败"

# ---------------- R6：worker 关闭面 GX_SEARCH_WORKER=off -> outbox 静置 + 手动 reindex ----------------
# 2026-09-18 更新：此前 R6 记录的是「SearchIndexer 从未接线」的偏差；P1 已由 249df44 修复
# （内嵌工人接线，门控 GX_M5_SEARCH=on 且 GX_SEARCH_WORKER!=off）。故 R6 改为显式把这个新
# 旗标打到 off，验证「回滚面」仍成立：pending 静置不降、手动 /admin/reindex 入口仍可用。
log "R6 GX_SEARCH_WORKER=off（回滚面）：pending 静置不消化 + /admin/reindex 仍可全量建 chunks"
P="$(serve r6 0 GX_ENTERPRISE_ORG=on GX_ENTERPRISE_NAV=on GX_M5_SEARCH=on GX_SEARCH_WORKER=off)" || die "R6 服务未就绪"
DB6="$(echo "$P" | awk -F'|' '{print $2}')"
check r6 check-outbox.mjs --db "$DB6"
record R6 "${P%%|*}" "$CHK_HITS" "$CHK_RC" "worker=off：pending 静置不降、done=0；reindex 202 chunks>0/coverage 全 0（手动全量入口仍可用）"
stop_stage_server r6 || die "R6 停服失败"

# ---------------- R6b：worker 开启面（P1 修复正立面）-> outbox 被内嵌工人自行追平 ----------------
log "R6b worker 缺省即开：outbox 由内嵌工人自行追平到 0 + 派生索引可读（249df44 修复证据）"
P="$(serve r6b 0 GX_ENTERPRISE_ORG=on GX_ENTERPRISE_NAV=on GX_M5_SEARCH=on)" || die "R6b 服务未就绪"
DB6B="$(echo "$P" | awk -F'|' '{print $2}')"
check r6b check-outbox-drain.mjs --db "$DB6B"
record R6b "${P%%|*}" "$CHK_HITS" "$CHK_RC" "worker=on：pending 追平 0/done>0 且 workerId=api-<pid>@ms；status chunks>0"
stop_stage_server r6b || die "R6b 停服失败"

# ---------------- R7：org off -> /mcp /pats 404 + stdio 文件存在 ----------------
log "R7 org off：/mcp、/api/v1/pats 404；dist/mcp-stdio.js 文件存在（独立 stdio 入口）"
P="$(serve r7 0 GX_ENTERPRISE_ORG=off GX_ENTERPRISE_NAV=on)" || die "R7 服务未就绪"
check r7 check-mounts.mjs --mode orgoff
STDIO_OK=0
if [[ -f "$DIST_MCP" ]]; then STDIO_OK=1; log "  stdio 入口存在：${DIST_MCP}（$(wc -c <"$DIST_MCP" | tr -d ' ') 字节）"; fi
RC7=0; { [[ "$CHK_RC" == 0 && "$STDIO_OK" == 1 ]]; } || RC7=1
record R7 "${P%%|*}" "$((CHK_HITS+STDIO_OK))" "$RC7" "/mcp+/pats 404(hits=$CHK_HITS) + mcp-stdio.js 文件存在($STDIO_OK)"
stop_stage_server r7 || die "R7 停服失败"

# ---------------- R8 静态核查 + meta ----------------
log "R8 静态读码核查 deploy/bin/rollback.sh"
"$NODE_BIN" "$ROLL_DIR/check-r8-static.mjs" --file "$ROLLBACK_SH" --out "$RUN_DIR/r8.json" \
  >"$RUN_DIR/checks/r8-static.log" 2>&1 || log "R8 静态核查有未满足项（见 r8.json / REPORT）"

cat > "$RUN_DIR/meta.json" <<JSON
{
  "generatedAt": "$(date '+%Y-%m-%d %H:%M:%S %z')",
  "head": "$HEAD",
  "node": "$($NODE_BIN -v)",
  "distEntry": "$DIST_ENTRY",
  "migrationCount": $MIG_COUNT,
  "restoreRunbook": $( [[ -f "$RESTORE_MD" ]] && echo true || echo false ),
  "restoreRunbookLines": $( [[ -f "$RESTORE_MD" ]] && wc -l < "$RESTORE_MD" | tr -d ' ' || echo 0 )
}
JSON

# ---------------- 收尾：REPORT + 裁决 ----------------
log "生成 REPORT"
"$NODE_BIN" "$ROLL_DIR/report.mjs" --run-dir "$RUN_DIR"
REPORT_RC=$?
echo
echo "==================== results.tsv ===================="
cat "$RESULTS"
echo "====================================================="
echo "REPORT: $RUN_DIR/REPORT.md"
tail -n 1 "$RUN_DIR/REPORT.md"
exit "$REPORT_RC"
