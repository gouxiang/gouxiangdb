// apps/web/src/features/grid/ImportWizard.tsx
// 阶段 4 · 表级导入四步流程（UI-SPEC v1.0 R-I-17 / R-I-18）
//
//   R-I-16 导入是**表级**能力，入口在 L2 表级操作行（阶段 1 已完成），本文件只做流程表现。
//   R-I-17 固定四步：上传 → 字段映射预览 → 确认 → 进度与结果；任一步可返回上一步。
//   R-I-18 结果必须给出成功 / 失败行数与可下载的错误明细；失败行不静默丢弃。
//   R-D-28 长任务用**可关闭**的进度浮层，允许后台继续（关闭弹窗不取消导入）。
//
// 能力边界（不假装支持后端没有的东西）：
//   - 后端 csv-import 的 mapping 语义是 `列名 -> fieldId`，**没有"忽略该列"的取值**
//     （null 会被当成"未指定"并回落到按列名匹配 / 新建字段，见 apps/api/src/routes/records.ts:628）。
//     故映射面板只提供「按列名自动匹配」与「指定已有字段」两种，**不提供假的"忽略"选项**。
//   - 后端一次性处理整批，不回报逐行进度，故进度浮层不伪造「已完成 23/120」，
//     改为显示总行数 + 明确提示「服务端一次处理，完成后自动汇报」。
//
// 全部走 api/client.ts（useGXMutations.csvImport），无裸 fetch、无新增依赖。

import { useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import type { FieldDTO } from "@gx/shared-types";
import { isComputedField, isSystemField } from "@gx/shared-types";
import type { CSVImportResult } from "../../api/client";
import { useGXMutations, useBase, useFields } from "../../api/hooks";
import { Button, Modal, Select, toast } from "../../components/ui";
import { ProgressOverlay } from "../../components/states";
import { StepBar, TruncatedText, useWriteGuard, type StepDef } from "../../components/interaction";
import { Icon } from "../../components/icons";

const STEPS: StepDef[] = [
  { id: "upload", label: "上传", hint: "选择 CSV 文件或粘贴内容" },
  { id: "mapping", label: "字段映射", hint: "确认每列落到哪个字段" },
  { id: "confirm", label: "确认", hint: "核对影响范围" },
  { id: "run", label: "执行与结果", hint: "查看成功 / 失败明细" },
];

/** 与后端 parseCSV 对齐的最小解析：支持双引号包裹、"" 转义、逗号与换行分隔。 */
export function parseCsvPreview(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(cell); cell = ""; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    if (ch === "\r") continue;
    cell += ch;
  }
  row.push(cell);
  rows.push(row);
  // 去掉全空尾行（文件末尾换行产物）
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ""));
}

export interface ImportWizardProps {
  open: boolean;
  tableId: string;
  viewId?: string | null;
  /** 取表结构权限用；向导打开时才挂载数据 hook */
  baseId?: string | null;
  /** 可映射的既有字段；不给时向导自己取（计算字段不能写入，取到后过滤） */
  fields?: FieldDTO[];
  /** 是否有表结构权限（决定无同名列是「新建字段」还是「跳过」） */
  canManageSchema?: boolean;
  onClose: () => void;
  onImported?: () => void;
}

/**
 * 门面：未打开时不挂载任何数据 hook —— L2 表级操作行常驻渲染，
 * 若在这里 useFields/useBase 会拖着整条 L2 发请求（SSR 断言场景更是不该发）。
 */
export function ImportWizard(props: ImportWizardProps) {
  if (!props.open) return null;
  return <ImportWizardBody {...props} />;
}

/** 映射值："" = 按列名自动匹配（不传 mapping），其它 = 指定字段 id */
type Mapping = Record<string, string>;

