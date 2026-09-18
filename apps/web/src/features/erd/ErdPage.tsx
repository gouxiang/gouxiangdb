// apps/web/src/features/erd/ErdPage.tsx
// Base 内 ERD 关系图：所有表 + 跨表关联（links / subtype）一览
// 圆环布局 + SVG 曲线连接。点击节点跳转该表。
// 数据来源：GET /api/bases/:baseId/erd（一次性，避免 N×useFields 的 hooks 爆炸）。

import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useBaseErd } from "../../api/hooks";
import { Spinner } from "../../components/ui";
import { Icon } from "../../components/icons";
import { colors } from "@gx/design-tokens";

const NODE_W = 200;
const NODE_H = 78;
const SVG_PADDING = 60;

interface Node {
  id: string;
  name: string;
  fieldCount: number;
  outDegree: number;
  x: number;
  y: number;
}

interface Edge {
  fromTableId: string;
  toTableId: string;
  fromFieldName: string;
  fieldType: string;
  relationKind: string | null;
  fromPort: number;
  toPort: number;
}

export default function ErdPage() {
  const { baseId } = useParams<{ baseId: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = useBaseErd(baseId ?? null);

  const { nodes, edges, width, height, cx, cy } = useMemo(() => {
    if (!data) return { nodes: [] as Node[], edges: [] as Edge[], width: 0, height: 0, cx: 0, cy: 0 };
    const tables = data.tables;
    if (tables.length === 0) {
      return { nodes: [] as Node[], edges: [] as Edge[], width: 600, height: 200, cx: 0, cy: 0 };
    }

    const radius = Math.max(140, Math.min(320, 90 + tables.length * 16));
    const cx = radius + SVG_PADDING;
    const cy = radius + SVG_PADDING;
    const nodes: Node[] = tables.map((t, i) => {
      const angle = (i / tables.length) * Math.PI * 2 - Math.PI / 2;
      return {
        id: t.id,
        name: t.name,
        fieldCount: t.fieldCount,
        outDegree: t.outDegree,
        x: cx + radius * Math.cos(angle) - NODE_W / 2,
        y: cy + radius * Math.sin(angle) - NODE_H / 2,
      };
    });

    // 端口计数（多条线时错开落点）
    const outCount = new Map<string, number>();
    const inCount = new Map<string, number>();
    const edges: Edge[] = data.edges.map((e) => {
      const fp = outCount.get(e.fromTableId) ?? 0;
      outCount.set(e.fromTableId, fp + 1);
      const tp = inCount.get(e.toTableId) ?? 0;
      inCount.set(e.toTableId, tp + 1);
      return {
        fromTableId: e.fromTableId,
        toTableId: e.toTableId,
        fromFieldName: e.fromFieldName,
        fieldType: e.fieldType,
        relationKind: e.relationKind,
        fromPort: fp,
        toPort: tp,
      };
    });

    const width = (radius + SVG_PADDING) * 2;
    const height = (radius + SVG_PADDING) * 2;
    return { nodes, edges, width, height, cx, cy };
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex h-full items-center justify-center text-gx-text-hint">
        加载失败
      </div>
    );
  }
  if (data.tables.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-gx-text-hint">
        <Icon name="table" size={32} />
        <span className="text-gx-13">这个数据库还没有数据表</span>
      </div>
    );
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  return (
    <div className="h-full overflow-auto bg-gx-card-bg p-gx-lg">
      <div className="mb-gx-md flex items-center gap-3 text-gx-13 text-gx-text-secondary">
        <Icon name="link" size={14} />
        <span>共 {data.tables.length} 张表，{data.edges.length} 条关联</span>
        <span className="flex-1" />
        <span className="text-gx-12 text-gx-text-hint">点击节点跳转该表</span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block"
        style={{ minWidth: width, minHeight: height, width: "100%" }}
        role="img"
        aria-label="数据库关系图"
      >
        <defs>
          <marker id="erd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill={colors.accent} />
          </marker>
        </defs>

        {/* 边 */}
        {edges.map((e, i) => {
          const a = nodeMap.get(e.fromTableId);
          const b = nodeMap.get(e.toTableId);
          if (!a || !b) return null;
          const ax = a.x + NODE_W / 2;
          const ay = a.y + NODE_H / 2;
          const bx = b.x + NODE_W / 2;
          const by = b.y + NODE_H / 2;
          const mx = (ax + bx) / 2;
          const my = (ay + by) / 2;
          const dx = bx - ax;
          const dy = by - ay;
          const len = Math.max(1, Math.hypot(dx, dy));
          // 多条线用端口差偏移
          const offset = 28 * (e.fromPort - e.toPort + 1);
          const cx2 = mx + (-dy / len) * offset;
          const cy2 = my + (dx / len) * offset;
          return (
            <g key={`${e.fromTableId}-${e.toTableId}-${i}`}>
              <path
                d={`M ${ax} ${ay} Q ${cx2} ${cy2} ${bx} ${by}`}
                stroke={colors.accent}
                strokeWidth={1.4}
                fill="none"
                opacity={0.5}
                markerEnd="url(#erd-arrow)"
              />
              <text
                x={cx2}
                y={cy2 - 4}
                fontSize={10}
                textAnchor="middle"
                fill={colors.textTertiary}
              >
                {e.fromFieldName}
              </text>
            </g>
          );
        })}

        {/* 节点 */}
        {nodes.map((n) => (
          <foreignObject key={n.id} x={n.x} y={n.y} width={NODE_W} height={NODE_H}>
            <button
              type="button"
              onClick={() => navigate(`/base/${baseId}/table/${n.id}`)}
              className="group flex h-full w-full flex-col items-start gap-1 rounded-gx-lg border border-gx-border bg-gx-surface p-2 text-left shadow-sm transition hover:border-gx-accent hover:shadow"
            >
              <div className="flex w-full items-center gap-1.5">
                <Icon name="table" size={14} className="text-gx-accent" />
                <span className="flex-1 truncate text-gx-13 font-semibold text-gx-text-primary">
                  {n.name || "未命名"}
                </span>
              </div>
              <div className="flex w-full items-center justify-between text-gx-11 text-gx-text-hint">
                <span>{n.fieldCount} 字段</span>
                {n.outDegree > 0 && <span className="text-gx-accent">{n.outDegree} 关联</span>}
              </div>
            </button>
          </foreignObject>
        ))}
      </svg>
    </div>
  );
}
