#!/bin/sh
# fnOS CGI 入口：把 /cgi/ThirdParty/gouxiangdb/index.cgi/ 下的请求反向代理到本机服务。
#
# 为什么不是统一网关（gatewayPrefix / gatewaySocket）：
#   2026-09-18 在本机 fnOS 1.2.0604 上实测——声明 gatewayPrefix=/app/gouxiangdb 后，
#   访问 http://<nas>:5666/app/gouxiangdb/ 返回的是门户自己的 "invalid token"，
#   请求根本没进到应用；桌面点开即空白页。设备上唯一正常工作的三方应用
#   （com.fnos.dashboard）走的正是本文件的 CGI 反代路线，其 changelog 亦写明
#   "beta-0.0.11：改用 fnOS 公开的 CGI 反代入口……替代未对三方应用生效的网关注册"。
#   因此：入口用 CGI（fnOS 先校验 NAS 登录态再执行本脚本），后端监听本机 TCP 端口。
#
# 实现参照设备上在跑的 com.fnos.dashboard/ui/index.cgi（反代语义与错误处理同源），
# 差异：目标端口取 TRIM_SERVICE_PORT（本应用 3001），并显式转发 X-Trim-* 身份头。

TARGET_HOST=127.0.0.1
TARGET_PORT=${TRIM_SERVICE_PORT:-3001}

REQ_URI=${REQUEST_URI:-"/"}
URI_NO_QUERY=${REQ_URI%%\?*}
QUERY_STRING=${QUERY_STRING:-}

# 无尾斜杠的入口 302 到带斜杠形式，保证页面内相对路径可用
case "$URI_NO_QUERY" in
    */index.cgi)
        printf "Status: 302 Found\r\n"
        printf "Location: %s/%s\r\n" "$URI_NO_QUERY" "${QUERY_STRING:+?$QUERY_STRING}"
        printf "Content-Type: text/plain; charset=utf-8\r\n"
        printf "Cache-Control: no-store\r\n\r\n"
        exit 0
        ;;
esac

# 取 index.cgi 之后的子路径：/cgi/.../index.cgi/settings -> /settings
case "$URI_NO_QUERY" in
    *index.cgi*) REL_PATH="${URI_NO_QUERY#*index.cgi}" ;;
    *) REL_PATH="$URI_NO_QUERY" ;;
esac
[ -n "$REL_PATH" ] || REL_PATH="/"
case "$REL_PATH" in
    *..*)
        printf "Status: 400 Bad Request\r\n"
        printf "Content-Type: text/plain; charset=utf-8\r\n\r\n"
        printf "Bad Request\n"
        exit 0
        ;;
esac

TARGET_URL="http://${TARGET_HOST}:${TARGET_PORT}${REL_PATH}"
[ -n "$QUERY_STRING" ] && TARGET_URL="${TARGET_URL}?${QUERY_STRING}"

METHOD=${REQUEST_METHOD:-GET}
# --max-time：后端卡住时快速失败，避免 CGI 进程堆积（502 分支会返回提示）
set -- -s --max-time 30 --connect-timeout 5 -X "$METHOD"
[ -n "$HTTP_ACCEPT" ]          && set -- "$@" -H "accept: $HTTP_ACCEPT"
[ -n "$HTTP_ACCEPT_LANGUAGE" ] && set -- "$@" -H "accept-language: $HTTP_ACCEPT_LANGUAGE"
[ -n "$HTTP_USER_AGENT" ]      && set -- "$@" -H "user-agent: $HTTP_USER_AGENT"
[ -n "$HTTP_ORIGIN" ]          && set -- "$@" -H "origin: $HTTP_ORIGIN"
[ -n "$HTTP_REFERER" ]         && set -- "$@" -H "referer: $HTTP_REFERER"
[ -n "$HTTP_COOKIE" ]          && set -- "$@" -H "cookie: $HTTP_COOKIE"
# ★ 应用 JWT 走自定义头 X-GX-Token：fnOS 的 trim_http_cgi 会把 Authorization 当自家令牌
#   校验（非法即返回 200 + "invalid token" 并吞掉请求），故 Web 端不使用 Authorization。
[ -n "$HTTP_X_GX_TOKEN" ]      && set -- "$@" -H "x-gx-token: $HTTP_X_GX_TOKEN"
# fnOS 门户校验登录态后注入的身份头（应用自身仍有 JWT 鉴权，这里只是透传便于审计/SSO）
[ -n "$HTTP_X_TRIM_USERID" ]   && set -- "$@" -H "x-trim-userid: $HTTP_X_TRIM_USERID"
[ -n "$HTTP_X_TRIM_USERNAME" ] && set -- "$@" -H "x-trim-username: $HTTP_X_TRIM_USERNAME"
[ -n "$HTTP_X_TRIM_ISADMIN" ]  && set -- "$@" -H "x-trim-isadmin: $HTTP_X_TRIM_ISADMIN"
case "$METHOD" in
    POST|PUT|PATCH|DELETE)
        set -- "$@" -H "Content-Type: ${CONTENT_TYPE:-application/json}"
        set -- "$@" --data-binary @-
        ;;
esac

HEADER_FILE=$(mktemp) || exit 1
BODY_FILE=$(mktemp) || { rm -f "$HEADER_FILE"; exit 1; }
trap 'rm -f "$HEADER_FILE" "$BODY_FILE"' EXIT

curl "$@" -D "$HEADER_FILE" -o "$BODY_FILE" "$TARGET_URL" || {
    printf "Status: 502 Bad Gateway\r\n"
    printf "Content-Type: text/plain; charset=utf-8\r\n\r\n"
    printf "后端服务未响应，请在应用中心重启该应用。\n"
    exit 0
}

CODE=$(head -1 "$HEADER_FILE" | awk '{print $2}')
[ -n "$CODE" ] && [ "$CODE" != "200" ] && printf "Status: %s\r\n" "$CODE"
grep -i "^Content-Type:" "$HEADER_FILE" | tail -1 | tr -d '\r'
printf "Cache-Control: no-store\r\n"
printf "\r\n"
cat "$BODY_FILE"
