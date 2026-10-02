// apps/web/src/features/attachments/FilePreviewModal.tsx
// 附件在线预览弹窗。按格式分派到不同通道，全部通道共用同一套降级面板。
//
// 两条硬底线（产品要求「常用格式支持在线预览」+ 不允许白屏）：
//   ① 任何失败（不支持的格式 / 体积超限 / 网络失败 / 解析超时 / 库抛异常）都落到
//      「文件信息 + 下载按钮 + 友好提示」，绝不白屏、绝不抛未捕获异常；
//   ② PDF 走 blob URL，绝不用 data: URL（Chrome 对 iframe data: URL 有约 2MB 隐式上限且
//      超限静默空白，Firefox/Safari 直接不支持）；也绝不让 iframe 直指
//      /api/attachments/:id/content —— 后端全局 X-Frame-Options: DENY 会把自家响应拦掉。

import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import type { AttachmentDTO } from "@gx/shared-types";
import { Modal, Spinner } from "../../components/ui";
import { Icon } from "../../components/icons";
import { withBase } from "../../api/client";
import { fetchAttachmentBytes, toBlobUrl } from "./api";
import { parseCsvPreview } from "../grid/ImportWizard";
import { parseSpreadsheet, renderDocx, renderPptx, withTimeout, type PptxHandle, type SheetTable } from "./renderers";
import {
  formatBytes,
  isDataUrl,
  previewKindLabel,
  previewMime,
  previewRejection,
  resolvePreviewKind,
} from "./policy";

/** 纯文本预览的最大展示字符数（再大就只给下载，避免把主线程卡在排版上）。 */
const TEXT_PREVIEW_MAX_CHARS = 200_000;

export interface FilePreviewModalProps {
  /** null = 关闭 */
  file: AttachmentDTO | null;
  onClose: () => void;
}

