# CI 质量门 Runbook（M0 S7）

## 1. 唯一事实源

仓内平台中立脚本是门禁的唯一真相：

```bash
bash scripts/ci-quality.sh ; echo "rc=$?"   # 本机/Linux，Node>=20、pnpm>=9；期望 rc=0
```

`.workflow/ci.yml`（Gitee Go）只负责"拉起 Linux + Node20/pnpm9 + 调脚本"。Gitee Go 存在新旧两版 YAML 语法，**以仓库开通 Gitee Go 时控制台生成的 schema 为准**；平台语法漂移不影响门禁本身，因为所有判定都在 shell 脚本里。

## 2. 八个步骤

1. 工具版本断言（node>=20、pnpm>=9，读 package.json engines）
2. `pnpm install --frozen-lockfile`（lock 漂移即失败）
3. `prisma generate`（构建外置，CI 显式生成）
4. 三包 `tsc --noEmit`（api / web / shared-types；没有"shared build"伪步骤）
5. `@gx/api` esbuild 构建，并 `test -f apps/api/dist/index.js`
6. `pnpm -w test`（api 261 + shared 56；web 当前 passWithNoTests）
7. `pnpm -w lint`（真 ESLint，各包卡基线）
8. `prisma migrate deploy` 到 `mktemp` 临时库，断言 11/11 迁移落表 + `integrity_check=ok`，退出即清理（trap）。**不碰业务库、不需要密钥**。

任一步失败 `set -euo pipefail` 立即非零退出。

## 3. 真 ESLint 门禁与告警基线（修 D6 假绿）

M0 前 `pnpm -w lint` 是假绿：无脚本、无配置。现在：

- 根 `eslint.config.mjs`：ESLint 9 flat config + typescript-eslint v8 **非类型感知** recommended（类型问题仍归 tsc）；`eslint-plugin-react-hooks` 仅对 web 生效。
- 三个包各有 lint 脚本，用 `--max-warnings` 卡当前基线：

| 包 | 命令 | 基线 warning |
|----|------|--------------|
| @gx/api | `eslint . --max-warnings 5` | 5 |
| @gx/web | `eslint . --max-warnings 114` | 114 |
| @gx/shared-types | `eslint . --max-warnings 0` | 0 |
| **合计** | `pnpm -w lint` | **119，0 error** |

门禁为真的含义：当前树退出 0；**新增任何 warning（超过基线）或任何 error 都会让该包非零**。

自证（已实测）：

```bash
# 注入一个 error（eqeqeq）→ 该包 rc=1
printf 'export const f=(a:number,b:number)=>a==b;\n' > apps/api/src/__lintprobe.ts
pnpm --filter @gx/api lint ; echo $?   # 1（1 error, 5 warnings）
# 注入一个额外 warning（no-useless-escape）→ 超基线 rc=1
printf 'export const r=/\\a/;\n' > apps/api/src/__lintprobe.ts
pnpm --filter @gx/api lint ; echo $?   # 1（0 error, 6 warnings > 5）
rm apps/api/src/__lintprobe.ts
```

### 基线构成（119，全部为 warning）

- `@typescript-eslint/no-unused-vars` 74（历史遗留未用导入/变量）
- `react-hooks/exhaustive-deps` 23（历史 effect 依赖有意省略）
- `@typescript-eslint/no-unused-expressions` 6（`el && (el.x = v)` 短路赋值惯用法）
- `no-useless-escape` 5、`@typescript-eslint/no-explicit-any` 4
- `no-control-regex` 3（blocks/markdown 的 `\u0000` 占位符、sanitize-html 剥控制字符，均有意）
- `prefer-const` 2、`no-constant-binary-expression` 1、`no-case-declarations` 1

### 降基线纪律

清理一批告警后，**必须同步下调对应 package.json 的 `--max-warnings` 数字**，否则门禁形同虚设。降基线的小步 PR 应：改代码 → 跑 `pnpm -w lint` 取新计数 → 更新基线数字 → 全量 `bash scripts/ci-quality.sh` 绿。

## 4. 已知技术债：GX-LINT-DEBT-1（hooks 早返回）

三个视图组件在"守卫性早返回"之后才调用 hooks，违反 rules-of-hooks，但守卫结果在视图配置生命周期内稳定，当前运行正确：

- `apps/web/src/features/views/CalendarView.tsx`
- `apps/web/src/features/views/KanbanView.tsx`
- `apps/web/src/features/kb/canvas/NodeStyleBar.tsx`

已在**文件顶部**用 `/* eslint-disable react-hooks/rules-of-hooks -- 技术债 ... */` 精准豁免（不是全局降级，其它文件新违规仍报 error）。正确修法：把空态抽成独立包装组件，让 hooks 无条件执行；修复后移除文件级豁免并重新计数。

另有一处 `DefaultValueEditor.tsx` 的 `(x ?? "") ?? ""` 冗余空合取（no-constant-binary-expression，行为等价、无害），随基线后续清理。

## 5. Runner 资源与开通（外部前置）

- Linux x86_64，建议 2 vCPU / 4GB（esbuild + 将来 Playwright 够用）；Node 20 LTS、pnpm 9（corepack）。
- 缓存：pnpm store，键取 `pnpm-lock.yaml` 哈希；不接私服/远程缓存。
- 私有仓需 Gitee Go 已开通并有可用 PAT/runner——这是外部输入，未开通前流水线可以不亮灯，本地脚本即完整门禁。
- Gitee Go 免费构建时长/并发以平台当期说明为准。
- 脚本 migrate 干跑用 better-sqlite3（已在依赖）断言，**不依赖 runner 安装 sqlite3 CLI**。
