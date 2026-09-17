#!/usr/bin/env bash
# scripts/acceptance/check-share-links.sh
# 门② R7：旧分享链接升级后 5/5 直开 + 对抗矩阵。纯 curl，不依赖 jq（用 node 解析 JSON）。
#
# 用法:
#   check-share-links.sh <base-url> <before-manifest.json> [--body-limit-mb N]
#
# 从 manifest.shareTokens 读取：
#   doc-viewer / doc-editor-scratch / canvas / deep-closure / deleted-doc
# 判定（当前候选服务）：
#   - 5 个 token GET /api/public/s/<token>：有效 4 个 200；deleted-doc 404（这是硬期望，不计入"可开"）
#   - 深 3：layer2/layer3 200；layer4_forbidden 403；independentForbidden 403
#   - doc-viewer 根未级联：GET /s/<token>/doc/<nonCascadeChild> = 404
#   - 匿名写：editor scratch PUT 1,000,000 字符=200；1,100,000=按全局 body 上限（默认 1MB -> 413）
#     用独立 scratch 写，不污染 golden 正文
#   - viewer token PUT = 403（只读分享不可写）
#
# 退出码：0 全过；1 任一不符；64 参数/环境错。

set -uo pipefail

BASE_URL="${1:-}"
MANIFEST="${2:-}"
if [[ -z "$BASE_URL" || -z "$MANIFEST" ]]; then
  echo "用法: check-share-links.sh <base-url> <before-manifest.json>" >&2
  exit 64
fi
if [[ ! -f "$MANIFEST" ]]; then
  echo "manifest 不存在: $MANIFEST" >&2
  exit 64
fi
command -v curl >/dev/null 2>&1 || { echo "缺少 curl" >&2; exit 64; }
command -v node >/dev/null 2>&1 || { echo "缺少 node" >&2; exit 64; }