export function FilePreviewModal({ file, onClose }: FilePreviewModalProps) {
  const kind = file ? resolvePreviewKind(file.name, file.mime) : "none";
  // 前置守卫（格式 / 体积）：命中就根本不去取字节，直接进降级面板。
  const rejection = file ? previewRejection(file) : "未选择文件";

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [sheets, setSheets] = useState<SheetTable[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [text, setText] = useState("");
  const [pptxSlides, setPptxSlides] = useState(0);

  const bodyRef = useRef<HTMLDivElement>(null);
  // 每次换文件都要换一个 key：让下面的 effect 从头跑一遍，而不是复用上一次的渲染结果。
  const fileKey = file ? `${file.id}|${file.url}` : "";

  useEffect(() => {
    if (!file || rejection) {
      setStatus("error");
      setErrorText(rejection ?? "无法预览该文件");
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    let handle: PptxHandle | null = null;

    setStatus("loading");
    setErrorText("");
    setMediaUrl("");
    setSheets([]);
    setActiveSheet(0);
    setText("");
    setPptxSlides(0);

    const run = async () => {
      const bytes = await fetchAttachmentBytes(file.url);
      const buf = bytes.slice().buffer;
      const mime = previewMime(file.name, file.mime);
      switch (kind) {
        case "image":
        case "pdf":
        case "video":
        case "audio": {
          objectUrl = toBlobUrl(bytes, mime);
          if (cancelled) return;
          setMediaUrl(objectUrl);
          setStatus("ready");
          return;
        }
        case "spreadsheet": {
          const parsed = await withTimeout(parseSpreadsheet(buf));
          if (cancelled) return;
          setSheets(parsed);
          setStatus("ready");
          return;
        }
        case "csv": {
          const parsed = parseCsvPreview(new TextDecoder("utf-8").decode(bytes));
          if (cancelled) return;
          setSheets([{ name: file.name, rows: parsed.slice(0, 500), truncated: parsed.length > 500 }]);
          setStatus("ready");
          return;
        }
        case "text": {
          const raw = new TextDecoder("utf-8").decode(bytes);
          if (cancelled) return;
          setText(raw.slice(0, TEXT_PREVIEW_MAX_CHARS));
          setStatus("ready");
          return;
        }
        case "docx": {
          const el = bodyRef.current;
          if (!el) throw new Error("预览容器未就绪");
          await withTimeout(renderDocx(el, buf));
          if (cancelled) return;
          setStatus("ready");
          return;
        }
        case "pptx": {
          const el = bodyRef.current;
          if (!el) throw new Error("预览容器未就绪");
          handle = await withTimeout(renderPptx(el, buf));
          if (cancelled) return;
          setPptxSlides(handle.slideCount);
          setStatus("ready");
          return;
        }
        default:
          throw new Error("该格式暂不支持在线预览");
      }
    };

    run().catch((e) => {
      if (cancelled) return;
      setStatus("error");
      setErrorText(e instanceof Error ? e.message : "预览失败，请下载后打开");
    });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      handle?.destroy();
    };
    // fileKey 唯一标识一次预览请求；kind/rejection 随 file 一起变，无需单列。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey]);

  const sheet = sheets[Math.min(activeSheet, Math.max(0, sheets.length - 1))];
  const downloadHref = file ? withBase(file.url) : "";
  const kindLabel = previewKindLabel(kind);

  const footer = (
    <div className="flex w-full items-center justify-between gap-2">
      <span className="truncate text-gx-11 text-gx-text-hint">
        {file ? `${kindLabel}${file.size > 0 ? ` · ${formatBytes(file.size)}` : ""}${pptxSlides > 0 ? ` · ${pptxSlides} 页` : ""}` : ""}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        {/* 存量 dataURL 附件不给「新标签页打开」：现代浏览器禁止顶层导航到 data: URL，
            点了会被静默拦掉（Chrome 直接报 Not allowed to navigate top frame）。 */}
        {file && !isDataUrl(file.url) && (
          <a
            href={downloadHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center rounded-gx-lg border border-gx-border px-3 text-gx-13 text-gx-text-secondary hover:bg-gx-row-hover"
          >
            在新标签页打开
          </a>
        )}
        {/* 下载用 <a download> 而不是包一个 <Button>：按钮嵌在链接里是无效交互嵌套，
            键盘与读屏都会拿到两个可聚焦元素。样式与 primary 按钮同款。 */}
        {file && (
          <a
            href={downloadHref}
            download={file.name}
            className="inline-flex h-8 items-center gap-1.5 rounded-gx-lg bg-gx-accent px-3 text-gx-13 font-medium text-white transition-[background-color,filter] duration-[120ms] hover:brightness-95"
          >
            <Icon name="download" size={15} />
            下载
          </a>
        )}
      </div>
    </div>
  );

  return (
    <Modal open={!!file} title={file?.name ?? "附件预览"} onClose={onClose} width={880} footer={footer} flush>
      <div className="flex h-full min-h-0 flex-col">
        {status === "loading" && (
          <div className="flex shrink-0 items-center gap-2 px-4 py-2 text-gx-13 text-gx-text-secondary">
            <Spinner size={16} />
            正在加载预览…
          </div>
        )}

        {/*
          docx / pptx 的容器必须在 loading 阶段就挂载：渲染是 effect 里做的，等 status 变成
          ready 再挂载就晚了（effect 跑的时候 ref 还是 null，会误报「预览容器未就绪」）。
        */}
        {status !== "error" && (kind === "docx" || kind === "pptx") && (
          <div
            ref={bodyRef}
            className={clsx("min-h-0 flex-1 overflow-auto bg-gx-surface", kind === "docx" ? "px-6 py-4" : "p-2")}
          />
        )}

        {status === "error" && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <Icon name="alertCircle" size={28} className="text-gx-text-hint" />
            <div className="text-gx-14 font-medium text-gx-text-primary">{file?.name ?? "附件"}</div>
            <div className="max-w-[52ch] text-gx-13 text-gx-text-secondary">{errorText}</div>
            {file && (
              <div className="text-gx-12 text-gx-text-hint">
                {previewKindLabel(kind)}
                {file.size > 0 ? ` · ${formatBytes(file.size)}` : ""} · 可下载后用本地程序打开
              </div>
            )}
          </div>
        )}

        {status === "ready" && (
          <div className="flex min-h-0 flex-1 flex-col">
            {kind === "image" && mediaUrl && (
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-gx-bg p-4">
                <img src={mediaUrl} alt={file?.name ?? ""} className="max-h-full max-w-full object-contain" />
              </div>
            )}

            {kind === "pdf" && mediaUrl && (
              <div className="flex min-h-0 flex-1 flex-col">
                <iframe
                  src={mediaUrl}
                  title={file?.name ?? "PDF 预览"}
                  className="min-h-0 w-full flex-1 border-0"
                />
                {/* iOS Safari 的内联 PDF 支持不稳定，给一条明确出路而不是让用户对着空白页。 */}
                <div className="shrink-0 border-t border-gx-separator px-4 py-2 text-gx-11 text-gx-text-hint">
                  若上方无法显示（部分移动端浏览器不支持内联 PDF），请用下方「在新标签页打开」或「下载」。
                </div>
              </div>
            )}

            {kind === "video" && mediaUrl && (
              <div className="flex min-h-0 flex-1 items-center justify-center bg-gx-bg p-4">
                <video src={mediaUrl} controls className="max-h-full max-w-full" />
              </div>
            )}

            {kind === "audio" && mediaUrl && (
              <div className="flex flex-1 items-center justify-center p-6">
                <audio src={mediaUrl} controls className="w-full" />
              </div>
            )}

            {(kind === "spreadsheet" || kind === "csv") && sheet && (
              <SheetView
                sheets={sheets}
                active={Math.min(activeSheet, Math.max(0, sheets.length - 1))}
                onSwitch={setActiveSheet}
              />
            )}

            {kind === "text" && (
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-gx-12 text-gx-text-primary">
                {text}
              </pre>
            )}

          </div>
        )}
      </div>
    </Modal>
  );
}

/** 表格视图：多 sheet 给切换条；单 sheet 不显示切换条。 */
function SheetView({
  sheets,
  active,
  onSwitch,
}: {
  sheets: SheetTable[];
  active: number;
  onSwitch: (i: number) => void;
}) {
  const sheet = sheets[active];
  const showTabs = useMemo(() => sheets.length > 1, [sheets.length]);
  if (!sheet) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showTabs && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-gx-separator px-3 py-1.5">
          {sheets.map((s, i) => (
            <button
              key={`${s.name}-${i}`}
              type="button"
              onClick={() => onSwitch(i)}
              className={clsx(
                "shrink-0 rounded-gx-sm px-2 py-0.5 text-gx-12 transition-colors duration-[120ms]",
                i === active ? "bg-gx-accent-bg text-gx-accent" : "text-gx-text-secondary hover:bg-gx-row-hover",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-gx-12">
          <tbody>
            {sheet.rows.map((row, r) => (
              <tr key={r} className={r === 0 ? "bg-gx-bg" : undefined}>
                {row.map((cell, c) => (
                  <td
                    key={c}
                    className="max-w-[280px] truncate border border-gx-separator px-2 py-1 text-gx-text-primary"
                    title={cell}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.rows.length === 0 && (
          <div className="px-4 py-6 text-center text-gx-12 text-gx-text-hint">该工作表没有内容</div>
        )}
      </div>
      {sheet.truncated && (
        <div className="shrink-0 border-t border-gx-separator px-4 py-1.5 text-gx-11 text-gx-text-hint">
          内容较多，仅显示前 500 行 / 前 60 列，完整数据请下载查看
        </div>
      )}
    </div>
  );
}

export default FilePreviewModal;
