// M4 table 策略行的字段三态编辑器：可见/只读/可编辑 → FieldMask。
// 从既有 /api/fields 拉字段清单（不新增请求层）；缺省 mask = 全量可编辑。
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Fields } from "../../api/client";
import type { FieldMaskDTO } from "@gx/shared-types";
import { Button, Modal, Spinner } from "../../components/ui";
import { buildFieldMask, fieldStateForField, type FieldState } from "./lib/policy-model";

const STATES: { value: FieldState; label: string }[] = [
  { value: "editable", label: "可编辑" },
  { value: "readonly", label: "只读" },
  { value: "hidden", label: "隐藏" },
];

export function FieldMaskEditor({
  open,
  tableId,
  subjectName,
  initial,
  onClose,
  onSave,
}: {
  open: boolean;
  /** table 节点 resourceId（= tables.id）。 */
  tableId: string;
  subjectName: string;
  initial: FieldMaskDTO | null;
  onClose: () => void;
  onSave: (mask: FieldMaskDTO | null) => void;
}) {
  const fieldsQ = useQuery({
    queryKey: ["authz-fields", tableId],
    queryFn: () => Fields.list(tableId),
    enabled: open && !!tableId,
    staleTime: 60_000,
  });
  const fieldsData = useMemo(() => fieldsQ.data?.fields ?? [], [fieldsQ.data]);
  const fieldIds = useMemo(() => fieldsData.map((f) => f.id), [fieldsData]);
  const [stateOf, setStateOf] = useState<Record<string, FieldState>>({});

  // 每次打开按 initial mask 重置本地态（open 变化时父级重新挂载 key，保证刷新）。
  const stateFor = (id: string): FieldState => stateOf[id] ?? fieldStateForField(initial, id);
  const setFor = (id: string, s: FieldState) =>
    setStateOf((prev) => ({ ...prev, [id]: s }));

  const resetToAll = () => setStateOf({});

  return (
    <Modal
      open={open}
      title={`字段权限 · ${subjectName}`}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={resetToAll}>
            全部可编辑
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={fieldsQ.isLoading}
            onClick={() => {
              const ids = fieldIds.length ? fieldIds : Object.keys(stateOf);
              onSave(buildFieldMask(ids, (id) => stateFor(id)));
            }}
          >
            应用
          </Button>
        </>
      }
    >
      <p className="mb-2 text-gx-12 text-gx-text-hint">
        仅对该主体在本表生效：隐藏的字段不出现在返回中，只读字段可见但不可写；不设置=全量可编辑。
      </p>
      {fieldsQ.isLoading ? (
        <div className="flex h-24 items-center justify-center">
          <Spinner size={18} />
        </div>
      ) : fieldsData.length === 0 ? (
        <div className="py-8 text-center text-gx-12 text-gx-text-hint">该表暂无字段</div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="grid grid-cols-[1fr_auto] items-center gap-2 px-1 text-gx-11 text-gx-text-hint">
            <span>字段</span>
            <span className="flex gap-1">
              {STATES.map((s) => (
                <span key={s.value} className="w-14 text-center">
                  {s.label}
                </span>
              ))}
            </span>
          </div>
          {fieldsData.map((f) => {
            const cur = stateFor(f.id);
            return (
              <div key={f.id} className="grid grid-cols-[1fr_auto] items-center gap-2 rounded-gx-sm px-1 py-1 hover:bg-gx-row-hover">
                <span className="min-w-0 truncate text-gx-13 text-gx-text-primary">{f.name}</span>
                <span className="flex gap-1">
                  {STATES.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      onClick={() => setFor(f.id, s.value)}
                      aria-pressed={cur === s.value}
                      className={[
                        "w-14 rounded-gx-sm border px-1 py-0.5 text-gx-12 transition-colors",
                        cur === s.value
                          ? "border-gx-accent bg-gx-accent-bg font-medium text-gx-accent"
                          : "border-gx-separator text-gx-text-secondary hover:bg-gx-row-hover",
                      ].join(" ")}
                    >
                      {s.label}
                    </button>
                  ))}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