PUB="$BASE_URL/api/public"
FAIL=0
PASS=0
ok()   { echo "  PASS [$1] $2"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL [$1] $2 (期望 $3 实际 $4)"; FAIL=$((FAIL+1)); }

# json_get <file> <js-expr>
json_get() {
  node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const f=new Function("m","return ("+process.argv[2]+")");const v=f(m);if(v===undefined||v===null)process.exit(3);process.stdout.write(String(v));' "$1" "$2"
}

tok() { json_get "$MANIFEST" "m.shareTokens.find(t=>t.name==='$1').token"; }
field() { json_get "$MANIFEST" "m.shareTokens.find(t=>t.name==='$1').$2"; }

# http_code <method> <path> [bytes-to-PUT]
http_code() {
  local method="$1"; local p="$2"; local bytes="${3:-}"
  if [[ -n "$bytes" ]]; then
    node -e 'process.stdout.write("x".repeat(Number(process.argv[1])))' "$bytes" \
      | curl -s -o /dev/null -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' \
          --data-binary @<(node -e 'const n=process.argv[1];process.stdout.write(JSON.stringify({content:"x".repeat(Number(n))}))' "$bytes") \
          "$PUB$p"
  else
    curl -s -o /dev/null -w '%{http_code}' -X "$method" "$PUB$p"
  fi
}

# PUT JSON content of N chars (single clean construction)
put_code() {
  local p="$1"; local n="$2"
  curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: application/json' \
    --data-binary @<(node -e 'process.stdout.write(JSON.stringify({content:"x".repeat(Number(process.argv[1]))}))' "$n") \
    "$PUB$p"
}

echo "===== 分享链接直开（升级后候选服务）====="

T_DOC=$(tok doc-viewer)
T_EDIT=$(tok doc-editor-scratch)
T_CV=$(tok canvas)
T_DEEP=$(tok deep-closure)
T_DEL=$(tok deleted-doc)

for pair in "doc-viewer:$T_DOC" "doc-editor-scratch:$T_EDIT" "canvas:$T_CV" "deep-closure:$T_DEEP"; do
  name="${pair%%:*}"; t="${pair#*:}"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$PUB/s/$t")
  [[ "$code" == "200" ]] && ok "$name" "GET /s/<token> 200" || bad "$name" "GET /s/<token>" 200 "$code"
done

# 已删目标 = 404
code=$(curl -s -o /dev/null -w '%{http_code}' "$PUB/s/$T_DEL")
[[ "$code" == "404" ]] && ok "deleted-doc" "已删分享 token 404" || bad "deleted-doc" "GET deleted token" 404 "$code"

echo "===== 深 3 引用闭包 ====="
L2=$(field deep-closure closure.layer2)
L3=$(field deep-closure closure.layer3)
L4=$(field deep-closure closure.layer4_forbidden)
OUT=$(field deep-closure independentForbidden)

code=$(curl -s -o /dev/null -w '%{http_code}' "$PUB/s/$T_DEEP/ref/$L2")
[[ "$code" == "200" ]] && ok "deep-l2" "闭包第2层 /ref 200" || bad "deep-l2" "/ref layer2" 200 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$PUB/s/$T_DEEP/ref/$L3")
[[ "$code" == "200" ]] && ok "deep-l3" "闭包第3层（gxDocRef 拉入）/ref 200" || bad "deep-l3" "/ref layer3" 200 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$PUB/s/$T_DEEP/ref/$L4")
[[ "$code" == "403" ]] && ok "deep-l4-403" "第4层超深 /ref 403" || bad "deep-l4-403" "/ref layer4" 403 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$PUB/s/$T_DEEP/ref/$OUT")
[[ "$code" == "403" ]] && ok "out-of-closure-403" "独立越界文档 /ref 403" || bad "out-of-closure-403" "/ref independent" 403 "$code"

echo "===== 未级联子文档 = 404 ====="
CHILD=$(field doc-viewer nonCascadeChild)
code=$(curl -s -o /dev/null -w '%{http_code}' "$PUB/s/$T_DOC/doc/$CHILD")
[[ "$code" == "404" ]] && ok "non-cascade-child" "includeChildren=false 访问子文档 404" || bad "non-cascade-child" "/doc child" 404 "$code"

echo "===== 匿名写边界（独立 editor scratch，不碰 golden 正文）====="
# 1,000,000 字符：默认 1MB 全局上限边缘（1M 字符 UTF-8 约 1MB），预期 200
code=$(put_code "/s/$T_EDIT/doc/$(field doc-editor-scratch rootId)/content" 1000000)
[[ "$code" == "200" ]] && ok "anon-write-1M" "匿名 PUT 1,000,000 字符 200" || bad "anon-write-1M" "PUT 1M" 200 "$code"
# 1,100,000 字符：超过默认 1MB body 上限 -> 413（若服务以 GX_BODY_LIMIT_JSON>=3 启动，路由 zod 2MB 内仍 200）
code=$(put_code "/s/$T_EDIT/doc/$(field doc-editor-scratch rootId)/content" 1100000)
if [[ "$code" == "413" ]]; then
  ok "anon-write-1.1M-413" "默认 1MB body 上限拦截 413"
elif [[ "$code" == "200" ]]; then
  ok "anon-write-1.1M-200" "body 上限已调大（GX_BODY_LIMIT_JSON>=3），1.1M 在 zod 2MB 内 200"
else
  bad "anon-write-1.1M" "PUT 1.1M" "413 或 200" "$code"
fi

echo "===== 只读分享写 = 403 ====="
code=$(put_code "/s/$T_DOC/doc/$(field doc-viewer rootId)/content" 100)
[[ "$code" == "403" ]] && ok "viewer-write-403" "viewer 分享匿名写 403" || bad "viewer-write-403" "viewer PUT" 403 "$code"

echo "----------------------------------------"
echo "分享矩阵：PASS=$PASS FAIL=$FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  echo "SHARE_VERDICT=FAIL"
  exit 1
fi
echo "SHARE_VERDICT=PASS"
