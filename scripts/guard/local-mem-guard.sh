#!/usr/bin/env bash
# =============================================================================
# GouXiangDB 本机内存红线守卫（16GB MacBook 专用，跨项目长期标准）
#
# 背景：本机长期常驻 WorkBuddy/Trae/Safari/Chrome 且很少重启，内存常年贴上限。
# 曾多次因在本机误跑 pnpm install / vite-esbuild 构建 / cargo 编译 / 全量
# vitest 等重活把内存打爆、整机卡死被迫硬重启。本脚本是那条红线的可执行闸门。
#
# 铁律（人读版见 docs/standards/LOCAL-MEMORY-REDLINE.md）：
#   1. 重活一律在 VM15（192.168.31.15）跑，本机从源头不启动：
#      pnpm install、vite/esbuild build、cargo/rustc、全量 vitest、prisma 大批量。
#   2. 本机只许轻量活：tsc --noEmit、eslint、单个/定向 vitest 文件、轻脚本。
#   3. 任何本机 node 命令套堆上限 NODE_MAX_OLD_MB（默认 2048MB），超限让该进程
#      自己 OOM 退出，而不是拖垮整机。
#   4. 开跑前空闲内存必须 >= MEM_FREE_MIN_MB（默认 2500MB），否则拒绝执行。
#
# 用法：
#   scripts/guard/local-mem-guard.sh <command...>
# 例：
#   scripts/guard/local-mem-guard.sh pnpm --filter @gx/api exec tsc --noEmit
#   scripts/guard/local-mem-guard.sh node node_modules/vitest/vitest.mjs run src/foo.test.ts
#   scripts/guard/local-mem-guard.sh --check        # 只做空闲内存体检，不执行命令
#
# 仅在 macOS 生效（用 vm_stat / sysctl）。非 macOS 跳过内存体检但仍套堆上限。
# 可用环境变量放宽/收紧：GX_MEM_FREE_MIN_MB、GX_NODE_MAX_OLD_MB、GX_MEM_GUARD=off。
# =============================================================================

set -euo pipefail

# 红线默认值（可被环境变量覆盖，但不建议调大）。
MEM_FREE_MIN_MB="${GX_MEM_FREE_MIN_MB:-2500}"
NODE_MAX_OLD_MB="${GX_NODE_MAX_OLD_MB:-2048}"

c_step() { printf '\033[1;36m==> %s\033[0m\n' "$1" 2>/dev/null || true; }
c_ok()   { printf '\033[1;32m[OK]\033[0m %s\n' "$1" 2>/dev/null || true; }
c_err()  { printf '\033[1;31m[BLOCKED]\033[0m %s\n' "$1" >&2 2>/dev/null || true; }

# ---------------------------------------------------------------------------
# 硬拦截：命令行里只要出现重活特征，直接拒绝，提示去 VM15。
# 这是比"内存够不够"更靠前的红线——重活即使此刻内存够也不许在本机启动。
# ---------------------------------------------------------------------------
block_heavy_command() {
  local cmd_str="$*"
  # 归一化：折叠多余空白并转小写，便于匹配。
  local s
  s="$(printf '%s' "$cmd_str" | tr '[:upper:]' '[:lower:]' | tr -s ' \t' ' ')"

  # ---- 1) Rust 编译（Tauri 壳）：cargo/rustc 任何子命令都拦（build/clippy/test/check）。
  if [[ "$s" =~ (^|[ /])(cargo|rustc)([ ]|$) ]]; then
    c_err "检测到 Rust 编译（cargo/rustc）。本机禁止，重活去 VM15（ssh 192.168.31.15）。"
    return 1
  fi

  # ---- 2) 生产构建：vite build / tauri build / esbuild 二进制 / 包管理器的 build 脚本。
  # 包管理器脚本名在 pnpm 里可省略 run：`pnpm --filter @gx/web build` 与 `pnpm run build`
  # 都是重构建。规则：经 pnpm/npm/yarn 调用时，任一空白分隔参数恰为 build 或以 build: 开头即拦。
  if [[ "$s" == *"vite build"* ]] || [[ "$s" == *"vite/build"* ]] \
     || [[ "$s" =~ (^|[ /])esbuild([ ]|$) ]] \
     || [[ "$s" == *"tauri"*"build"* ]]; then
    c_err "检测到生产构建（vite/tauri/esbuild build）。本机禁止，去 VM15。"
    return 1
  fi
  if [[ "$s" =~ (^|[ /])(pnpm|npm|yarn)([ ]|$) ]]; then
    local a
    for a in $s; do
      if [[ "$a" == "build" || "$a" == build:* || "$a" == "run"*"/build" ]]; then
        c_err "检测到包构建脚本（pnpm/npm $a，含 vite/esbuild/tsc 重活）。本机禁止，去 VM15。"
        return 1
      fi
    done
  fi

  # ---- 3) 依赖安装：pnpm/npm/yarn 的 install/i/add/ci。
  if [[ "$s" =~ (^|[ /])(pnpm|npm|yarn|corepack)([ ]|$) ]]; then
    local b
    for b in $s; do
      case "$b" in
        install|i|add|ci|up|update|upgrade)
          c_err "检测到依赖安装/升级（$b）。本机禁止，去 VM15。"
          return 1
          ;;
      esac
    done
  fi

  # ---- 4) 全量测试：
  #   - pnpm test / pnpm -w test / pnpm run test（根级或 workspace 全量）；
  #   - 直接 vitest 但命令里没有任何文件路径/.test.（=无范围全量）。
  # 定向单测（命令含 src/... 或 *.test.*）放行，交由 NODE_OPTIONS 限堆 + 建议限并发。
  if [[ "$s" =~ (^|[ /])(pnpm|npm|yarn)([ ]|$) ]]; then
    local c prev=""
    for c in $s; do
      # 参数恰为 test（前一个不是文件路径的一部分）即视为全量测试脚本。
      if [[ "$c" == "test" || "$c" == test:* ]]; then
        c_err "检测到全量测试（pnpm/npm $c）。本机禁止，去 VM15 跑四门；定向单测请显式给 *.test.ts 路径。"
        return 1
      fi
      prev="$c"
    done
  fi
  if [[ "$s" =~ vitest ]] && ! printf '%s' "$s" | grep -Eq '(\.test\.|/src/|/__tests__/)'; then
    c_err "检测到无文件范围的 vitest（=全量）。本机禁止，去 VM15；定向单测请显式带 *.test.ts 路径。"
    return 1
  fi

  return 0
}

