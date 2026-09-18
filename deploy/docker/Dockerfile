# syntax=docker/dockerfile:1
#
# GouXiangDB 自包含全栈镜像（单容器单端口：API TCP 3001 + Web 静态，数据全在 /data）。
#
# 跨架构发布（amd64/arm64）：
#   docker buildx build \
#     --platform linux/amd64,linux/arm64 \
#     -f deploy/docker/Dockerfile -t gouxiangdb:<ver> --push .
# 注意：better-sqlite3 必须拿到【目标架构】的 glibc prebuild（node:22 官方镜像 Debian glibc，
# better-sqlite3@13 运行时按 process.platform/arch/libc 从 prebuilds/ 选择 linux-x64.node /
# linux-arm64.node，无需 node-gyp）；Prisma query engine 也与平台相关，故 prisma generate
# 必须在【runner 阶段、目标架构】执行，切勿在 amd64 上构建 arm 镜像却沿用 amd64 引擎
# （buildx 在每个目标平台的原生/仿真环境中分别跑 RUN，天然满足）。

# ============================ builder ============================
FROM node:22-bookworm-slim AS builder

# ca-certificates：prisma engine 下载；openssl：prisma query engine 运行期依赖（libssl3）。
# python3/make/g++：better-sqlite3 包内含 binding.gyp，pnpm 安装期会触发 node-gyp rebuild。
# 仅 builder 需要（该阶段整体丢弃，不进 runner）；runner 侧用包内 prebuilds 运行时选择，免工具链。
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates openssl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /app

# 先只拷清单与补丁以最大化利用层缓存；只装构建 @gx/api、@gx/web 所需的 workspace 子集
# （显式 filter，避免安装/构建 apps/desktop 的 tauri 工具链）。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/design-tokens/package.json packages/design-tokens/
# 跳过 playwright 浏览器下载（web 的 devDep，vite build 用不到）。
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile --filter=@gx/api... --filter=@gx/web...

# 再拷全量源码并构建（vite web + esbuild api）。
COPY . .
RUN pnpm --filter @gx/web --filter @gx/api run build

# builder 侧生成一次 prisma client（占位 DATABASE_URL；esbuild 将 @prisma/client 外置，
# 真正权威的 client/引擎在 runner 目标架构上再 generate 一次）。
RUN DATABASE_URL=file:./_builder_generate_placeholder.db \
  pnpm --filter @gx/api exec prisma generate --schema=prisma/schema.prisma \
  && rm -f apps/api/_builder_generate_placeholder.db*

# 生成精简运行时 package.json（与 deploy/bin/package-release.mjs 同口径）：
# 去掉 esbuild 已内化的 @gx/* workspace 依赖，把 prisma CLI（源工程在 devDeps）提入 deps。
# 用独立脚本而非内联 node -e：长多行 JS 经 /bin/sh -c 单引号续行在 dash 下解析失败。
# deploy/docker/runtime-package.mjs 已随上方 COPY . . 进入 builder 工作目录。
RUN node deploy/docker/runtime-package.mjs runtime-package.json

# ============================ runner ============================
FROM node:22-bookworm-slim AS runner

# openssl：prisma query engine 运行需要；ca-certificates：出站 HTTPS（可选外发/拉取）。
# 不装 curl/wget——健康检查用镜像内置 node fetch。
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/apps/api

# 生产依赖：独立（非 workspace）精简 package.json + 仅生产安装。
# 不使用根 workspace lock（其中含 workspace:* 协议条目，独立目录无法直接消费），
# 与裸机发布物 package-release.mjs 的安装方式一致。
# --ignore-scripts：runner 无 python/g++；better-sqlite3 不需 node-gyp——其 lib/binding.js
# 运行时优先 require 包内 prebuilds/linux-<arch>.node（glibc，Debian 兼容）；
# @prisma/client 的 postinstall generate 也一并跳过，改为下方在目标架构上显式 prisma generate。
COPY --from=builder /app/runtime-package.json ./package.json
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate \
  && pnpm install --prod --ignore-workspace --ignore-scripts

# 运行所需白名单产物（不含 .env / *.db / src）。
COPY --from=builder --chown=node:node /app/apps/api/dist ./dist
COPY --from=builder --chown=node:node /app/apps/api/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=builder --chown=node:node /app/apps/api/prisma/migrations ./prisma/migrations
# M5/S2：vec0 白名单拷贝脚本（node:22-bookworm 为 glibc，vec0 有 linux-x64/arm64 子包，无 musl）。
COPY --from=builder --chown=node:node /app/apps/api/scripts/native ./scripts/native
COPY --from=builder --chown=node:node /app/apps/web/dist /app/web
COPY --chown=node:node deploy/docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# runner 目标架构上生成 prisma client + query engine（与 better-sqlite3 prebuild 同为目标架构）。
RUN DATABASE_URL=file:./_runner_generate_placeholder.db \
  node node_modules/prisma/build/index.js generate --schema=prisma/schema.prisma \
  && rm -f _runner_generate_placeholder.db*

# M5/S2：把目标架构 vec0 显式拷到白名单 native/<triplet>/（node:22-bookworm glibc，无 musl）。
# 故意不接 `|| echo 降级`：脚本对【合法降级】（平台不支持 / 可选依赖缺失 / getLoadablePath
# 报 unsupported）已自行 return exit 0 并打印 SKIP；只有真错误（参数/拷贝/架构自检失败）才
# 非零退出——那种情况必须让构建红，绝不能被 shell `||` 吞成"fts-only 正常"（曾掩盖相对
# --app-dir 致 createRequire 崩溃，使 x64/arm64 镜像 vec0 白名单从不生成）。
# buildx 每目标架构各自执行；musl/无预编译平台由脚本 SKIP 兜底，不阻断。
RUN node scripts/native/copy-vec-native.mjs --dest . --app-dir .

# 数据卷目录归属内置非 root 用户 node（uid 1000）。
RUN mkdir -p /data/uploads /data/backups /data/log && chown -R node:node /data /app
VOLUME ["/data"]

ENV NODE_ENV=production \
  PORT=3001 \
  GX_DATA_DIR=/data \
  UPLOAD_ROOT=/data/uploads \
  BACKUP_DIR=/data/backups \
  GX_AUDIT_DIR=/data/log \
  DATABASE_URL=file:/data/app.db \
  GX_MIGRATIONS_DIR=/app/apps/api/prisma/migrations \
  GX_WEB_DIST=/app/web
# JWT_SECRET 与 CORS_ORIGIN 故意不写死：由 compose/运行时注入，缺失即启动闸门退出码 2。

EXPOSE 3001
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini 负责信号转发与僵尸回收；entrypoint 内 exec node 使 node 直接接收 SIGTERM。
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
