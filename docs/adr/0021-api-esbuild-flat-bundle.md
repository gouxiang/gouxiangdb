# ADR-0021：API 生产构建改用 esbuild 扁平单文件 Bundle

**状态（Status）**：Accepted（M0 落地，2026-09-13，S2 实现，修阻断项 D1/B0）
**作者**：后端（mvp-dev-expert-team-backend）
**编号说明**：0011–0020 已由企业版架构 §10.4 分配；本条工程构建决策使用 0021。

---

## 背景（Background）

最初的生产构建假设是「`tsc` 把 `apps/api/src` 编译成 `dist/`，再 `node dist/index.js`」。
在真实打包验证中该路径不可用（阻断项 D1，连带 B0「产物不可运行」），具体三个问题：

1. **产物路径错位**：源码经 tsconfig paths 引用 monorepo 内的 `@gx/shared-types`（裸 TS 源），
   `tsc` 为保持 rootDir 一致把共同根抬到 monorepo 根，产物落在
   `dist/apps/api/src/index.js`，与 `package.json` 的 `start = node dist/index.js` 不符。
2. **运行时裸 `@gx/` 解析失败**：`@gx/shared-types` 包只发布 TypeScript 源码、没有自己的
   build 产物；即使把 tsc 输出搬平，运行时仍出现 `ERR_MODULE_NOT_FOUND`（找不到 `@gx/...`），
   因为 Node 运行期没有 tsconfig paths 映射，也没有可解析的已编译包。
3. **测试文件被编进产物**：tsc 按目录全量编译，会把 `src/**/__tests__/*.test.ts` 一并输出到
   dist，污染发布物。

候选：a) 维持 tsc，再补一套复杂的路径改写 + 先构建 shared-types；b) 用打包器把入口连同
workspace 源码打成单文件。a) 要求 shared-types 建立独立 build/产物契约并同步维护多份 tsconfig
rootDir，脆弱且拖慢；b) 与「发布一个自包含 `dist/index.js`」的目标直接匹配。

## 决策（Decision）

用 **esbuild** 从 `apps/api/src/index.ts` 打一个**扁平 ESM 单文件 `dist/index.js`**
（`apps/api/scripts/build.mjs`）：

- `bundle: true`、`platform: node`、`format: esm`、`target: node20`；
- **内化 workspace 源码**：不显式标记 `@gx/*` 为 external，让 esbuild 经 tsconfig paths 把
  `@gx/shared-types` 的 TS 源码直接编进单文件，从而彻底消除运行时裸 `@gx/` 解析；
- **外置运行时/原生依赖**：`@hono/node-server`、`@prisma/client`、`hono`、`jose`、`zod`、
  `bcryptjs`、`better-sqlite3` 保持 external，由发布包 `node_modules` 提供。
  尤其 `better-sqlite3` 的 `.node` 原生件与 Prisma query engine 严禁打进 bundle；
- `define` 注入 `process.env.GX_VERSION`（取自根 package.json，与版本单源 S1 一致）；
- 构建前清空 dist、构建后断言 `dist/index.js` 存在；`sourcemap:false`、`keepNames:true`。

发布侧（S8）配合：`deploy/bin/package-release.mjs` 用精简运行时 `package.json`（移除已内化的
`@gx/*` 依赖、把 `prisma` CLI 提入 deps），在发布目录内 `pnpm install --prod --ignore-workspace`
并 `prisma generate`，产出自包含且可在目标机 `node dist/index.js` 的 api 目录。

## 后果（Consequences）

正面：

- 单一入口 `node dist/index.js` 在隔离发布目录实测可启动，`/readyz` 五探针全 true，
  彻底消除路径错位与裸 `@gx/` 运行时错误（D1/B0 关闭）。
- workspace 的 TS 源码在构建期内化，shared-types 无需独立 build/发布契约，减少维护面。
- 原生件外置，避免 esbuild 错误内联 `.node`/engine；测试文件天然不进入 bundle。
- 构建毫秒级，适合 CI 与裸机打包。

负面/约束：

- esbuild 不做类型检查（只转译），类型正确性必须由独立的 `tsc --noEmit` 把关——
  CI（S7 `scripts/ci-quality.sh`）因此把 typecheck 与 build 分为两步，缺一不可。
- 依赖图里的「哪些包外置」是显式白名单，新增含原生二进制或自带引擎的运行时依赖时，
  需要同步加入 build.mjs 的 external 列表与发布精简 package.json。
- bundle 会合并源码，报错栈的文件粒度变粗；通过 `keepNames` 保留函数名缓解，M0 不开 sourcemap。

## 相关（Related）

- [ADR-0002](0002-database-sqlite.md)：monorepo 与 SQLite 基线
- [ADR-0003](0003-bare-metal-topology.md)：发布目录与 `node dist/index.js` 启动约定
- 实现：`apps/api/scripts/build.mjs`（external 白名单与 GX_VERSION define）
- 打包：`deploy/bin/package-release.mjs`（精简运行时 package.json + 生产安装 + prisma generate）
- 质量门：`scripts/ci-quality.sh`（typecheck 与 esbuild build 分两步）
