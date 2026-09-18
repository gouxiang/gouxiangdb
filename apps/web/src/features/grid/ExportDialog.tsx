// apps/web/src/features/grid/ExportDialog.tsx
// 阶段 4 · 表级导出（UI-SPEC v1.0 R-I-16 / R-I-19）
//
//   R-I-19 导出必须让用户先选：范围（当前视图 / 全部）、格式（CSV / Excel）、是否含附件。
//
// 能力边界（不假装支持后端没有的东西——R-N-17「规划入口保留位置 + 挂『规划中』徽标，
// 点击后不做静默失败」）：
//   - 范围：两项都是真实能力。服务端 export.csv 带 viewId 即按视图筛选/排序导出，
//     不带即导出整表（见 api/client.ts Tables.exportCsvText 注释）。
//   - 格式：现网只有 CSV 端点，**没有 Excel 端点**。提供 Excel 选项等于给一个必然失败的按钮，
//     故保留选项位置并挂「规划中」徽标，点击给明确占位提示（同 R-N-17 口径）。
//   - 含附件：同上，CSV 导出不含附件，选项保留 + 规划中。
//
// 网络调用由调用方注入（onExport），本文件只做「选什么」；执行侧统一走 api/client.ts。

import { useState } from "react";
import { clsx } from "clsx";
import { Button, Modal, toast } from "../../components/ui";
import { PlannedBadge, plannedHint } from "../../components/PlannedBadge";
import { Icon } from "../../components/icons";

export type ExportScope = "view" | "all";

export interface ExportDialogProps {
  open: boolean;
  /** 当前视图 id；没有视图时「当前视图」范围不可选 */
  viewId?: string | null;
  /** 视图名，仅用于文案 */
  viewName?: string;
  /** 执行中（由调用方提供，保证整行只有一个写入口在跑） */
  busy?: boolean;
  /** 执行导出；由调用方注入，网络调用保持在调用方可见（无裸 fetch） */
  onExport: (scope: ExportScope) => Promise<void>;
  onClose: () => void;
}

export function ExportDialog({ open, viewId, viewName, busy, onExport, onClose }: ExportDialogProps) {
  const [scope, setScope] = useState<ExportScope>("view");

  async function run() {
    await onExport(scope);
  }

  return (
    <Modal
      open={open}
      title="导出 CSV"
      width={480}
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button size="sm" variant="primary" icon="download" loading={busy} onClick={() => void run()}>
            导出
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* ---- 范围：真实能力 ---- */}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-gx-12 font-medium text-gx-text-secondary">范围</legend>
          <OptionRow
            checked={scope === "view"}
            onSelect={() => setScope("view")}
            title="当前视图"
            desc={viewName ? `按「${viewName}」的筛选与排序导出` : "按当前视图的筛选与排序导出"}
            disabled={!viewId}
            disabledReason="当前没有选中视图"
          />
          <OptionRow
            checked={scope === "all"}
            onSelect={() => setScope("all")}
            title="全部数据"
            desc="忽略视图筛选，导出整张表"
          />
        </fieldset>

        {/* ---- 格式：CSV 可用，Excel 规划中（后端无端点，不提供假按钮）---- */}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-gx-12 font-medium text-gx-text-secondary">格式</legend>
          <OptionRow checked title="CSV" desc="逗号分隔，Excel /  Numbers 可直接打开" />
          <PlannedOptionRow
            title="Excel（.xlsx）"
            desc="服务端暂未提供 Excel 导出端点"
            onClick={() => toast(plannedHint("Excel 导出"), "info")}
          />
        </fieldset>

        {/* ---- 附件：规划中 ---- */}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-gx-12 font-medium text-gx-text-secondary">附件</legend>
          <PlannedOptionRow
            title="包含附件文件"
            desc="CSV 只导出文本，附件打包下载尚未实现"
            onClick={() => toast(plannedHint("导出含附件"), "info")}
          />
        </fieldset>
      </div>
    </Modal>
  );
}

function OptionRow({
  checked,
  onSelect,
  title,
  desc,
  disabled,
  disabledReason,
}: {
  checked: boolean;
  onSelect?: () => void;
  title: string;
  desc?: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <label
      title={disabled ? disabledReason : undefined}
      className={clsx(
        "flex items-start gap-2 rounded-gx-lg border px-3 py-2 transition-colors duration-[120ms]",
        disabled
          ? "cursor-not-allowed border-gx-border opacity-50"
          : clsx("cursor-pointer", checked ? "border-gx-accent bg-gx-accent-bg" : "border-gx-border hover:bg-gx-row-hover"),
      )}
    >
      <input
        type="radio"
        checked={checked}
        disabled={disabled}
        onChange={() => !disabled && onSelect?.()}
        className="mt-0.5 h-4 w-4 shrink-0 accent-gx-accent"
      />
      <span className="min-w-0">
        <span className="block text-gx-13 text-gx-text-primary">{title}</span>
        {desc && <span className="block text-gx-11 text-gx-text-hint">{desc}</span>}
      </span>
    </label>
  );
}

/** R-N-17：规划入口保留位置 + 挂「规划中」徽标，点击有明确反馈（不静默失败） */
function PlannedOptionRow({
  title,
  desc,
  onClick,
}: {
  title: string;
  desc?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-2 rounded-gx-lg border border-gx-border px-3 py-2 text-left transition-colors duration-[120ms] hover:bg-gx-row-hover"
    >
      <span aria-hidden className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-gx-border-strong" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-gx-13 text-gx-text-secondary">{title}</span>
          <PlannedBadge />
        </span>
        {desc && <span className="block text-gx-11 text-gx-text-hint">{desc}</span>}
      </span>
      <Icon name="chevronRight" size={13} className="mt-0.5 shrink-0 text-gx-text-hint" />
    </button>
  );
}

export default ExportDialog;
