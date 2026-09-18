// apps/web/src/features/shell/TopBar.tsx
// 顶栏：面包屑 + 视图标签 + 右侧工具区
// 高度 48px，底部 border-gx-separator，背景 bg-gx-surface

import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Tables } from "../../api/client";
import { useBase, useGXMutations } from "../../api/hooks";
import { IconButton, Input, Menu, MenuItem, Modal, Popover, toast } from "../../components/ui";
import { Icon, VIEW_ICON } from "../../components/icons";
import { VIEW_TYPES, VIEW_TYPE_LABEL, type ViewType } from "@gx/shared-types";
import { ViewTabs } from "./ViewTabs";

export function TopBar() {
  const navigate = useNavigate();
  const { baseId, tableId, viewId } = useParams();

  const baseQ = useBase(baseId ?? null);
  const perms = baseQ.data?.permissions;
  const canManageSchema = perms?.canManageSchema ?? false;
  const canManageBase = perms?.canManageBase ?? false;

  const m = useGXMutations();

  const [more, setMore] = useState(false);
  const [showNewView, setShowNewView] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<ViewType>("grid");
  const fileRef = useRef<HTMLInputElement>(null);

  async function createView() {
    if (!newName.trim() || !tableId) return;
    try {
      const v = await m.createView.mutateAsync({ tableId, name: newName.trim(), type: newType });
      setNewName("");
      setShowNewView(false);
      navigate(`/base/${baseId}/table/${tableId}/view/${v.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "新建视图失败", "error");
    }
  }

  async function duplicateView() {
    if (!viewId || !tableId) return;
    setMore(false);
    try {
      const v = await m.duplicateView.mutateAsync({ viewId, tableId });
      navigate(`/base/${baseId}/table/${tableId}/view/${v.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "复制视图失败", "error");
    }
  }

  // 带凭据导出：服务端只认 Authorization / X-GX-Token 请求头，window.open(exportUrl)
  // 发起的是无自定义头的浏览器导航 → 401。故改为经 client.ts 取回文本后本地落盘。
  async function exportCsv() {
    setMore(false);
    if (!tableId) return;
    try {
      const csv = await Tables.exportCsvText(tableId, viewId);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `table-${tableId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(e instanceof Error ? e.message : "导出失败", "error");
    }
  }

  async function importCsv() {
    if (!tableId || !importText.trim()) return;
    try {
      await m.csvImport.mutateAsync({ tableId, csv: importText, hasHeader: true });
      setImportText("");
      setShowImport(false);
      toast("CSV 导入完成", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "导入失败", "error");
    }
  }

  async function clearTable() {
    setMore(false);
    if (!tableId) return;
    try {
      await m.clearTable.mutateAsync({ tableId, viewId });
      toast("已清空数据", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "清空失败", "error");
    }
  }

  async function deleteTable() {
    setMore(false);
    if (!tableId) return;
    try {
      await m.deleteTable.mutateAsync({ tableId, baseId: baseId ?? "" });
      navigate(`/base/${baseId}`);
      toast("已删除数据表", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "删除失败", "error");
    }
  }

  return (
    <div className="flex h-12 items-center gap-2 border-b border-gx-separator bg-gx-surface px-3">
      {/* R-N-19：主壳内不渲染面包屑——L1 + L2 的选中态已表达位置，再加面包屑是冗余。
          原「库名 › 表名」链整段移除；库/表的可达性由侧栏与视图标签条承担。 */}
      {/* 视图标签 */}
      <ViewTabs />

      {/* 右侧工具区 */}
      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          icon="plus"
          label="新建视图"
          disabled={!canManageSchema}
          onClick={() => setShowNewView(true)}
        />
        <IconButton icon="settings" label="视图设置" onClick={() => setShowSettings(true)} />
        <IconButton
          icon="expand"
          label="扩展记录"
          onClick={() => toast("敬请期待", "info")}
        />
        <IconButton
          icon="share"
          label="分享"
          disabled={!canManageBase}
          onClick={() => navigate(`/base/${baseId}/settings#share`)}
        />
        <div className="relative">
          <IconButton icon="more" label="更多" onClick={() => setMore((v) => !v)} />
          <Popover open={more} onClose={() => setMore(false)} align="right" width={180}>
            <Menu width={180}>
              <MenuItem icon="copy" label="复制视图" disabled={!canManageSchema} onClick={duplicateView} />
              <MenuItem icon="download" label="导出 CSV" onClick={exportCsv} />
              <MenuItem icon="upload" label="导入 CSV" onClick={() => { setMore(false); setShowImport(true); }} />
              <MenuItem icon="trash" label="清空表" danger disabled={!canManageSchema} onClick={clearTable} />
              <MenuItem icon="trash" label="删除表" danger disabled={!canManageSchema} onClick={deleteTable} />
            </Menu>
          </Popover>
        </div>
      </div>

      {/* 新建视图 Modal */}
      <Modal
        open={showNewView}
        title="新建视图"
        onClose={() => setShowNewView(false)}
        footer={
          <>
            <button className="text-gx-13 text-gx-text-tertiary hover:text-gx-text-primary" onClick={() => setShowNewView(false)}>
              取消
            </button>
            <button
              className="rounded-gx-md bg-gx-accent px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95 disabled:opacity-50"
              disabled={!newName.trim()}
              onClick={createView}
            >
              创建
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {VIEW_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setNewType(t)}
                className={[
                  "flex items-center gap-1.5 rounded-gx-md border px-2 py-1 text-gx-12",
                  newType === t ? "border-gx-accent bg-gx-accent-bg text-gx-accent" : "border-gx-border text-gx-text-primary hover:bg-gx-bg",
                ].join(" ")}
              >
                <Icon name={VIEW_ICON[t]} size={13} />
                {VIEW_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
          <Input
            autoFocus
            placeholder="视图名称"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createView()}
          />
        </div>
      </Modal>

      {/* 视图设置占位 Modal（designer/ViewSettingsPanel 尚未实现，集成时替换） */}
      <Modal open={showSettings} title="视图设置" onClose={() => setShowSettings(false)}>
        <div className="py-4 text-center text-gx-13 text-gx-text-tertiary">
          视图设置面板将在 designer 模块接入（ViewSettingsPanel）
        </div>
      </Modal>

      {/* 导入 CSV Modal */}
      <Modal
        open={showImport}
        title="导入 CSV"
        onClose={() => setShowImport(false)}
        footer={
          <>
            <button className="text-gx-13 text-gx-text-tertiary hover:text-gx-text-primary" onClick={() => setShowImport(false)}>
              取消
            </button>
            <button
              className="rounded-gx-md bg-gx-accent px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95"
              disabled={!importText.trim()}
              onClick={importCsv}
            >
              导入
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setImportText(await f.text());
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-gx-md border border-gx-border px-3 py-2 text-gx-13 text-gx-text-primary hover:bg-gx-bg"
          >
            选择 CSV 文件
          </button>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="或将 CSV 内容粘贴到这里"
            rows={6}
            className="w-full rounded-gx-md border border-gx-border bg-gx-surface px-2.5 py-1.5 text-gx-13 text-gx-text-primary focus:border-gx-accent focus:outline-none"
          />
        </div>
      </Modal>
    </div>
  );
}
