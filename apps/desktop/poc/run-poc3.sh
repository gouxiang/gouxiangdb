#!/usr/bin/env bash
# apps/desktop/poc/run-poc3.sh
#
# PoC-3 到场驱动：无 Apple 账号下 Tauri updater 旧版→新版闭环 + 篡改拒绝 + quarantine 取证。
# 设计依据：docs/design/2026-10-node-mode/DESIGN-MACOS-APP.md §9 / §15 PoC-3。
#
# ★ 只在 Mac（Apple Silicon）上、戴总在场时按步骤执行；本脚本不会被提交后自动运行。
# ★ 全程隔离：安装副本、数据目录、更新源都在 /tmp/gx-poc3 下，不碰真实
#   ~/Library/Application Support，也不往 /Applications 写任何东西。
#
# 分步用法（建议逐段执行并盯日志）：
#   bash poc/run-poc3.sh buildall     # 打 0.1.0、0.2.0 两版 .app + 更新包/签名（较慢，约几分钟）
#   bash poc/run-poc3.sh serve        # 起回环静态更新源（前台，另开终端或后台）
#   bash poc/run-poc3.sh manifest-ok  # 源里放 0.2.0 正常清单+更新包
#   bash poc/run-poc3.sh run-old      # 装并启动 0.1.0，等它自动更新到 0.2.0
#   bash poc/run-poc3.sh tamper       # 源换成被篡改的 0.3.0，再跑，验证“拒绝安装”
#   bash poc/run-poc3.sh forensic     # 对更新后的 .app/内嵌 node 取 xattr/codesign/spctl
#   bash poc/run-poc3.sh stop         # 停掉测试 App 与静态源
#   bash poc/run-poc3.sh all          # 顺序跑 buildall→…→run-old（篡改/取证建议单独做，便于观察）
#
# 判定（无交互，看 /tmp/gx-poc3-updater.log）：
#   run-old 成功：日志出现两段 session，且后段 bundle_version=0.2.0，前段有 RESULT INSTALLED。
#   tamper 成功：出现 RESULT FAIL reason=download_or_verify，且 .app 仍是 0.2.0、进程仍在、未重启。

set -euo pipefail

DESK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_TAURI="$DESK/src-tauri"
REPO="$(cd "$DESK/../.." && pwd)"
APPNAME="构想工作台"
BUNDLE_DIR="$SRC_TAURI/target/release/bundle/macos"

# 受管 Node + Tauri CLI（PoC-1/2 已验证的同一条）。
NODE_BIN="/Users/daijing/.workbuddy/binaries/node/versions/22.22.2-6/bin/node"
TAURI_JS="/Users/daijing/.workbuddy/binaries/node/workspace/node_modules/@tauri-apps/cli/tauri.js"

KEY="$HOME/.tauri/gouxiangdb-desktop.key"
PASS_FILE="$HOME/.tauri/gouxiangdb-desktop.pass"
PUBKEY="$(tr -d '\n' < "$HOME/.tauri/gouxiangdb-desktop.key.pub")"

WORK="/tmp/gx-poc3"
ART="$WORK/art"
SRCDIR="$WORK/src"
INSTALL="$WORK/install"
DATA="$WORK/data"
PORT=18080
BASE="http://127.0.0.1:${PORT}"
UPD_LOG="/tmp/gx-poc3-updater.log"
SRV_PID="$WORK/server.pid"

OLD_VER="0.1.0"
NEW_VER="0.2.0"
TAMPER_VER="0.3.0"

mkdir -p "$ART" "$SRCDIR" "$INSTALL"

tauri_cli() { "$NODE_BIN" "$TAURI_JS" "$@"; }

