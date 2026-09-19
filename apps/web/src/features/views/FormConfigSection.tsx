// apps/web/src/features/views/FormConfigSection.tsx
// 表单视图的表单配置区：字段显隐 + 顺序（上移/下移）+ 必填 + 表单标题/描述
//
// 为什么单独成文件：ViewSettingsPanel 已 130+ 行，再加这 ~150 行会逼近单文件 300 行公约，
// 且这段是纯「表单视图专属」逻辑，与其它视图设置互不干扰，天然可独立。
//
// 写入：PATCH /api/views/:viewId 的 config 三键（后端浅合并，见 form-config.ts 注释）。
// formFields=[] 时表单视图回退为「按全部字段自动生成」，故提供「恢复自动生成」。

import { useEffect, useMemo, useState } from "react";
import type { FormFieldConfig, ViewDTO } from "@gx/shared-types";
import { Button, Checkbox, FieldIcon, Input, Textarea, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { useFields, useGXMutations } from "../../api/hooks";
import { autoFormFields, moveFormField, reconcileFormFields } from "./form-config";

export interface FormConfigSectionProps {
  view: ViewDTO;
  tableId: string;
  /** 无表结构管理权限时只读（后端也会 403，这里提前置灰避免白点） */
  canEdit: boolean;
}

export default function FormConfigSection({ view, tableId, canEdit }: FormConfigSectionProps) {
  const { data: fieldsRes } = useFields(tableId);
  const m = useGXMutations();
  const fields = useMemo(() => fieldsRes ?? [], [fieldsRes]);

  // 已配置则用配置（与当前字段对齐）；未配置则用自动生成结果做初始草稿，
  // 用户一动就落库成显式配置，表单视图随即改用配置渲染。
  const seeded = useMemo<FormFieldConfig[]>(() => {
    const cfg = view.config.formFields ?? [];
    return cfg.length > 0 ? reconcileFormFields(cfg, fields) : autoFormFields(fields);
  }, [view.config.formFields, fields]);

  const [draft, setDraft] = useState<FormFieldConfig[]>(seeded);
  const [title, setTitle] = useState(view.config.formTitle ?? "");
  const [desc, setDesc] = useState(view.config.formDescription ?? "");

  // 字段列表异步到位 / 切换视图后回填草稿（用户未手动改动时跟随最新）
  useEffect(() => setDraft(seeded), [seeded]);
  useEffect(() => setTitle(view.config.formTitle ?? ""), [view.config.formTitle]);
  useEffect(() => setDesc(view.config.formDescription ?? ""), [view.config.formDescription]);

  const [saving, setSaving] = useState(false);

  const commit = async (next: {
    formFields?: FormFieldConfig[];
    formTitle?: string;
    formDescription?: string;
  }) => {
    if (!canEdit) return;
    setSaving(true);
    try {
      // 只提交变化的三键：后端是 config 浅合并，不会冲掉筛选/隐藏字段等其它配置
      await m.updateView.mutateAsync({ viewId: view.id, tableId, data: { config: next } });
    } catch (err) {
      toast((err as Error).message || "保存表单配置失败", "error");
    } finally {
      setSaving(false);
    }
  };

  const commitFields = (next: FormFieldConfig[]) => {
    setDraft(next);
    void commit({ formFields: next });
  };

  const resetToAuto = () => {
    void commit({ formFields: [], formTitle: "", formDescription: "" });
    setTitle("");
    setDesc("");
  };

  return (
    <div className="flex flex-col gap-2 border-t border-gx-separator pt-3">
      <div className="flex items-center justify-between">
        <span className="text-gx-12 font-medium text-gx-text-secondary">表单内容</span>
        {saving && <span className="text-gx-11 text-gx-text-hint">保存中…</span>}
      </div>

      <label className="text-gx-11 text-gx-text-hint">表单标题（留空则用表名）</label>
      <Input
        value={title}
        disabled={!canEdit}
        placeholder={view.name}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => void commit({ formTitle: title })}
      />

      <label className="text-gx-11 text-gx-text-hint">表单描述</label>
      <Textarea
        value={desc}
        disabled={!canEdit}
        placeholder="一句话说明这份表单怎么填"
        rows={2}
        onChange={(e) => setDesc(e.target.value)}
        onBlur={() => void commit({ formDescription: desc })}
      />

      <div className="text-gx-11 text-gx-text-hint">出现在这份表单里的字段（按顺序）</div>
      {draft.length === 0 ? (
        <div className="rounded-gx-sm bg-gx-bg px-2 py-3 text-center text-gx-11 text-gx-text-hint">
          该表暂无可用字段
        </div>
      ) : (
        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {draft.map((ff, i) => {
            const f = fields.find((x) => x.id === ff.fieldId);
            return (
              <div
                key={ff.fieldId}
                className="flex items-center gap-1 rounded-gx-sm border border-gx-border px-1.5 py-1"
              >
                <Checkbox
                  checked={!ff.hidden}
                  disabled={!canEdit}
                  onChange={(v) =>
                    commitFields(draft.map((it, j) => (j === i ? { ...it, hidden: !v } : it)))
                  }
                />
                <FieldIcon type={f?.type ?? "text"} size={12} />
                <span className="min-w-0 flex-1 truncate text-gx-12 text-gx-text-primary">
                  {ff.label || f?.name || ff.fieldId}
                </span>
                <button
                  type="button"
                  title={ff.required ? "取消必填" : "设为必填"}
                  disabled={!canEdit}
                  onClick={() =>
                    commitFields(draft.map((it, j) => (j === i ? { ...it, required: !it.required } : it)))
                  }
                  className={ff.required ? "text-gx-danger" : "text-gx-text-hint"}
                >
                  <span className="text-gx-11">必填</span>
                </button>
                <button
                  type="button"
                  title="上移"
                  disabled={!canEdit || i === 0}
                  onClick={() => commitFields(moveFormField(draft, i, -1))}
                  className="rounded p-0.5 text-gx-text-hint hover:bg-gx-bg hover:text-gx-accent disabled:opacity-40"
                >
                  <Icon name="arrowUp" size={12} />
                </button>
                <button
                  type="button"
                  title="下移"
                  disabled={!canEdit || i === draft.length - 1}
                  onClick={() => commitFields(moveFormField(draft, i, 1))}
                  className="rounded p-0.5 text-gx-text-hint hover:bg-gx-bg hover:text-gx-accent disabled:opacity-40"
                >
                  <Icon name="arrowDown" size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <Button
        variant="secondary"
        size="sm"
        disabled={!canEdit}
        onClick={resetToAuto}
        title="清空显式配置，回到「按全部字段自动生成」"
      >
        恢复自动生成
      </Button>
      {!canEdit && <div className="text-gx-11 text-gx-text-hint">无表结构管理权限，配置只读</div>}
    </div>
  );
}
