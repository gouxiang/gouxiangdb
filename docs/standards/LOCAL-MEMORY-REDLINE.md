# 本机内存红线标准（LOCAL MEMORY REDLINE）

> 状态：Accepted（2026-10-24，戴总拍板，长期强制）
> 适用：所有在戴总 MacBook（16GB，darwin，长期不重启、常驻 WorkBuddy/Trae/Safari/Chrome）上作业的人与 AI worker。
> 可执行闸门：`scripts/guard/local-mem-guard.sh`（本标准的代码化落地，不只是口号）。

## 0. 为什么有这条标准（事故复盘）

戴总这台 16GB MacBook 长期不重启、常驻多个大型 App，内存常年贴上限。已**多次**因在本机误跑重活
（`pnpm install`、vite/esbuild 生产构建、Tauri 的 `cargo` 编译、全量 vitest）把整机内存打爆、
界面卡死，被迫**硬重启**——2026-10-24 又发生一次（某次后台 worker 在本机触发了重型构建）。
硬重启会打断所有在途工作、可能损坏未保存状态。本标准就是为了让这种事**不再发生**。

关键认知（不要再走弯路）：
- macOS **没有**「单进程超内存就自动杀它」的通用硬上限；一旦多个重进程叠加吃爆内存，系统先
  疯狂压缩/交换、整机变卡，不会像 Linux OOM killer 那样干脆地只杀元凶。
- 所以正确做法不是「爆了再排查」，而是**源头不启动**：重活物理挪走 + 本机命令套堆上限 + 开跑前查空闲。
- `kernel_task` 等系统进程占的内存大头是替全系统代管的「压缩内存 + 磁盘缓存」，压力退去会自动
  回落，**绝不能强退，也不要让戴总关正在用的程序**。

## 1. 三层硬手段（组合生效）

### 第 1 层：重活物理挪走 —— 本机从源头不启动（最重要）

| 命令类别 | 本机（MacBook） | 重活机 VM15 |
|---|---|---|
| `pnpm/npm/yarn install \| add \| ci \| update` | **禁止** | 允许 |
| `vite build` / esbuild 生产构建 / `pnpm ... build` | **禁止** | 允许 |
| Tauri：`cargo build/clippy/test/check`、`tauri build`、rustc | **禁止** | 允许 |
| 全量测试 `pnpm test`、`pnpm -w test`、无文件范围的 `vitest run` | **禁止** | 允许 |
| `prisma migrate deploy` 对真实/大库、批量数据脚本 | **禁止** | 允许（且独立临时库） |
| `tsc --noEmit`、eslint（定向文件） | 允许 | 允许 |
| 定向单测：`vitest run <具体 *.test.ts 路径>` | 允许（建议 `--pool=forks --poolOptions.forks.singleFork`） | 允许 |
| 轻量脚本、Read/Grep/Glob、git 只读、ssh/rsync | 允许 | 允许 |

重活机：**VM15 = 192.168.31.15**，`ssh daijing@192.168.31.15`（已免密），Debian，Node 必须 22、pnpm 9。
> VM15 内存也不大（约 5.8GB，常驻有别的项目进程）。在 VM15 上同样错峰、限并发：
> vitest 限 worker 数，`CARGO_BUILD_JOBS=2`，跑前先 `free -h` 看可用内存，不要和别人的进程抢。

### 第 2 层：本机 Node 套堆上限

本机任何 node 命令统一经守卫执行，自动注入：
```
NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=2048"
```
单进程 V8 老生代上限 2048MB，**超了让该进程自己 OOM 退出**，而不是无限申请把整机拖死。
默认值可用 `GX_NODE_MAX_OLD_MB` 覆盖，但不建议调大。

### 第 3 层：开跑前空闲内存闸门

守卫在放行本机命令前，用 `vm_stat` 计算「free + inactive」可用内存（inactive 大多可回收），
必须 `>= GX_MEM_FREE_MIN_MB`（默认 **2500MB**）才执行，否则直接拒绝并提示：等几分钟让系统自行回收，
或改去 VM15。不够就**不跑**，不要赌。

## 2. 怎么用（可执行）

```bash
# 只做空闲内存体检（不执行命令），开工前先看一眼：
scripts/guard/local-mem-guard.sh --check

# 本机轻活一律包一层（自动：拦重活 -> 查空闲 -> 套堆上限 -> 执行）：
scripts/guard/local-mem-guard.sh pnpm --filter @gx/api exec tsc --noEmit
scripts/guard/local-mem-guard.sh node node_modules/vitest/vitest.mjs run src/routes/__tests__/localSync.test.ts
```
- 守卫命中重活特征会以非 0 退出并打印 `[BLOCKED]`，提示去 VM15。
- 紧急时可用 `GX_MEM_GUARD=off <cmd>` 关闭（不建议，需在汇报里说明理由）。
- 守卫只在本机内存纪律上把关，**不改变**命令本身、不碰数据、不需要密钥。

## 3. 派工铁律（所有 AI worker 的 spawn 指令必须含这段）

> 本机是 16GB MacBook，禁止在本机跑任何重活：依赖安装、vite/esbuild/tauri 构建、cargo/rustc、
> 全量 vitest/prisma 重活一律 SSH 到 VM15（192.168.31.15，Node22/pnpm9）。本机只许编辑、
> tsc --noEmit、eslint、定向单测、轻脚本；本机命令尽量经
> `scripts/guard/local-mem-guard.sh` 执行。dev server 用完即关，不留后台。
> 绝不让戴总关正在用的程序，绝不强退系统进程（尤其 kernel_task）。

## 4. 给戴总的大白话

- 重活（装包、打包、编译、全量测试）一律在客厅那台「重活机」VM15 上干，您这台电脑只做轻量编辑和检查，
  从根上就不会再被拖爆。
- 万一某次内存又吃紧：**不用关程序、不用强退**，系统会在几分钟内自己压缩回收；可以让我跑
  `memory_pressure` 或守卫的 `--check` 给您看实时空闲，方便时再重启即可。
- 这不是口头约定：仓库里有一个守卫脚本会**真的拦住**重命令（已用 14 条用例回归验证），
  以后每次派活我都会把这条规则写进任务要求。

## 5. 变更记录
| 日期 | 内容 | 触发 |
|---|---|---|
| 2026-10-24 | 立标准 + 落地 `scripts/guard/local-mem-guard.sh`（14/14 拦截回归通过） | 又一次重活打爆内存被迫硬重启 |
