// apps/web/src/components/EntityPicker.tsx
// 实体选择器：在 Markdown 文档里插入「内部链接」时选择目标实体。
// 支持两类来源：
//   - 知识库：文档 / 画布（按知识库切换，标题搜索）
//   - 数据表：某张数据表（按 Base 切换，表名搜索）
// 选中后回调 InternalTarget（见 lib/internal-links）与显示标题，由调用方拼接链接。

import { useMemo, useState } from "react";
import { Modal, Input } from "./ui";
import { Icon, type IconName } from "./icons";
import { useBases, useTables } from "../api/hooks";
import { useKbList, useKbDocs } from "../features/kb/kb-hooks";
import type { InternalTarget } from "../lib/internal-links";

export interface PickedEntity {
  target: InternalTarget;
  title: string;
  group: string;
}

type Tab = "doc" | "table";

export function EntityPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (e: PickedEntity) => void;
}) {
  const [tab, setTab] = useState<Tab>("doc");
  const [q, setQ] = useState("");

  // 知识库来源
  const { data: kbs } = useKbList();
  const [kbId, setKbId] = useState<string>("");
  const activeKbId = kbId || kbs?.[0]?.id || "";
  const { data: docs } = useKbDocs(activeKbId || undefined, "all", q.trim() || undefined);

  // 数据表来源
  const { data: bases } = useBases();
  const [baseId, setBaseId] = useState<string>("");
  const activeBaseId = baseId || bases?.[0]?.id || "";
  const { data: tables } = useTables(activeBaseId || null);

  const filteredTables = useMemo(() => {
    const all = tables ?? [];
    const kw = q.trim().toLowerCase();
    return kw ? all.filter((t) => t.name.toLowerCase().includes(kw)) : all;
  }, [tables, q]);

  const pick = (e: PickedEntity) => {
    onPick(e);
    setQ("");
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="插入链接到…" width={560}>
      <div className="kb-ep-tabs">
        <button type="button" className={tab === "doc" ? "active" : ""} onClick={() => setTab("doc")}>
          <Icon name="doc" size={14} /> 知识库文档 / 画布
        </button>
        <button type="button" className={tab === "table" ? "active" : ""} onClick={() => setTab("table")}>
          <Icon name="table" size={14} /> 数据表
        </button>
      </div>

      <Input
        autoFocus
        placeholder="搜索名称…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="kb-ep-search"
      />

      {tab === "doc" && (
        <div className="kb-ep-body">
          <select
            className="kb-ep-source"
            value={activeKbId}
            onChange={(e) => setKbId(e.target.value)}
          >
            {(kbs ?? []).map((k) => (
              <option key={k.id} value={k.id}>{k.name}</option>
            ))}
          </select>
          <div className="kb-ep-list">
            {(docs ?? []).length === 0 && <div className="kb-ep-empty">暂无匹配的文档或画布</div>}
            {(docs ?? []).map((d) => (
              <button
                key={d.id}
                type="button"
                className="kb-ep-item"
                onClick={() =>
                  pick({
                    target: d.kind === "canvas"
                      ? { kind: "canvas", kbId: activeKbId, docId: d.id }
                      : { kind: "doc", kbId: activeKbId, docId: d.id },
                    title: d.title || (d.kind === "canvas" ? "未命名画布" : "未命名文档"),
                    group: d.kind === "canvas" ? "画布" : "文档",
                  })
                }
              >
                <span className="kb-ep-ico">
                  <Icon name={d.kind === "canvas" ? "canvas" : "doc"} size={15} />
                </span>
                <span className="kb-ep-name">{d.title || (d.kind === "canvas" ? "未命名画布" : "未命名文档")}</span>
                <span className="kb-ep-tag">{d.kind === "canvas" ? "画布" : "文档"}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === "table" && (
        <div className="kb-ep-body">
          <select
            className="kb-ep-source"
            value={activeBaseId}
            onChange={(e) => setBaseId(e.target.value)}
          >
            {(bases ?? []).map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <div className="kb-ep-list">
            {filteredTables.length === 0 && <div className="kb-ep-empty">暂无匹配的数据表</div>}
            {filteredTables.map((t) => (
              <button
                key={t.id}
                type="button"
                className="kb-ep-item"
                onClick={() =>
                  pick({
                    target: { kind: "table", baseId: activeBaseId, tableId: t.id },
                    title: t.name,
                    group: "数据表",
                  })
                }
              >
                <span className="kb-ep-ico"><Icon name="table" size={15} /></span>
                <span className="kb-ep-name">{t.name}</span>
                <span className="kb-ep-tag">数据表</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

// 供工具栏按钮使用的小图标名（保持 IconName 引用，避免 tree-shake 误判）
export const ENTITY_ICON: IconName = "link";
