// apps/web/src/features/kb/VersionHistoryDrawer.tsx
// 版本历史抽屉：版本列表 + 历史预览（文档渲染 Markdown / 画布只读 Drawnix）+ 手动存版本 + 一键回滚。

import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/icons";
import { Modal, Spinner, toast } from "../../components/ui";
import type { KbDocDTO, KbDocVersionDTO } from "../../api/client";
import { useVersions, useVersion, useCreateVersion, useRollback } from "./kb-hooks";
import { formatTime } from "./kb-ui";
import { renderMarkdown } from "./markdown";
import { DrawnixCanvas, type DrawnixCanvasHandle } from "./DrawnixCanvas";
import { CanvasPreviewToolbar } from "./canvas/CanvasPreviewToolbar";

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.1;

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

/** 预览工具条：缩小 / 百分比（点击还原 100%）/ 放大 / 适配视图。文档与画布共用，交互一致。 */
function PreviewZoomBar({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset,
  onFit,
}: {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onFit: () => void;
}) {
  const btn =
    "inline-flex h-6 w-6 items-center justify-center rounded-gx-sm text-gx-text-secondary hover:bg-gx-bg hover:text-gx-text-primary disabled:opacity-35 disabled:hover:bg-transparent";
  return (
    <div className="flex items-center gap-0.5">
      <button type="button" title="缩小" className={btn} onClick={onZoomOut} disabled={zoom <= ZOOM_MIN + 1e-6}>
        <Icon name="minus" size={14} />
      </button>
      <button
        type="button"
        title="还原为 100%"
        onClick={onReset}
        className="min-w-[44px] rounded-gx-sm px-1 text-center text-gx-12 tabular-nums text-gx-text-secondary hover:bg-gx-bg hover:text-gx-text-primary"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" title="放大" className={btn} onClick={onZoomIn} disabled={zoom >= ZOOM_MAX - 1e-6}>
        <Icon name="plus" size={14} />
      </button>
      <span className="mx-1 h-3.5 w-px bg-gx-separator" />
      <button type="button" title="适配视图" className={btn} onClick={onFit}>
        <Icon name="expand" size={14} />
      </button>
    </div>
  );
}

