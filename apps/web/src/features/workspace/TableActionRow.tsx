// 阶段 1 壳层：L2 表级操作行（R-I-16）—— 导入 ｜ 导出 ｜ 分享数据。
//
// R-I-16：导入 / 导出是表级能力，放在 L2 表级操作行，**不放顶栏、不放表格工具栏**。
// 参考设计（附录 B / A.3）：行高 40、padding 8/8/0/10、格高 28、竖分隔 1×16（gx-divider-v）、
// 分享格用 accent 色文字。
//
// 迁移口径（本次只迁入口，不重做流程）：
//   导出 → 与旧顶栏同一条服务端端点 Tables.exportUrl（按视图导出，不受前端已加载行数限制）；
//   导入 → 与 GridView 同一个 useGXMutations().csvImport（同一接口 + 同一套失效逻辑）；
//   分享 → R-I-20 判定为「数据级（单条记录）分享」，现网无记录级分享接口，按 R-N-17
//          挂「规划中」占位，点击 toast 明说，不放死入口也不假装可用。
// 全部经 api/client.ts，无裸 fetch、无新增依赖。
//
// 两层结构：外层只做「有没有表」的判断，内层才拿 hooks。这样库首页 / 知识库 / 工作区路由下
// 不挂载任何数据 hook（SSR 断言与无 Provider 场景都不受影响），L2 也不会留下空操作条。
import { useRef, useState } from "react";
import { Tables } from "../../api/client";
import { useGXMutations } from "../../api/hooks";
import { Icon } from "../../components/icons";
import { Menu, MenuItem, Popover, toast } from "../../components/ui";
import { PlannedBadge, plannedHint } from "../../components/PlannedBadge";

export interface TableActionRowProps {
  tableId: string | null;
  /** 当前视图（导出按视图范围）；无视图时导出整表，与旧顶栏口径一致。 */
  viewId?: string | null;
  /** 显式隐藏（调用方已知当前不是表上下文）。 */
  hidden?: boolean;
}

export function TableActionRow({ tableId, viewId, hidden }: TableActionRowProps) {
  if (hidden || !tableId) return null;
  return <TableActionRowInner tableId={tableId} viewId={viewId ?? null} />;
}

function TableActionRowInner({ tableId, viewId }: { tableId: string; viewId: string | null }) {
  const m = useGXMutations();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [open, setOpen] = useState(false);

  const runImport = async (csv: string) => {
    if (!csv.trim()) {
      toast("请先选择 CSV 文件或粘贴 CSV 内容", "error");
      return;
    }
    try {
      const res = await m.csvImport.mutateAsync({ tableId, csv, hasHeader: true, viewId: viewId ?? undefined });
      setCsvText("");
      setPasteOpen(false);
      toast(`导入成功：新增 ${res.createdRecords} 条`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "导入失败", "error");
    }
  };

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

  const runExport = async () => {
    try {
      // 走 client.ts 的带凭据通道：服务端只认 Authorization / X-GX-Token 头，
      // 直接 window.open(exportUrl) 不带任何凭据会得到 401（旧顶栏正是这么写的，属死链）。
      const csv = await Tables.exportCsvText(tableId, viewId ?? undefined);
      downloadCsv(csv, `table-${tableId}.csv`);
      toast("已导出 CSV", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "导出失败", "error");
    }
  };

  return (
    <div
      className="relative flex h-10 shrink-0 items-center gap-gx-xs pl-2.5 pr-2 pt-2"
      data-testid="l2-table-actions"
    >
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void f.text().then(runImport);
          e.target.value = "";
        }}
      />
      <Cell icon="upload" label="导入" onClick={() => setOpen((v) => !v)} chevron />
      <Divider />
      <Cell icon="download" label="导出" onClick={() => void runExport()} />
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

      <div className="relative">
        {open && (
          <Popover open onClose={() => setOpen(false)} align="left" width={180}>
            <Menu width={180}>
              <MenuItem
                icon="upload"
                label="从文件导入"
                onClick={() => {
                  setOpen(false);
                  fileRef.current?.click();
                }}
              />
              <MenuItem
                icon="edit"
                label="粘贴 CSV 导入"
                onClick={() => {
                  setOpen(false);
                  setPasteOpen(true);
                }}
              />
            </Menu>
          </Popover>
        )}
      </div>

      {pasteOpen && (
        <div className="absolute left-2 right-2 top-10 z-gx-z-popover rounded-gx-2xl border border-gx-border bg-gx-surface p-3 shadow-gx-lg">
          <div className="mb-2 text-gx-13 font-medium text-gx-text-primary">粘贴 CSV 内容</div>
          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder="首行为表头，后续为数据行"
            rows={5}
            className="w-full rounded-gx-lg border border-gx-border bg-gx-surface px-2 py-1.5 text-gx-12 text-gx-text-primary focus:border-gx-accent focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setPasteOpen(false)}
              className="text-gx-12 text-gx-text-tertiary hover:text-gx-text-primary"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void runImport(csvText)}
              className="rounded-gx-lg bg-gx-accent px-3 py-1.5 text-gx-12 font-medium text-white hover:brightness-95"
            >
              导入
            </button>
          </div>
        </div>
      )}
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
