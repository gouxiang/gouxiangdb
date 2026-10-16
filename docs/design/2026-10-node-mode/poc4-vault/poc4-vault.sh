#!/usr/bin/env bash
# PoC-4 组1 项1/3/4：hdiutil AES-256 sparsebundle 生命周期（建→挂→内核探针→detach→
# 验密文→错密码拒绝→重挂数据完好→双作用域失权销毁隔离）。
#
# DESIGN-OFFLINE-SYNC §18.5 组1 必须全过项的可复跑编排。本脚本【不碰 macOS 钥匙串】：
# 镜像口令用临时随机串放在沙箱目录，仅用于验证磁盘匣机制本身；项5「ad-hoc .app 经 Keychain
# 自动挂载是否弹授权」无法无人值守闭环，另见 REPORT.md 阻断点，需戴总在场实测。
#
# 全程在隔离沙箱（$SBROOT，默认 /tmp/gx-poc4）内操作，绝不触碰主仓或真实数据目录；
# 结束时 detach 全部测试镜像、无 /Volumes 残留（可 bash poc4-vault.sh clean 清理沙箱）。
#
# 用法：bash poc4-vault.sh [NODE_BIN]
#   NODE_BIN 默认 PATH 中的 node（建议传受管 Node 22 绝对路径）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# poc4-vault/ 在 <repo>/docs/design/2026-10-node-mode/ 下，上溯 4 级到仓库根。
REPO_ROOT="$(cd "$HERE/../../../../" && pwd)"
SBROOT="${TMPDIR:-/tmp}/gx-poc4"
NODE_BIN="${1:-node}"
VEC_PROBE="$HERE/vec-probe.cjs"
# 探针用裸 require("better-sqlite3")，让 Node 能从 apps/api 的 node_modules 解析（不污染全局）。
export NODE_PATH="$REPO_ROOT/apps/api/node_modules"

log() { printf '\n=== %s ===\n' "$*"; }
die() { printf 'POC4_FAIL: %s\n' "$*" >&2; exit 1; }

detach_quiet() { hdiutil detach "$1" -quiet 2>/dev/null || true; }

clean_all() {
  for m in "$SBROOT"/mnt* ; do [ -d "$m" ] && detach_quiet "$m"; done
  rm -rf "$SBROOT"
  echo "cleaned $SBROOT"
}

if [ "${1:-}" = "clean" ]; then clean_all; exit 0; fi

command -v hdiutil >/dev/null || die "hdiutil 仅 macOS 可用（VM15 Linux 跑不了，本 PoC 在 Mac 本机执行）"

log "0. 准备隔离沙箱 $SBROOT"
for m in "$SBROOT"/mnt* ; do [ -d "$m" ] && detach_quiet "$m"; done
rm -rf "$SBROOT"
mkdir -p "$SBROOT/mnt"
SB="$SBROOT/vault-test.sparsebundle"
PASS="poc4-$(openssl rand -hex 16)"; printf '%s' "$PASS" > "$SBROOT/pass.txt"

log "项1 建 AES-256 sparsebundle + 挂到显式 mountpoint"
printf '%s' "$PASS" | hdiutil create -size 64m -type SPARSEBUNDLE -encryption AES-256 \
  -fs APFS -volname gxpoc4 -stdinpass "$SB" >/dev/null
printf '%s' "$PASS" | hdiutil attach -nobrowse -mountpoint "$SBROOT/mnt" -stdinpass "$SB" >/dev/null
touch "$SBROOT/mnt/.w" && rm "$SBROOT/mnt/.w"
echo "空匣稀疏占用: $(du -sh "$SB" | cut -f1)"

log "项2 挂载点内 better-sqlite3 + vec0 loadExtension + KNN（内核零侵入探针）"
"$NODE_BIN" "$VEC_PROBE" "$SBROOT/mnt"
echo "写库后镜像占用: $(du -sh "$SB" | cut -f1)"

log "项3 detach → 挂载点空 / 镜像无明文 / 错密码被拒"
hdiutil detach "$SBROOT/mnt" -quiet
[ -z "$(ls -A "$SBROOT/mnt")" ] || die "detach 后挂载点非空"
if grep -aq "hello-vault-updated" "$SB"/bands/* 2>/dev/null; then die "镜像 bands 内检出明文"; fi
echo "密文检查通过（bands 无业务明文）"
if printf '%s' "wrong-pass" | hdiutil attach -nobrowse -mountpoint "$SBROOT/mnt" -stdinpass "$SB" >/dev/null 2>&1; then
  detach_quiet "$SBROOT/mnt"; die "错误密码竟挂载成功"
fi
echo "错误密码被拒绝"

log "项3b 正确密码重挂 → 业务数据与 vec KNN 完好"
printf '%s' "$PASS" | hdiutil attach -nobrowse -mountpoint "$SBROOT/mnt" -stdinpass "$SB" >/dev/null
"$NODE_BIN" "$HERE/reattach-verify.cjs" "$SBROOT/mnt"
detach_quiet "$SBROOT/mnt"

log "项4 双作用域：销毁 A 不影响 B、A 无明文残留"
mkdir -p "$SBROOT/mntA" "$SBROOT/mntB"
PA="A-$(openssl rand -hex 16)"; PB="B-$(openssl rand -hex 16)"
for s in A B; do
  passVar="P$s"; bundle="$SBROOT/scope$s.sparsebundle"; mnt="$SBROOT/mnt$s"; vol="scope$s"
  printf '%s' "${!passVar}" | hdiutil create -size 32m -type SPARSEBUNDLE -encryption AES-256 \
    -fs APFS -volname "$vol" -stdinpass "$bundle" >/dev/null
  printf '%s' "${!passVar}" | hdiutil attach -nobrowse -mountpoint "$mnt" -stdinpass "$bundle" >/dev/null
  echo "SECRET_${s}_DATA" > "$mnt/node$s.txt"
done
sync
# 模拟节点 A 失权：detach + 丢密钥 + 删镜像。
hdiutil detach "$SBROOT/mntA" -quiet
rm -f "$SBROOT/PASSA" ; rm -rf "$SBROOT/scopeA.sparsebundle"
[ -z "$(ls -A "$SBROOT/mntA")" ] || die "A 销毁后挂载点非空"
grep -q "SECRET_B_DATA" "$SBROOT/mntB/nodeB.txt" || die "作用域 B 被波及"
if grep -raq "SECRET_A_DATA" "$SBROOT" 2>/dev/null; then die "A 销毁后仍有明文残留"; fi
echo "作用域隔离通过：A 已销毁无残留，B 完好可读"
detach_quiet "$SBROOT/mntB"

log "收尾：确认无测试镜像残留挂载"
if mount | grep -qiE "gxpoc4|scopeA|scopeB"; then die "仍有残留挂载"; fi
echo "NO_LEFTOVER_MOUNTS"
echo "POC4_GROUP1_PASS（项5 Keychain/.app 弹窗未含，见 REPORT.md）"