export function VersionHistoryDrawer({
  doc,
  canEdit,
  onClose,
  onRolledBack,
}: {
  doc: KbDocDTO;
  canEdit: boolean;
  onClose: () => void;
  /** 回滚成功后通知父级重新加载正文 */
  onRolledBack?: () => void;
}) {
  const { data: versions, isLoading } = useVersions(doc.id);
  const [selected, setSelected] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [confirmRollback, setConfirmRollback] = useState<KbDocVersionDTO | null>(null);

  const createVersion = useCreateVersion(doc.id);
  const rollback = useRollback(doc.id);
  const { data: versionDetail, isLoading: loadingDetail } = useVersion(doc.id, selected);

  // 预览缩放：文档走 CSS zoom（布局与滚动条随缩放自然变化），画布走 BoardTransforms（视图态、不进撤销栈）
  const [docZoom, setDocZoom] = useState(1);
  const [canvasZoom, setCanvasZoom] = useState(1);
  const canvasCtlRef = useRef<DrawnixCanvasHandle | null>(null);
  const docScrollRef = useRef<HTMLDivElement | null>(null);
  const docBodyRef = useRef<HTMLDivElement | null>(null);

  // 切换版本时重置缩放（key 重挂载会让画布 fitOnLoad 重新适配，并经 onViewportChange 回写比例）
  useEffect(() => {
    setDocZoom(1);
    setCanvasZoom(1);
  }, [selected]);

  function fitDocWidth() {
    const scroller = docScrollRef.current;
    const body = docBodyRef.current;
    if (!scroller || !body) return;
    // 正文列为 max-w-2xl 居中；适配 = 让整列在可视区内完整显示（内容比视口宽时缩小，否则保持 100%）
    const natural = parseFloat(getComputedStyle(body).maxWidth) || body.offsetWidth;
    const avail = scroller.clientWidth - 48; // 两侧 px-6 留白
    setDocZoom(natural > avail ? clampZoom(avail / natural) : 1);
  }

  async function saveVersion() {
    if (!label.trim() || createVersion.isPending) return;
    try {
      await createVersion.mutateAsync(label.trim());
      toast("已保存当前版本", "success");
      setLabel("");
    } catch (e) {
      toast(e instanceof Error ? e.message : "保存版本失败", "error");
    }
  }

  async function doRollback() {
    if (!confirmRollback || rollback.isPending) return;
    try {
      await rollback.mutateAsync(confirmRollback.id);
      toast("已回滚，回滚前状态已自动备份为新版本", "success");
      setConfirmRollback(null);
      onRolledBack?.();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "回滚失败", "error");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-3xl flex-col bg-gx-surface shadow-xl">
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-gx-separator px-4 py-3">
          <div className="flex items-center gap-2">
            <Icon name="history" size={16} className="text-gx-accent" />
            <span className="text-gx-14 font-semibold text-gx-text-primary">版本历史</span>
            <span className="text-gx-12 text-gx-text-hint">{doc.title}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gx-text-tertiary hover:bg-gx-bg hover:text-gx-text-primary"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左：版本列表 */}
          <div className="flex w-64 shrink-0 flex-col border-r border-gx-separator bg-gx-bg">
            {canEdit && (
              <div className="border-b border-gx-separator p-2.5">
                <div className="flex items-center gap-1.5">
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveVersion()}
                    placeholder="版本备注，Enter 存当前"
                    className="h-7 flex-1 rounded-gx-sm border border-gx-border bg-gx-surface px-2 text-gx-12 text-gx-text-primary focus:border-gx-accent focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={!label.trim() || createVersion.isPending}
                    onClick={saveVersion}
                    title="保存当前为新版本"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-gx-sm bg-gx-accent text-white hover:brightness-95 disabled:opacity-40"
                  >
                    <Icon name="save" size={14} />
                  </button>
                </div>
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-1.5">
              {isLoading ? (
                <div className="flex justify-center py-10"><Spinner size={18} /></div>
              ) : (
                (versions ?? []).map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setSelected(v.id)}
                    className={[
                      "mb-1 w-full rounded-gx-sm px-2.5 py-2 text-left transition-colors",
                      selected === v.id ? "bg-gx-accent-bg" : "hover:bg-gx-row-hover",
                    ].join(" ")}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={["flex-1 truncate text-gx-13", selected === v.id ? "font-medium text-gx-accent" : "text-gx-text-primary"].join(" ")}>
                        v{v.version} {v.label ? `· ${v.label}` : ""}
                      </span>
                    </div>
                    <div className="mt-0.5 text-gx-11 text-gx-text-hint">{formatTime(v.createdAt)}</div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* 右：预览 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {!selected ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-gx-text-hint">
                <Icon name="history" size={28} />
                <span className="text-gx-13">选择左侧版本查看预览</span>
              </div>
            ) : loadingDetail || !versionDetail ? (
              <div className="flex flex-1 items-center justify-center"><Spinner size={20} /></div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 border-b border-gx-separator px-4 py-2">
                  <div className="min-w-0 text-gx-12 text-gx-text-tertiary">
                    预览 v{versionDetail.version} · {formatTime(versionDetail.createdAt)}
                    <span className="ml-2 text-gx-text-hint">（只读）</span>
                  </div>
                  <div className="flex items-center gap-3">
                    {doc.kind === "doc" ? (
                      <PreviewZoomBar
                        zoom={docZoom}
                        onZoomOut={() => setDocZoom((z) => clampZoom(z - ZOOM_STEP))}
                        onZoomIn={() => setDocZoom((z) => clampZoom(z + ZOOM_STEP))}
                        onReset={() => setDocZoom(1)}
                        onFit={fitDocWidth}
                      />
                    ) : (
                      <PreviewZoomBar
                        zoom={canvasZoom}
                        onZoomOut={() => canvasCtlRef.current?.zoomBy(-ZOOM_STEP)}
                        onZoomIn={() => canvasCtlRef.current?.zoomBy(ZOOM_STEP)}
                        onReset={() => canvasCtlRef.current?.setZoom(1)}
                        onFit={() => canvasCtlRef.current?.fit()}
                      />
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => setConfirmRollback(versionDetail)}
                        className="inline-flex h-7 items-center gap-1.5 rounded-gx-md bg-gx-accent px-2.5 text-gx-12 font-medium text-white hover:brightness-95"
                      >
                        <Icon name="rollback" size={13} />
                        回滚到此版本
                      </button>
                    )}
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-hidden">
                  {doc.kind === "doc" ? (
                    <div ref={docScrollRef} className="h-full overflow-auto px-6 py-6">
                      <div
                        ref={docBodyRef}
                        className="md-preview mx-auto max-w-2xl origin-top"
                        style={{ zoom: docZoom }}
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(versionDetail.content ?? "") }}
                      />
                    </div>
                  ) : (
                    <div className="relative h-full">
                      <DrawnixCanvas
                        key={`ver-${versionDetail.id}`}
                        ref={canvasCtlRef}
                        content={versionDetail.content}
                        readonly
                        allowViewInteraction
                        fitOnLoad
                        onViewportChange={(vp) => {
                          if (typeof vp.zoom === "number") setCanvasZoom(vp.zoom);
                        }}
                      />
                      <CanvasPreviewToolbar handle={canvasCtlRef.current} />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 回滚确认 */}
      <Modal
        open={!!confirmRollback}
        title="回滚确认"
        onClose={() => setConfirmRollback(null)}
        footer={
          <>
            <button className="text-gx-13 text-gx-text-tertiary hover:text-gx-text-primary" onClick={() => setConfirmRollback(null)}>
              取消
            </button>
            <button
              className="rounded-gx-md bg-gx-accent px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95"
              onClick={doRollback}
              disabled={rollback.isPending}
            >
              确认回滚
            </button>
          </>
        }
      >
        <p className="text-gx-13 text-gx-text-secondary">
          确定回滚到 <b>v{confirmRollback?.version}</b>（{confirmRollback?.label || "无备注"}）吗？
          当前内容会先自动备份为一个新版本，可随时找回。
        </p>
      </Modal>
    </div>
  );
}
