#!/bin/bash
# scripts/compare-test.sh
# v1 vs v2 深度对比测试脚本
# 流程：
#   1. 从 v1 SQLite (~/Library/Application Support/GouXiangDB/data.gxdb) 导出测试数据集
#   2. 用迁移脚本导入到 v2 PostgreSQL
#   3. 跑功能测试矩阵（vitest + playwright）
#   4. 截图对比（v1 desktop vs v2 web）——≤2% 像素差异视为通过
#   5. 跑性能基线
#   6. 输出对比报告
#
# 状态：骨架阶段，待全部功能 1:1 复刻后启用
# 触发：每周 v2 重大变更后

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPORT_DIR="$ROOT_DIR/reports"
TIMESTAMP=$(date +"%Y-%m-%d-%H%M%S")
REPORT_FILE="$REPORT_DIR/compare-$TIMESTAMP.md"

mkdir -p "$REPORT_DIR"

echo "═══════════════════════════════════════════════════"
echo "  GouXiangDB v1 vs v2 深度对比测试"
echo "═══════════════════════════════════════════════════"
echo ""

# 1. 健康检查
echo "▶ [1/6] 健康检查..."
curl -fs http://localhost:3001/health >/dev/null || {
  echo "✗ API server 未启动，请先运行 pnpm dev:api"
  exit 1
}
echo "  ✓ API online"

# 2. 导出 v1 数据
echo ""
echo "▶ [2/6] 从 v1 导出测试数据集..."
V1_DB="$HOME/Library/Application Support/GouXiangDB/data.gxdb"
if [ ! -f "$V1_DB" ]; then
  echo "  ⚠ v1 数据未找到 ($V1_DB)，跳过导出，使用 v2 自带 seed 数据"
else
  echo "  ✓ 找到 v1 数据库: $V1_DB"
  # TODO: 调 pnpm --filter @gx/api run export:v1
fi

# 3. 导入 v2 + 跑功能测试
echo ""
echo "▶ [3/6] 跑功能测试矩阵..."
cd "$ROOT_DIR"
pnpm test 2>&1 | tee "$REPORT_DIR/test-output-$TIMESTAMP.txt"

# 5. 性能基线（待实现）
echo ""
echo "▶ [5/6] 跑性能基线..."
echo "  ⏳ 性能基线脚本待开发"

# 6. 输出报告
echo ""
echo "▶ [6/6] 生成对比报告..."
cat > "$REPORT_FILE" << EOF
# GouXiangDB v1 vs v2 对比报告

**时间**: $TIMESTAMP
**状态**: ⏳ 骨架阶段（功能完成度: ~15%）

## 1. 功能测试

\`\`\`
$(cat "$REPORT_DIR/test-output-$TIMESTAMP.txt" 2>/dev/null || echo "无输出")
\`\`\`

## 2. 视觉对比

⏳ 待开发（Playwright screenshot diff）

## 3. 性能基线

⏳ 待开发

## 4. 已知差异

⏳ 待开发

EOF

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ 对比报告: $REPORT_FILE"
echo "═══════════════════════════════════════════════════"