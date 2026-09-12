#!/usr/bin/env bash
# GouXiangDB M0 平台中立质量门（S7）。
# 唯一事实源：任何 Linux/本机（Node>=20、pnpm>=9）都可直接 `bash scripts/ci-quality.sh` 复现。
# Gitee Go / GitHub Actions 只负责拉起运行器并调用本脚本，门禁真相不依赖任何平台 YAML。
#
# 步骤：版本断言 → frozen 安装 → prisma 生成 → 三包 typecheck → api 构建 → 全量测试
#       → 真 lint（基线告警卡 max-warnings，注入即红）→ migrate deploy 临时库干跑（动态 N/N，数迁移目录 + integrity）。
# 任一步失败立即退出（set -e + pipefail），不改业务库、不依赖任何密钥。

set -euo pipefail

# 从 scripts/ 上溯到仓库根，保证与调用目录无关。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

# 颜色仅用于本地可读性，纯文本不使用 emoji。
if [[ -t 1 ]]; then
  C_STEP=$'\033[1;36m'; C_OK=$'\033[1;32m'; C_ERR=$'\033[1;31m'; C_RST=$'\033[0m'
else
  C_STEP=""; C_OK=""; C_ERR=""; C_RST=""
fi

step() { printf '\n%s==> %s%s\n' "${C_STEP}" "$1" "${C_RST}"; }
fail() { printf '%s[FAIL]%s %s\n' "${C_ERR}" "${C_RST}" "$1" >&2; exit 1; }

# 允许调用方覆盖包管理器可执行（CI 上可指向 corepack 激活的 pnpm）。
PNPM="${PNPM:-pnpm}"

# ---------------------------------------------------------------------------
# 1) 工具版本断言（engines: node>=20, pnpm>=9）
# ---------------------------------------------------------------------------
step "1/8 工具版本断言（node>=20, pnpm>=9）"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "${NODE_MAJOR}" -ge 20 ]] || fail "需要 Node >= 20，当前 $(node -v)"
PNPM_MAJOR="$("${PNPM}" -v | awk -F. '{print $1}')"
[[ "${PNPM_MAJOR}" -ge 9 ]] || fail "需要 pnpm >= 9，当前 $("${PNPM}" -v)"
printf 'node %s, pnpm %s\n' "$(node -v)" "$("${PNPM}" -v)"

# ---------------------------------------------------------------------------
# 2) 冻结锁安装（lock 与 package.json 不一致立即失败，CI 不允许漂移）
# ---------------------------------------------------------------------------
step "2/8 pnpm install --frozen-lockfile"
"${PNPM}" install --frozen-lockfile

# ---------------------------------------------------------------------------
# 3) Prisma Client 生成（构建外置，CI 显式跑一次）
# ---------------------------------------------------------------------------
step "3/8 prisma generate"
"${PNPM}" --filter @gx/api run db:generate

# ---------------------------------------------------------------------------
# 4) 三包 typecheck（无 "shared build" 这一伪步骤；shared 靠 tsc --noEmit）
# ---------------------------------------------------------------------------
step "4/8 typecheck（api / web / shared-types）"
"${PNPM}" --filter @gx/api --filter @gx/web --filter @gx/shared-types run typecheck

# ---------------------------------------------------------------------------
# 5) API 生产构建（S2 esbuild 扁平单文件），并断言产物存在
# ---------------------------------------------------------------------------
step "5/8 API 生产构建 + 产物断言"
"${PNPM}" --filter @gx/api run build
[[ -f apps/api/dist/index.js ]] || fail "构建产物 apps/api/dist/index.js 不存在"
printf 'dist/index.js 存在（%s 字节）\n' "$(wc -c < apps/api/dist/index.js | tr -d ' ')"

# ---------------------------------------------------------------------------
# 6) 全量测试（api + shared；web 当前 passWithNoTests）
# ---------------------------------------------------------------------------
step "6/8 全量测试 pnpm -w test"
"${PNPM}" -w test

# ---------------------------------------------------------------------------
# 7) 真 lint（ESLint 9 flat config；各包 --max-warnings 卡现存基线，新增即红）
# ---------------------------------------------------------------------------
step "7/8 真 lint（基线卡 max-warnings：api=5 / web=114 / shared=0）"
"${PNPM}" -w lint

# ---------------------------------------------------------------------------
# 8) migrate deploy 干跑：只在临时库，不碰业务库、不需要密钥
#    断言动态 N/N 迁移全部落表（N 由迁移目录实时计数，见下 EXPECTED_N）+ integrity_check=ok。
#    优先用 better-sqlite3（已在依赖），runner 无 sqlite3 CLI 也能跑。
# ---------------------------------------------------------------------------
step "8/8 migrate deploy 临时库干跑"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
TMP_DB="${TMP_DIR}/ci.db"
MIG_DIR="apps/api/prisma/migrations"
EXPECTED_N="$(find "${MIG_DIR}" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"

DATABASE_URL="file:${TMP_DB}" "${PNPM}" --filter @gx/api exec prisma migrate deploy

( cd apps/api && node -e '
const Database = require("better-sqlite3");
const db = new Database(process.argv[1], { readonly: true });
const expected = Number(process.argv[2]);
const applied = db.prepare("SELECT count(*) AS n FROM _prisma_migrations").get().n;
const check = db.prepare("PRAGMA integrity_check").get()["integrity_check"];
if (applied !== expected) { console.error(`迁移数不符: ${applied} != ${expected}`); process.exit(1); }
if (check !== "ok") { console.error(`integrity_check 非 ok: ${check}`); process.exit(1); }
console.log(`迁移落表 ${applied}/${expected}，integrity_check=${check}`);
' "${TMP_DB}" "${EXPECTED_N}" )

printf '\n%s[CI QUALITY GATE: PASS]%s 全部 8 步通过（迁移 %s/%s）\n' \
  "${C_OK}" "${C_RST}" "${EXPECTED_N}" "${EXPECTED_N}"