# 用 --config 注入：版本号 + 产出更新包 + updater 公钥/回环源/允许明文 http（仅本 PoC 源）。
build_one() {
  local ver="$1"
  echo "[poc3] build $ver …"
  local cfg
  cfg=$(UPD_PUB="$PUBKEY" UPD_BASE="$BASE" "$NODE_BIN" -e '
    const o = {
      version: process.argv[1],
      bundle: { createUpdaterArtifacts: true },
      plugins: { updater: {
        pubkey: process.env.UPD_PUB,
        endpoints: [process.env.UPD_BASE + "/latest.json"],
        dangerousInsecureTransportProtocol: true,
      } },
    };
    process.stdout.write(JSON.stringify(o));
  ' "$ver")
  cd "$SRC_TAURI"
  TAURI_SIGNING_PRIVATE_KEY="$KEY" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$PASS_FILE")" \
  CARGO_BUILD_JOBS=2 \
    tauri_cli build --bundles app --config "$cfg"
  cd "$DESK"
}

stage_artifacts() {
  local ver="$1"
  # 必须先删目标：macOS `cp -R src.app 已存在的dst.app` 会合并/嵌套而非干净覆盖内部二进制，
  # 曾导致 art 里 tar.gz 是新的、.app 壳二进制却是旧逻辑（假绿）。
  rm -rf "$ART/$APPNAME-$ver.app"
  cp -R "$BUNDLE_DIR/$APPNAME.app" "$ART/$APPNAME-$ver.app"
  cp -f "$BUNDLE_DIR/$APPNAME.app.tar.gz" "$ART/GouXiangDB-$ver.app.tar.gz"
  cp -f "$BUNDLE_DIR/$APPNAME.app.tar.gz.sig" "$ART/GouXiangDB-$ver.app.tar.gz.sig"
  # 指纹硬校验：staged 壳二进制必须与刚构建 bundle 的逐字节一致，否则中止（杜绝壳旧包新）。
  local h1 h2
  h1=$(shasum -a 256 "$BUNDLE_DIR/$APPNAME.app/Contents/MacOS/gouxiangdb-desktop" | awk '{print $1}')
  h2=$(shasum -a 256 "$ART/$APPNAME-$ver.app/Contents/MacOS/gouxiangdb-desktop" | awk '{print $1}')
  if [ "$h1" != "$h2" ]; then
    echo "[poc3] FAIL staged $ver 壳二进制与 bundle 不一致 ($h1 != $h2)"; exit 1
  fi
  echo "[poc3] staged ${ver} .app / tar.gz / sig -> ${ART}（壳指纹一致 ${h1}）"
}

cmd_buildall() {
  echo "[poc3] === build $OLD_VER ==="; build_one "$OLD_VER"; stage_artifacts "$OLD_VER"
  echo "[poc3] === build $NEW_VER ==="; build_one "$NEW_VER"; stage_artifacts "$NEW_VER"
  echo "[poc3] 两版构建完成："; ls -la "$ART"
}

cmd_serve() {
  echo "[poc3] 静态源 $SRCDIR on $BASE （Ctrl-C 停）"
  exec "$NODE_BIN" "$DESK/poc/poc3-static-server.mjs" --dir "$SRCDIR" --port "$PORT"
}

start_server_bg() {
  if [ -f "$SRV_PID" ] && kill -0 "$(cat "$SRV_PID")" 2>/dev/null; then
    echo "[poc3] 静态源已在运行 pid=$(cat "$SRV_PID")"; return; fi
  ( "$NODE_BIN" "$DESK/poc/poc3-static-server.mjs" --dir "$SRCDIR" --port "$PORT" \
      >"$WORK/server.log" 2>&1 & echo $! > "$SRV_PID" )
  sleep 1
  curl -fsS "$BASE/latest.json" >/dev/null 2>&1 || true
  echo "[poc3] 静态源已后台启动 pid=$(cat "$SRV_PID")"
}

manifest() { # manifest <version> [--tamper]
  local ver="$1"; shift || true
  "$NODE_BIN" "$DESK/poc/make-poc3-manifest.mjs" \
    --tar "$ART/GouXiangDB-$ver.app.tar.gz" \
    --sig "$ART/GouXiangDB-$ver.app.tar.gz.sig" \
    --version "$ver" --base "$BASE" --srcdir "$SRCDIR" \
    --remote "GouXiangDB-$ver.app.tar.gz" "$@"
}

cmd_manifest_ok() { manifest "$NEW_VER" --notes "PoC-3 正常更新包 ${NEW_VER}（应被安装）"; }

wait_log() { # wait_log <grep-ere> <timeout-sec>
  local pat="$1" timeout="${2:-120}" start=$SECONDS
  while (( SECONDS - start < timeout )); do
    if grep -Eq "$pat" "$UPD_LOG" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

launch_installed() {
  # 不传 GX_POC3_RESET_LOG：更新 restart 会继承 env，若带自删标志，新版启动会抹掉旧版那段证据。
  # 日志清理由调用方在启动前外部截断（run_old），篡改用例只看本次启动后的新增行（tamper）。
  open -n "$INSTALL/$APPNAME.app" \
    --env GX_POC3=1 --env "GX_POC3_DATA_DIR=$DATA"
}

cmd_run_old() {
  start_server_bg
  rm -rf "$DATA"; mkdir -p "$DATA"
  rm -rf "$INSTALL/$APPNAME.app"
  cp -R "$ART/$APPNAME-$OLD_VER.app" "$INSTALL/$APPNAME.app"
  local instver
  instver=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INSTALL/$APPNAME.app/Contents/Info.plist")
  echo "[poc3] 安装的旧版版本=${instver}（期望 ${OLD_VER}）"
  [ "$instver" = "$OLD_VER" ] || { echo "[poc3] 旧版版本不符，中止"; exit 1; }
  : > "$UPD_LOG"   # 开跑前外部清空一次；重启继承的 env 不再自删
  launch_installed
  echo "[poc3] 等待自动更新到 ${NEW_VER}（看 ${UPD_LOG}，最多 150s）…"
  if wait_log "bundle_version=$NEW_VER" 150; then
    echo "[poc3] ✅ 已重启为 $NEW_VER"
  else
    echo "[poc3] ❌ 超时未见到 ${NEW_VER}，日志末尾："; tail -30 "$UPD_LOG"; exit 1
  fi
  sleep 6  # 让新版自检一次（应 NONE already-latest，不产生再更新循环）
  local nowver
  nowver=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INSTALL/$APPNAME.app/Contents/Info.plist")
  echo "[poc3] 当前安装版本=$nowver"
  echo "[poc3] ===== 更新器日志关键行 ====="
  grep -E "session begin|bundle_version|update available|RESULT|RESTART|graceful|download bytes" "$UPD_LOG" || true
  [ "$nowver" = "$NEW_VER" ] || { echo "[poc3] ❌ 安装版本不是 $NEW_VER"; exit 1; }
  echo "[poc3] ✅ PoC-3 主闭环通过：$OLD_VER → $NEW_VER"
}

cmd_tamper() {
  start_server_bg
  cmd_stop_app || true
  sleep 2
  # 宣告一个更高的 0.3.0，但投放的是被翻转 1 字节、仍配原合法签名的包 → 必须校验失败。
  # tar/sig 复用 0.2.0 的产物；version/remote 改写成 0.3.0 让 semver 判定为"有新版"。
  "$NODE_BIN" "$DESK/poc/make-poc3-manifest.mjs" \
    --tar "$ART/GouXiangDB-$NEW_VER.app.tar.gz" \
    --sig "$ART/GouXiangDB-$NEW_VER.app.tar.gz.sig" \
    --version "$TAMPER_VER" --base "$BASE" --srcdir "$SRCDIR" \
    --remote "GouXiangDB-$TAMPER_VER.app.tar.gz" --tamper \
    --notes "PoC-3 篡改包（必须拒绝）"
  local before
  before=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INSTALL/$APPNAME.app/Contents/Info.plist")
  echo "[poc3] 篡改用例前安装版本=${before}（期望 ${NEW_VER}）"
  # 只看本次启动之后新增的日志，避免被上一轮成功记录干扰。
  local mark
  mark=$(wc -l < "$UPD_LOG" 2>/dev/null | tr -d ' '); mark=${mark:-0}
  launch_installed
  echo "[poc3] 等待校验失败结果（最多 120s，仅看第 $((mark+1)) 行之后）…"
  local start=$SECONDS pat="RESULT FAIL reason=download_or_verify"
  local got=0
  while (( SECONDS - start < 120 )); do
    if tail -n +$((mark+1)) "$UPD_LOG" 2>/dev/null | grep -Eq "$pat"; then got=1; break; fi
    sleep 1
  done
  if [ "$got" = "1" ]; then
    echo "[poc3] ✅ updater 拒绝了篡改包"
  else
    echo "[poc3] ❌ 未等到拒绝，可能被错误安装！新增日志："; tail -n +$((mark+1)) "$UPD_LOG"; exit 1
  fi
  sleep 3
  local after
  after=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INSTALL/$APPNAME.app/Contents/Info.plist")
  echo "[poc3] 篡改用例后安装版本=${after}（必须仍是 ${NEW_VER}）"
  [ "$after" = "$NEW_VER" ] || { echo "[poc3] ❌ 版本被改变，篡改防护失败"; exit 1; }
  pgrep -fl "$INSTALL/$APPNAME.app/Contents/MacOS" >/dev/null && echo "[poc3] ✅ 旧版进程仍存活（未被中断/替换）" \
    || echo "[poc3] 注意：未检出存活进程，需人工确认"
  echo "[poc3] ✅ PoC-3 篡改拒绝通过"
}

cmd_forensic() {
  local app="$INSTALL/$APPNAME.app"
  echo "===== ① 版本 ====="
  /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$app/Contents/Info.plist"
  echo "===== ② quarantine / 扩展属性（.app 顶层，递归） ====="
  xattr -lr "$app" 2>/dev/null | grep -i quarantine && echo "[有 quarantine]" || echo "[无 com.apple.quarantine]"
  echo "===== ③ 壳签名 ====="
  codesign -dv --verbose=2 "$app" 2>&1 | grep -E "Identifier|Signature|TeamIdentifier|flags" || true
  echo "===== ④ Gatekeeper 评估 ====="
  spctl -a -vvv -t exec "$app" 2>&1 || true
  echo "===== ⑤ 内嵌 node / 原生件签名与架构 ====="
  local node="$app/Contents/Resources/gxnode-aarch64-apple-darwin"
  codesign -dv "$node" 2>&1 | grep -E "Signature|Identifier" || true
  file "$node"
  find "$app/Contents/Resources/server/node_modules" \( -name "*.node" -o -name "vec0.dylib" \) 2>/dev/null | head -5 | while read -r f; do
    echo "--- $f"; codesign -dv "$f" 2>&1 | grep Signature || echo "(未单独签名)"; file -b "$f"
  done
  echo "===== ⑥ 数据目录库完整性（WAL/大小） ====="
  ls -la "$DATA" | head; ls -la "$DATA"/dev.db* 2>/dev/null || true
}

cmd_stop_app() {
  osascript -e "tell application id \"cc.gouxiang.desktop\" to quit" 2>/dev/null || true
  pkill -f "$INSTALL/$APPNAME.app/Contents/MacOS" 2>/dev/null || true
  echo "[poc3] 已请求停止测试 App"
}

cmd_stop() {
  cmd_stop_app
  if [ -f "$SRV_PID" ]; then kill "$(cat "$SRV_PID")" 2>/dev/null || true; rm -f "$SRV_PID"; fi
  echo "[poc3] 已停静态源"
}

cmd_all() { cmd_buildall; start_server_bg; cmd_manifest_ok; cmd_run_old; }

case "${1:-}" in
  buildall) cmd_buildall ;;
  serve) cmd_serve ;;
  manifest-ok) cmd_manifest_ok ;;
  run-old) cmd_run_old ;;
  tamper) cmd_tamper ;;
  forensic) cmd_forensic ;;
  stop) cmd_stop ;;
  stop-app) cmd_stop_app ;;
  all) cmd_all ;;
  *) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
