// apps/web/src/features/settings/role-permission/LibraryScopeModal.tsx
// 库权限弹窗：左栏选表，右栏配这张表的数据权限与字段权限。
//
// 两栏的因果纪律：左栏没勾的表，右栏一律禁用——勾了表才谈得上「这张表能增改删」。
// 禁用而不是隐藏，是为了让人看见「有这个设置，只是现在还不能配」。
//
// 知识库没有数据表：左栏只有「文档与画布」一个对象，右栏不做字段权限，
// 增删改查针对的是文档与画布本身（后端同为 KB_CONTENT_KEY 单一 key）。

import { useState } from "react";
import { Button, Checkbox, EmptyState, Modal, SegmentedControl, Spinner } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { useFields, useTables } from "../../../api/hooks";
import type { FieldAccess, LibraryKind, TableAccess } from "@gx/shared-types";
import { KB_CONTENT_KEY } from "@gx/shared-types";
import { FIELD_ACCESS_HINT, FIELD_ACCESS_LABEL, FIELD_ACCESS_ORDER } from "./labels";
import {
  setFieldAccess,
  setTableAction,
  toggleTable,
  type ScopeConfigDraft,
} from "./library-scope-draft";

const ACTIONS: { key: keyof TableAccess; label: string; hint: string }[] = [
  { key: "read", label: "查", hint: "能看这张表里的记录" },
  { key: "create", label: "增", hint: "能往这张表里加记录" },
  { key: "update", label: "改", hint: "能改这张表里已有的记录" },
  { key: "delete", label: "删", hint: "能删这张表里的记录" },
];

export function LibraryScopeModal({
  kind,
  libraryId,
  libraryName,
  config,
  onClose,
  onSave,
}: {
  kind: LibraryKind;
  libraryId: string;
  libraryName: string;
  config: ScopeConfigDraft;
  onClose: () => void;
  onSave: (cfg: ScopeConfigDraft) => void;
}) {
  // 知识库只有「文档与画布」一个对象，进来就当作已勾选（默认只读），
  // 否则右栏一开就是禁用态，用户只会以为坏了。
  const [cfg, setCfg] = useState<ScopeConfigDraft>(() =>
    kind === "kb" && !config.tables[KB_CONTENT_KEY]
      ? toggleTable(config, KB_CONTENT_KEY, true)
      : config,
  );
  const [activeId, setActiveId] = useState<string | null>(null);

  const tablesQ = useTables(kind === "base" ? libraryId : null);
  const tables = tablesQ.data ?? [];

  const rows =
    kind === "kb"
      ? [{ id: KB_CONTENT_KEY, name: "文档与画布" }]
      : tables.map((t) => ({ id: t.id, name: t.name }));

  const current =
    activeId && rows.some((r) => r.id === activeId) ? activeId : (rows[0]?.id ?? null);
  const checked = current ? !!cfg.tables[current] : false;
  const access: TableAccess = (current && cfg.tables[current]) || {
    read: false,
    create: false,
    update: false,
    delete: false,
  };

  const fieldsQ = useFields(kind === "base" && checked && current ? current : null);
  const fields = kind === "base" ? (fieldsQ.data ?? []) : [];

  const body =
    kind === "base" && tablesQ.isLoading ? (
      <div className="flex h-40 items-center justify-center">
        <Spinner size={20} />
      </div>
    ) : rows.length === 0 ? (
      <EmptyState icon="table" title="这个库里还没有数据表" description="先去库里建一张表，再来配权限。" />
    ) : (
      <div className="flex min-h-[260px] gap-3">
        <div className="flex w-40 shrink-0 flex-col gap-1 overflow-y-auto border-r border-gx-separator pr-2">
          <div className="px-1 pb-1 text-gx-11 text-gx-text-hint">
            {kind === "kb" ? "内容类型" : "数据表"}
          </div>
          {rows.map((r) => {
            const on = r.id === current;
            const isChecked = !!cfg.tables[r.id];
            return (
              <div
                key={r.id}
                className={[
                  "flex items-center gap-1 rounded-gx-lg px-1 py-1",
                  on ? "bg-gx-accent-bg" : "hover:bg-gx-row-hover",
                ].join(" ")}
              >
                <Checkbox
                  checked={isChecked}
                  disabled={kind === "kb"}
                  onChange={(v) => setCfg((c) => toggleTable(c, r.id, v))}
                  label={<span className="sr-only">{`勾选 ${r.name}`}</span>}
                />
                <button
                  type="button"
                  onClick={() => setActiveId(r.id)}
                  className={`min-w-0 flex-1 truncate text-left text-gx-12 ${
                    on ? "font-semibold text-gx-accent" : "text-gx-text-primary"
                  }`}
                >
                  {r.name}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {!checked && (
            <div className="flex items-center gap-1.5 rounded-gx-lg bg-gx-bg px-2 py-1.5 text-gx-11 text-gx-text-tertiary">
              <Icon name="lock" size={12} className="shrink-0" />
              先在左栏勾选这张表，才能设置它的权限。
            </div>
          )}

          <div className="flex flex-col gap-1">
            <div className="text-gx-12 font-medium text-gx-text-secondary">数据权限</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {ACTIONS.map((a) => (
                <span key={a.key} title={a.hint}>
                  <Checkbox
                    checked={access[a.key]}
                    disabled={!checked}
                    onChange={(v) => current && setCfg((c) => setTableAction(c, current, a.key, v))}
                    label={<span className="text-gx-13">{a.label}</span>}
                  />
                </span>
              ))}
            </div>
          </div>

          {kind === "kb" ? (
            <p className="text-gx-11 text-gx-text-hint">
              知识库没有数据表，上面这四枚针对的是这个知识库里的文档和画布。字段权限不适用。
            </p>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="text-gx-12 font-medium text-gx-text-secondary">字段权限</div>
              {fieldsQ.isLoading ? (
                <div className="flex h-16 items-center justify-center">
                  <Spinner size={16} />
                </div>
              ) : fields.length === 0 ? (
                <p className="text-gx-11 text-gx-text-hint">这张表还没有字段。</p>
              ) : (
                <div className="max-h-52 overflow-y-auto rounded-gx-lg border border-gx-separator">
                  {fields.map((f) => {
                    const mode: FieldAccess = cfg.fields[current ?? ""]?.[f.id] ?? "editable";
                    return (
                      <div
                        key={f.id}
                        className="flex items-center justify-between gap-2 border-b border-gx-separator px-2 py-1.5 last:border-0"
                      >
                        <span className="min-w-0 flex-1 truncate text-gx-12 text-gx-text-primary">
                          {f.name}
                        </span>
                        {checked ? (
                          <SegmentedControl
                            size="sm"
                            value={mode}
                            onChange={(v) =>
                              current && setCfg((c) => setFieldAccess(c, current, f.id, v))
                            }
                            options={FIELD_ACCESS_ORDER.map((m) => ({
                              value: m,
                              label: <span title={FIELD_ACCESS_HINT[m]}>{FIELD_ACCESS_LABEL[m]}</span>,
                            }))}
                          />
                        ) : (
                          <span className="shrink-0 text-gx-11 text-gx-text-hint">未勾选，不可设置</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );

  return (
    <Modal
      open
      title={`${libraryName} · ${kind === "kb" ? "文档与画布权限" : "数据表权限"}`}
      onClose={onClose}
      width={620}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={() => onSave(cfg)}>
            确定
          </Button>
        </div>
      }
    >
      {body}
    </Modal>
  );
}