function ImportWizardBody({
  open,
  tableId,
  viewId,
  baseId,
  fields: fieldsProp,
  canManageSchema: canManageSchemaProp,
  onClose,
  onImported,
}: ImportWizardProps) {
  const m = useGXMutations();
  const guard = useWriteGuard();
  const fileRef = useRef<HTMLInputElement>(null);
  const { data: fieldsData } = useFields(tableId);
  const baseQ = useBase(baseId ?? null);
  // 计算/系统字段不能写入，不给映射（isComputedField / isSystemField 来自 @gx/shared-types）
  const fields = useMemo(
    () => fieldsProp ?? (fieldsData ?? []).filter((f) => !isComputedField(f.type) && !isSystemField(f.type)),
    [fieldsProp, fieldsData],
  );
  const canManageSchema = canManageSchemaProp ?? baseQ.data?.permissions?.canManageSchema ?? true;

  const [step, setStep] = useState(0);
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [result, setResult] = useState<CSVImportResult | null>(null);
  const [running, setRunning] = useState(false);
  /** 弹窗被关闭但任务仍在跑：降级为可关闭的进度浮层（R-D-28 允许后台继续） */
  const [background, setBackground] = useState(false);

  const parsed = useMemo(() => (csvText.trim() ? parseCsvPreview(csvText) : []), [csvText]);
  const header = parsed[0] ?? [];
  const dataRows = parsed.slice(1);
  const sampleRows = dataRows.slice(0, 3);

  function reset() {
    setStep(0);
    setCsvText("");
    setFileName(null);
    setMapping({});
    setResult(null);
    setRunning(false);
    setBackground(false);
  }

  function close() {
    // 执行中关闭 = 收起弹窗但**不取消**导入（R-D-28 允许后台继续）
    if (running) {
      setBackground(true);
      onClose();
      return;
    }
    reset();
    onClose();
  }

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((t) => {
      setCsvText(t);
      setFileName(file.name);
      setMapping({});
      setResult(null);
      setStep(1); // 文件到位直接进映射，少一次无谓点击
    });
  };

  const runImport = async () => {
    if (!csvText.trim()) return;
    setStep(3);
    setRunning(true);
    await guard.run("csv-import", async () => {
      try {
        // mapping 只下发「显式指定了字段」的列；留空的列交给后端按列名自动匹配
        const explicit = Object.fromEntries(Object.entries(mapping).filter(([, v]) => v !== ""));
        const res = await m.csvImport.mutateAsync({
          tableId,
          csv: csvText,
          hasHeader: true,
          mapping: Object.keys(explicit).length > 0 ? explicit : undefined,
          viewId: viewId ?? undefined,
        });
        setResult(res);
        // R-I-18：失败行必须报出来，不能用「部分成功」一句话盖过去
        if (res.errors.length === 0) {
          toast(`导入成功：新增 ${res.createdRecords} 条`, "success");
        } else {
          toast(`导入完成：新增 ${res.createdRecords} 条，${res.errors.length} 行/列有问题`, "error");
        }
        onImported?.();
      } catch (e) {
        setResult(null);
        toast((e as Error)?.message ?? "导入失败", "error");
      } finally {
        setRunning(false);
        setBackground(false);
      }
    });
  };

  /** R-I-18 可下载的错误明细（纯前端生成文本，不新增依赖） */
  const downloadErrors = () => {
    if (!result?.errors.length) return;
    const body = result.errors.map((e, i) => `${i + 1}. ${e}`).join("\n");
    const blob = new Blob([`导入错误明细（共 ${result.errors.length} 条）\n\n${body}\n`], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `import-errors-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const canNext = step === 0 ? csvText.trim().length > 0 : true;

  return (
    <>
      <Modal
        open={open && !background}
        title="导入 CSV"
        width={640}
        onClose={close}
        footer={
          <div className="flex w-full items-center gap-2">
            {step > 0 && step < 3 && (
              <Button size="sm" variant="ghost" onClick={() => setStep(step - 1)} disabled={running}>
                上一步
              </Button>
            )}
            <span className="flex-1" />
            {step === 0 && (
              <Button size="sm" variant="primary" disabled={!canNext} onClick={() => setStep(1)}>
                下一步
              </Button>
            )}
            {step === 1 && (
              <Button size="sm" variant="primary" disabled={header.length === 0} onClick={() => setStep(2)}>
                下一步
              </Button>
            )}
            {step === 2 && (
              <Button size="sm" variant="primary" loading={running} onClick={() => void runImport()}>
                开始导入
              </Button>
            )}
            {step === 3 && (
              <Button size="sm" variant="secondary" onClick={close} disabled={running}>
                {running ? "导入中…" : "完成"}
              </Button>
            )}
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {/* R-I-22 同款步骤条：当前 accent / 已完成打勾 / 未开始 hint */}
          <StepBar steps={STEPS} current={step} />

          {/* ---------- 步骤 1：上传 ---------- */}
          {step === 0 && (
            <div className="flex flex-col gap-3">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  pickFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" icon="upload" onClick={() => fileRef.current?.click()}>
                  选择 CSV 文件
                </Button>
                {fileName && (
                  <span className="flex min-w-0 items-center gap-1 text-gx-12 text-gx-text-tertiary">
                    <Icon name="file" size={13} />
                    <TruncatedText text={fileName} />
                  </span>
                )}
              </div>
              <div className="text-gx-12 text-gx-text-hint">或直接粘贴 CSV 内容（首行为表头）：</div>
              <textarea
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                rows={7}
                placeholder={"姓名,部门,入职日期\n张三,产品部,2026-01-04"}
                className="w-full rounded-gx-lg border border-gx-border bg-gx-surface px-2.5 py-1.5 text-gx-12 text-gx-text-primary placeholder:text-gx-text-hint focus:border-gx-accent focus:outline-none"
              />
              {parsed.length > 1 && (
                <div className="text-gx-12 text-gx-text-secondary">
                  解析到 {header.length} 列 / {dataRows.length} 行数据
                </div>
              )}
            </div>
          )}

          {/* ---------- 步骤 2：字段映射预览 ---------- */}
          {step === 1 && (
            <div className="flex flex-col gap-2">
              <div className="text-gx-12 text-gx-text-hint">
                留空 = 按列名自动匹配（同名则写入，无同名且你有表结构权限则新建字段）。
              </div>
              <div className="overflow-hidden rounded-gx-lg border border-gx-border">
                <div className="flex items-center gap-2 border-b border-gx-separator bg-gx-table-header px-2 py-1.5 text-gx-11 text-gx-text-tertiary">
                  <span className="w-8 shrink-0">列</span>
                  <span className="min-w-0 flex-1">CSV 列名</span>
                  <span className="w-48 shrink-0">映射到字段</span>
                </div>
                {header.map((col, i) => {
                  const auto = fields.find((f) => f.name === col.trim());
                  return (
                    <div key={`${col}-${i}`} className="flex items-center gap-2 border-b border-gx-separator px-2 py-1.5 last:border-0">
                      <span className="w-8 shrink-0 text-gx-11 text-gx-text-hint">{i + 1}</span>
                      <TruncatedText text={col || `列 ${i + 1}`} className="min-w-0 flex-1 text-gx-12 text-gx-text-primary" />
                      <Select
                        value={mapping[col] ?? ""}
                        onChange={(e) => setMapping((prev) => ({ ...prev, [col]: e.target.value }))}
                        className="h-7 w-48 shrink-0 text-gx-12"
                      >
                        <option value="">自动匹配{auto ? `（${auto.name}）` : canManageSchema ? "（将新建字段）" : ""}</option>
                        {fields.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                  );
                })}
              </div>
              {sampleRows.length > 0 && (
                <div className="mt-1">
                  <div className="mb-1 text-gx-12 text-gx-text-hint">数据预览（前 3 行）</div>
                  <div className="overflow-x-auto rounded-gx-lg border border-gx-border">
                    <table className="w-full text-gx-11">
                      <tbody>
                        {sampleRows.map((r, ri) => (
                          <tr key={ri} className={clsx(ri !== 0 && "border-t border-gx-separator")}>
                            {header.map((_, ci) => (
                              <td key={ci} className="max-w-[160px] truncate px-2 py-1 text-gx-text-secondary" title={r[ci] ?? ""}>
                                {r[ci] ?? ""}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ---------- 步骤 3：确认 ---------- */}
          {step === 2 && (
            <div className="flex flex-col gap-2 text-gx-13 text-gx-text-secondary">
              <SummaryRow label="数据行数" value={`${dataRows.length} 行`} />
              <SummaryRow label="列数" value={`${header.length} 列`} />
              <SummaryRow
                label="已显式指定映射"
                value={`${Object.values(mapping).filter((v) => v !== "").length} 列`}
              />
              <SummaryRow
                label="其余列"
                value={canManageSchema ? "按列名自动匹配，无同名则新建字段" : "按列名自动匹配（无同名将被跳过）"}
              />
              {!canManageSchema && (
                <div className="mt-1 flex items-start gap-1.5 rounded-gx-lg bg-gx-warning-bg px-2 py-1.5 text-gx-12 text-gx-text-secondary">
                  <Icon name="alertCircle" size={13} className="mt-0.5 shrink-0 text-gx-warning" />
                  当前角色无权新建字段：CSV 中存在而表里没有的列不会被导入。
                </div>
              )}
            </div>
          )}

          {/* ---------- 步骤 4：执行与结果 ---------- */}
          {step === 3 && (
            <div className="flex flex-col gap-3">
              {running && (
                <div className="flex items-center gap-2 text-gx-13 text-gx-text-secondary">
                  <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-gx-border border-t-gx-accent" />
                  正在导入 {dataRows.length} 行…
                </div>
              )}
              {!running && result && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-4">
                    <ResultStat label="新增记录" value={result.createdRecords} tone="success" />
                    <ResultStat label="新建字段" value={result.createdFields} />
                    <ResultStat label="问题行/列" value={result.errors.length} tone={result.errors.length ? "danger" : "muted"} />
                  </div>
                  {result.errors.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-gx-12 text-gx-text-secondary">错误明细（失败行不静默丢弃）</span>
                        {/* R-I-18：可下载的错误明细 */}
                        <Button size="sm" variant="secondary" icon="download" onClick={downloadErrors}>
                          下载明细
                        </Button>
                      </div>
                      <div className="max-h-40 overflow-y-auto rounded-gx-lg border border-gx-border bg-gx-bg p-2">
                        {result.errors.slice(0, 50).map((e, i) => (
                          <div key={i} className="py-0.5 text-gx-11 text-gx-danger">
                            {i + 1}. {e}
                          </div>
                        ))}
                        {result.errors.length > 50 && (
                          <div className="pt-1 text-gx-11 text-gx-text-hint">
                            …另有 {result.errors.length - 50} 条，下载明细查看全部
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {!running && !result && (
                <div className="text-gx-13 text-gx-text-secondary">导入失败或未执行，可返回上一步重试。</div>
              )}
            </div>
          )}
        </div>
      </Modal>

      {/* R-D-28：弹窗关闭后任务继续跑，用可关闭的进度浮层兜住反馈 */}
      <ProgressOverlay
        open={background && running}
        title="导入 CSV"
        done={running ? 0 : dataRows.length}
        total={dataRows.length}
        hint="服务端一次性处理整批，完成后自动汇报结果。"
        onClose={() => setBackground(false)}
      />
    </>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-gx-hairline pb-1.5">
      <span className="shrink-0 text-gx-text-tertiary">{label}</span>
      <span className="min-w-0 text-right text-gx-text-primary">{value}</span>
    </div>
  );
}

function ResultStat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "success" | "danger" | "muted";
}) {
  const color =
    tone === "success"
      ? "text-gx-success"
      : tone === "danger"
        ? "text-gx-danger"
        : tone === "muted"
          ? "text-gx-text-hint"
          : "text-gx-text-primary";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-gx-11 text-gx-text-hint">{label}</span>
      <span className={clsx("text-gx-18 font-semibold tabular-nums", color)}>{value}</span>
    </div>
  );
}

export default ImportWizard;
