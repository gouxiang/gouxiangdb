#!/usr/bin/env bash
# deploy/probe/docker-probe.sh — Docker 可用性只读探针（M0 S8，可选，半天工作量）。
#
# 用途：在目标客户机上【只读】探测容器化前置条件，输出一个三态结论供部署清单记录。
#       绝不安装任何东西、绝不写 compose 交付物（按 ARCH §4.6，compose 在 P2/P3
#       且需客户接受；M0 交付主路径是裸机 systemd + Caddy）。
#
# 结论（三态）：
#   docker-ready        已装 docker engine + compose 插件，当前用户可跑 hello-world（或明显可用）
#   docker-installable  未装或不可用，但 OS/内核/权限满足“可安装”条件（Linux + 内核>=3.10 + root/sudo）
#   docker-unavailable  非 Linux、内核过旧、或无安装权限，M0 不建议走容器路径
#
# 用法：bash deploy/probe/docker-probe.sh   （建议用能读 docker 与 uname 的普通账户即可）

set -euo pipefail

log() { printf '[docker-probe] %s\n' "$*"; }

OS_KIND="$(uname -s)"
KERNEL_REL="$(uname -r)"
HAVE_ROOT=0
if [[ "$(id -u)" -eq 0 ]] || command -v sudo >/dev/null 2>&1; then HAVE_ROOT=1; fi

compose_ok() {
  # 同时认 `docker compose`（插件）与旧版独立 `docker-compose`。
  if docker compose version >/dev/null 2>&1; then return 0; fi
  if command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then return 0; fi
  return 1
}

# 轻量探活：不强行拉镜像（离线环境），仅判断 daemon 可达且能应答。
daemon_ok() {
  docker info >/dev/null 2>&1
}

kernel_major="$(printf '%s' "$KERNEL_REL" | awk -F. '{print $1}')"
kernel_minor="$(printf '%s' "$KERNEL_REL" | awk -F. '{print $2}')"
kernel_new_enough() {
  # 3.10 是 Docker 官方最低内核门槛。
  [[ "$kernel_major" -gt 3 ]] 2>/dev/null && return 0
  [[ "$kernel_major" -eq 3 && "$kernel_minor" -ge 10 ]] 2>/dev/null && return 0
  return 1
}

log "OS=$OS_KIND kernel=$KERNEL_REL root_or_sudo=$HAVE_ROOT"

if [[ "$OS_KIND" != "Linux" ]]; then
  log "RESULT: docker-unavailable"
  log "原因：非 Linux（${OS_KIND}）。M0 容器交付仅针对 Linux 服务器；本机仍可用裸机/桌面路径。"
  exit 0
fi

if command -v docker >/dev/null 2>&1; then
  if daemon_ok; then
    if compose_ok; then
      log "docker 与 compose 均可用，daemon 可达。"
      log "RESULT: docker-ready"
      exit 0
    fi
    log "docker engine 可用但缺 compose 插件（docker compose / docker-compose 均失败）。"
    log "RESULT: docker-installable"
    log "动作：安装 docker-compose-plugin 后即可（本探针不代安装）。"
    exit 0
  fi
  log "docker 已安装但 daemon 不可达（服务未启动或当前用户无权限）。"
  log "RESULT: docker-installable"
  log "动作：启动 docker 服务或将用户加入 docker 组（本探针不代操作）。"
  exit 0
fi

# 未装 docker：判断是否具备安装条件。
if kernel_new_enough && [[ "$HAVE_ROOT" -eq 1 ]]; then
  log "未安装 docker；Linux 内核满足 >=3.10 且有 root/sudo。"
  log "RESULT: docker-installable"
  log "动作：客户同意后按其发行版官方仓库安装 docker engine + compose 插件（本探针不代安装）。"
  exit 0
fi

log "未安装 docker，且内核过旧或无 root/sudo，不具备自助安装条件。"
log "RESULT: docker-unavailable"
exit 0