# ---------------------------------------------------------------------------
# 空闲内存体检（macOS）。返回 0=够，1=不足。
# 口径：可用内存 = free + inactive（inactive 大多可被回收），单位 MB。
# ---------------------------------------------------------------------------
check_free_mem_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    c_ok "非 macOS，跳过本机内存体检（请在目标机自行确认）。"
    return 0
  fi

  local page_size free_pages inactive_pages spec_bytes free_mb inact_mb avail_mb
  page_size="$(vm_stat | awk '/page size of/ {for(i=1;i<=NF;i++) if($i=="size") {gsub(/[^0-9]/,"",$(i+1)); print $(i+1)}}')"
  page_size="${page_size:-16384}"
  free_pages="$(vm_stat | awk '/Pages free/ {gsub(/[^0-9]/,"",$3); print $3}')"
  inactive_pages="$(vm_stat | awk '/Pages inactive/ {gsub(/[^0-9]/,"",$3); print $3}')"
  free_pages="${free_pages:-0}"; inactive_pages="${inactive_pages:-0}"
  free_mb=$(( free_pages * page_size / 1024 / 1024 ))
  inact_mb=$(( inactive_pages * page_size / 1024 / 1024 ))
  avail_mb=$(( free_mb + inact_mb ))
  spec_bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"

  printf '物理内存 %s GB；当前可用(free+inactive) ≈ %s MB（free %s / inactive %s）；红线要求 >= %s MB。\n' \
    "$(( spec_bytes / 1024 / 1024 / 1024 ))" "${avail_mb}" "${free_mb}" "${inact_mb}" "${MEM_FREE_MIN_MB}"

  if (( avail_mb < MEM_FREE_MIN_MB )); then
    c_err "空闲内存 ${avail_mb}MB < 红线 ${MEM_FREE_MIN_MB}MB。此刻不要在本机跑，等系统压缩/回收几分钟，或改去 VM15。"
    c_err "提示：不要关 WorkBuddy/浏览器，也不要强退 kernel_task；macOS 压力退去会自行回收（可再跑 memory_pressure 观察）。"
    return 1
  fi
  c_ok "空闲内存达标。"
  return 0
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
if [[ "${GX_MEM_GUARD:-}" == "off" ]]; then
  echo "[mem-guard] 已被 GX_MEM_GUARD=off 关闭（不建议）。直接执行：$*"
  exec "$@"
fi

if [[ "${1:-}" == "--check" ]]; then
  c_step "本机内存红线体检（不执行命令）"
  check_free_mem_macos
  exit $?
fi

if [[ "$#" -eq 0 ]]; then
  echo "用法: $0 <command...>   或   $0 --check" >&2
  exit 64
fi

c_step "本机内存红线：先拦重活，再查空闲内存"
block_heavy_command "$@"
check_free_mem_macos

# 套 Node 堆上限：命令链最左是 node 或会走 node 的 pnpm exec 时，导出 NODE_OPTIONS。
# 定向 vitest 限单 worker，避免并发起多进程放大峰值。
export NODE_MAX_OLD_SPACE_SIZE="${NODE_MAX_OLD_MB}"
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${NODE_MAX_OLD_MB}"

c_step "执行（Node 堆上限 ${NODE_MAX_OLD_MB}MB）：$*"
exec "$@"
