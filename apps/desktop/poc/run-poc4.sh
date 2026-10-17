#!/usr/bin/env bash
# apps/desktop/poc/run-poc4.sh
#
# PoC-4 到场驱动（#816 承载验证，DESIGN-MACOS-APP.md §8.5 界面承载修订 / §15）。
#
# 验证【壳自己的回环静态口】托管前端后，WebView 从壳 http 源【跨端口/跨源】连本地内核口：
#   ① fetch CORS（简单 GET / JSON POST 预检 / X-GX-Token 自定义头预检）② multipart
#   ③ 公开头像 no-cors <img> 的 CORP 裁决 ④ 私有附件带票 cors fetch+blob
#   ⑤ 跨源 WebSocket 升级 + 坏票 4401  ⑥（可选）http 局域网 / https 远端 ATS 观察
#
# ★ 只在 Mac（Apple Silicon）、戴总在场时跑；本脚本不会被提交后自动运行。
# ★ 全程隔离：安装副本与数据目录都在 /tmp/gx-poc4 下，不碰真实
#   ~/Library/Application Support，也不往 /Applications 写。
#
# 前置（本机，戴总在场）：
#   GX_POC4=1 node apps/desktop/scripts/stage-node-sidecar.mjs   # 组装随包树并注入 poc4.html
#   cd apps/desktop/src-tauri && CARGO_BUILD_JOBS=2 tauri build --bundles app
#
# 用法：
#   bash poc/run-poc4.sh run      # 复制 .app 到隔离目录、设 env 启动、无交互等结论
#   bash poc/run-poc4.sh log      # 实时打印判定日志
#   bash poc/run-poc4.sh stop     # 停测试 App 与残留内核
#
# 判定（无交互，看 /tmp/gx-poc4-shell.log）：
#   成功：出现 PROBE .../__poc4/DONE/12/true/pass12，且内核 ready + 壳口 200 行齐全。
#   CORP 裁决：看 PROBE .../__poc4/obs/80（公开图被拦＝D1 需 additive 放宽内核 CORP）。

set -euo pipefail

DESK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_TAURI="$DESK/src-tauri"
APPNAME="构想工作台"
BUNDLE_APP="$SRC_TAURI/target/release/bundle/macos/$APPNAME.app"

WORK="/tmp/gx-poc4"
INSTALL="$WORK/install"
DATA="$WORK/data"
POC_LOG="/tmp/gx-poc4-shell.log"
EXIT_LOG="/tmp/gx-desktop-exit.log"

cmd_run() {
  if [ ! -d "$BUNDLE_APP" ]; then
    echo "[poc4] 未找到构建产物 $BUNDLE_APP"
    echo "[poc4] 先：GX_POC4=1 node apps/desktop/scripts/stage-node-sidecar.mjs && cd apps/desktop/src-tauri && CARGO_BUILD_JOBS=2 tauri build --bundles app"
    exit 1
  fi
  mkdir -p "$INSTALL" "$DATA"
  # 必须先删目标再 cp -R：macOS 对已存在的 .app 是合并而非干净覆盖（run-poc3 实测）。
  rm -rf "$INSTALL/$APPNAME.app"
  cp -R "$BUNDLE_APP" "$INSTALL/$APPNAME.app"

  # 指纹硬校验：隔离副本的壳二进制必须与刚构建 bundle 逐字节一致（防壳旧包新假绿）。
  local h1 h2
  h1=$(shasum -a 256 "$BUNDLE_APP/Contents/MacOS/gouxiangdb-desktop" | awk '{print $1}')
  h2=$(shasum -a 256 "$INSTALL/$APPNAME.app/Contents/MacOS/gouxiangdb-desktop" | awk '{print $1}')
  [ "$h1" = "$h2" ] || { echo "[poc4] FAIL 副本壳二进制与 bundle 不一致"; exit 1; }
  # 确认探针页确实随包进了 Resources/server/public（缺它 PoC 会直接 FATAL）。
  if ! find "$INSTALL/$APPNAME.app/Contents/Resources" -path '*server/public/poc4.html' -print -quit | grep -q poc4.html; then
    echo "[poc4] FAIL 随包资源里没有 poc4.html——需要 GX_POC4=1 重新 stage 后 build"
    exit 1
  fi
  echo "[poc4] 副本就绪且壳指纹一致、poc4.html 已随包。"

  cmd_stop || true
  rm -f "$POC_LOG"
  # 数据目录隔离：main.rs 数据目录解析认 GX_POC3_DATA_DIR/GX_POC2_DATA_DIR（PoC 复用同一覆盖）。
  open -n "$INSTALL/$APPNAME.app" --env GX_POC4=1 --env "GX_POC3_DATA_DIR=$DATA"
  echo "[poc4] 已启动（隔离数据 ${DATA}）。等待无交互结论（最多 90s）…"

  local start=$SECONDS
  while (( SECONDS - start < 90 )); do
    if grep -Eq "PROBE GET /__poc4/DONE/" "$POC_LOG" 2>/dev/null; then break; fi
    sleep 1
  done

  echo
  echo "[poc4] ===== 壳/编排日志 ====="
  grep -E "PoC-4 begin|kernel ready|shell static|SHELL|FATAL" "$POC_LOG" 2>/dev/null || true
  echo "[poc4] ===== 探针结果（解码）====="
  print_probes
  echo
  if grep -Eq "DONE/12/true/pass12" "$POC_LOG" 2>/dev/null; then
    echo "[poc4] ✅ 核心 12/12 通过（壳口跨源承载本地内核成立）。CORP 观察见上面的 #80。"
  else
    echo "[poc4] ❌ 未拿到 12/12，详见上方与 ${POC_LOG}（尾 30 行）："; tail -30 "$POC_LOG" 2>/dev/null || true
    exit 1
  fi
}

# 把 b64url 的 PROBE 行解回中文。
print_probes() {
  /Users/daijing/.workbuddy/binaries/node/versions/22.22.2-6/bin/node -e '
    const fs=require("fs");
    const p="/tmp/gx-poc4-shell.log";
    if(!fs.existsSync(p)){process.exit(0);}
    for(const line of fs.readFileSync(p,"utf8").split("\n")){
      const m=line.match(/PROBE \S+ \/__poc4\/(?:s|obs)\/([01])\/(\d+)\/([^ &]+)/);
      if(!m) continue;
      let msg=m[3].replace(/-/g,"+").replace(/_/g,"/");
      while(msg.length%4) msg+="=";
      try{ msg=Buffer.from(msg,"base64").toString("utf8"); }catch(e){}
      console.log((m[1]==="1"?"PASS":"FAIL")+" #"+m[2]+"  "+msg);
    }
  '
}

cmd_log() { tail -n +1 -f "$POC_LOG"; }

cmd_stop() {
  osascript -e 'tell application "构想工作台" to quit' 2>/dev/null || true
  pkill -f "gxnode-aarch64-apple-darwin.*gx-poc4" 2>/dev/null || true
  sleep 1
  echo "[poc4] 已请求停止测试 App（隔离数据保留在 ${DATA}）。"
}

case "${1:-run}" in
  run) cmd_run ;;
  log) cmd_log ;;
  stop) cmd_stop ;;
  *) echo "用法: bash poc/run-poc4.sh {run|log|stop}"; exit 2 ;;
esac
