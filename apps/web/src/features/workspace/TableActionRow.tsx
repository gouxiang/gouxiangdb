// 阶段 1 壳层：L2 表级操作行（R-I-16）—— 导入 ｜ 导出 ｜ 分享数据。
//
// R-I-16：导入 / 导出是表级能力，放在 L2 表级操作行，**不放顶栏、不放表格工具栏**。
// 参考设计（附录 B / A.3）：行高 40、padding 8/8/0/10、格高 28、竖分隔 1×16（gx-divider-v）、
// 分享格用 accent 色文字。
//
//   导出 → 与旧顶栏同一条服务端端点 Tables.exportCsvText（按视图导出，不受前端已加载行数限制）；
//   导入 → 与 GridView 同一个 useGXMutations().csvImport（同一接口 + 同一套失效逻辑）；
//   分享 → R-I-20 判定为「数据级（单条记录）分享」，现网无记录级分享接口，按 R-N-17
//          挂「规划中」占位，点击 toast 明说，不放死入口也不假装可用。
// 全部经 api/client.ts，无裸 fetch、无新增依赖。
//
// 两层结构：外层只做「有没有表」的判断，内层才拿 hooks。这样库首页 / 知识库 / 工作区路由下
// 不挂载任何数据 hook（SSR 断言与无 Provider 场景都不受影响），L2 也不会留下空操作条。
// 阶段 4 追加：导入不再「选完文件就跑」，改走 R-I-17 四步向导（上传 → 映射 → 确认 → 结果）；
// 导出改走 R-I-19 的「先选范围/格式/附件」弹窗。两者都是表级能力，入口位置不变（仍在 L2）。
import { useState } from "react";
import { Tables } from "../../api/client";
import { Icon } from "../../components/icons";
import { toast } from "../../components/ui";
import { PlannedBadge, plannedHint } from "../../components/PlannedBadge";
import { useWriteGuard } from "../../components/interaction";
import { ImportWizard } from "../grid/ImportWizard";
import { ExportDialog, type ExportScope } from "../grid/ExportDialog";

export interface TableActionRowProps {
  tableId: string | null;
  /** 当前视图（导出按视图范围）；无视图时导出整表，与旧顶栏口径一致。 */
  viewId?: string | null;
  /** 当前视图名，仅用于导出弹窗文案。 */
  viewName?: string;
  /** 取权限用；不给时退回「按表结构可写」的保守判定。 */
  baseId?: string | null;
  /** 显式隐藏（调用方已知当前不是表上下文）。 */
  hidden?: boolean;
}

export function TableActionRow({ tableId, viewId, viewName, baseId, hidden }: TableActionRowProps) {
  if (hidden || !tableId) return null;
  return (
    <TableActionRowInner
      tableId={tableId}
      viewId={viewId ?? null}
      viewName={viewName}
      baseId={baseId ?? null}
    />
  );
}

function TableActionRowInner({
  tableId,
  viewId,
  viewName,
  baseId,
}: {
  tableId: string;
  viewId: string | null;
  viewName?: string;
  baseId: string | null;
}) {
  const guard = useWriteGuard();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  /** 下载 CSV 文本为文件（与 GridView 客户端导出同一套落盘方式，无新增依赖）。 */
  const downloadCsv = (csv: string, filename: string) => {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** R-I-19 的执行侧：范围由弹窗给（view = 按视图，all = 整表）。 */
  const runExport = async (scope: ExportScope) => {
    await guard.run("export", async () => {
      try {
        // 走 client.ts 的带凭据通道：服务端只认 Authorization / X-GX-Token 头，
        // 直接 window.open(exportUrl) 不带任何凭据会得到 401（旧顶栏正是这么写的，属死链）。
        const csv = await Tables.exportCsvText(tableId, scope === "view" ? (viewId ?? undefined) : undefined);
        downloadCsv(csv, `table-${tableId}${scope === "view" && viewId ? `-${viewId}` : ""}.csv`);
        toast(scope === "view" ? "已导出当前视图" : "已导出整表", "success");
        setExportOpen(false);
      } catch (e) {
        toast(e instanceof Error ? e.message : "导出失败", "error");
      }
    });
  };

  return (
    <div
      className="relative flex h-10 shrink-0 items-center gap-gx-xs pl-2.5 pr-2 pt-2"
      data-testid="l2-table-actions"
    >
      {/* R-I-17：导入走四步向导（上传 → 映射 → 确认 → 结果），文件与粘贴两种入口都收在向导第 1 步 */}
      <Cell icon="upload" label="导入" onClick={() => setWizardOpen(true)} />
      <Divider />
      {/* R-I-19：导出先让用户选范围 / 格式 / 附件，不再「点了就直接下载整表」 */}
      <Cell icon="download" label="导出" onClick={() => setExportOpen(true)} />
      <Divider />
      <button
        type="button"
        onClick={() => toast(plannedHint("分享数据"), "info")}
        title="分享数据 · 规划中"
        className="flex h-7 items-center gap-1 rounded-gx-lg px-2 text-gx-12 text-gx-accent transition-colors hover:bg-gx-row-hover"
      >
        <Icon name="share" size={13} />
        <span>分享数据</span>
        <PlannedBadge />
      </button>

      <ImportWizard
        open={wizardOpen}
        tableId={tableId}
        viewId={viewId}
        baseId={baseId}
        onClose={() => setWizardOpen(false)}
      />
      <ExportDialog
        open={exportOpen}
        viewId={viewId}
        viewName={viewName}
        busy={guard.isBusy("export")}
        onExport={runExport}
        onClose={() => setExportOpen(false)}
      />
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="h-4 w-px shrink-0 bg-gx-divider-v" />;
}

function Cell({
  icon,
  label,
  onClick,
  chevron,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  onClick: () => void;
  chevron?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="flex h-7 items-center gap-1 rounded-gx-lg px-2 text-gx-12 text-gx-text-secondary transition-colors hover:bg-gx-row-hover"
    >
      <Icon name={icon} size={13} />
      <span>{label}</span>
      {chevron && <Icon name="chevronDown" size={11} className="text-gx-text-hint" />}
    </button>
  );
}
