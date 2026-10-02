// apps/web/src/features/attachments/renderers.ts
// Office 预览渲染器。**三个 Office 库一律动态 import()**，绝不能静态 import：
// docx-preview + @keep-lts/xlsx + @file-viewer/pptx 合计约 1.5MB，一旦进了主 chunk，
// 首屏 JS 直接翻倍（构建后主 chunk 体积守卫会拦）。
//
// 全部返回 Promise 且由调用方套 withTimeout：解析库在大/畸形文件上可能长时间不返回，
// 没有超时会让预览面板永远停在 loading（比报错更糟）。

// Vite 的 ?worker 后缀导入：把库自带的 worker 编成同构建产物内的独立 chunk，
// 与页面同源、随构建走。包本身没有导出这个 specifier，类型由 src/types/pptx-worker.d.ts 声明。
import PptxWorkerCtor from "@file-viewer/pptx/worker/pptx.worker.js?worker";

import { PREVIEW_TIMEOUT_MS } from "./policy";

/** 给 Promise 套超时。超时后 reject，原 Promise 继续跑但不影响 UI。 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms = PREVIEW_TIMEOUT_MS,
  message = "预览解析超时，请下载后打开",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer =
      typeof setTimeout === "function"
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(message));
          }, ms)
        : null;
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

// ============ 表格（xls / xlsx）============

/** 单表最大渲染行数与列数：超出即截断，其余数据仍在文件里，可下载查看。 */
export const SHEET_MAX_ROWS = 500;
export const SHEET_MAX_COLS = 60;

export interface SheetTable {
  name: string;
  /** 二维数组，已全部转成字符串（含表头行）。 */
  rows: string[][];
  /** 行数/列数被截断（大表防 DOM 爆炸）。 */
  truncated: boolean;
}

/** 单元格值 → 展示串（Date 走本地日期，布尔走「是/否」，空值归空串）。 */
export function cellToText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "object") {
    // 富文本单元格（{t, v}）与富文本数组都可能存在，取可见文本。
    const o = v as Record<string, unknown>;
    if (typeof o.v === "string" || typeof o.v === "number") return String(o.v);
    if (typeof o.t === "string") return o.t;
    return "";
  }
  return String(v);
}

/** 解析 xls/xlsx → 多 sheet 表格（纯数组，交由 React 渲染，不手写 innerHTML）。 */
export async function parseSpreadsheet(buf: ArrayBuffer): Promise<SheetTable[]> {
  const XLSX = await import("@keep-lts/xlsx");
  const wb = XLSX.read(new Uint8Array(buf), { type: "array", cellDates: true });
  const names: string[] = Array.isArray(wb?.SheetNames) ? wb.SheetNames : [];
  if (names.length === 0) throw new Error("文件里没有可读取的工作表");
  return names.map((name) => {
    const ws = wb.Sheets?.[name];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", blankrows: false }) as unknown[][];
    const source = Array.isArray(raw) ? raw : [];
    const rows = source
      .slice(0, SHEET_MAX_ROWS)
      .map((r) => (Array.isArray(r) ? r : []).slice(0, SHEET_MAX_COLS).map(cellToText));
    const colsOver = source.some((r) => (Array.isArray(r) ? r.length : 0) > SHEET_MAX_COLS);
    return { name, rows, truncated: source.length > SHEET_MAX_ROWS || colsOver };
  });
}

// ============ Word（docx）============

/** 渲染 docx 到容器（docx-preview 直写 DOM，不走 React）。 */
export async function renderDocx(container: HTMLElement, buf: ArrayBuffer): Promise<void> {
  const docx = await import("docx-preview");
  container.innerHTML = "";
  await docx.renderAsync(buf, container, undefined, {
    // inWrapper=false：外层滚动与内边距由我们的 Modal 控制，避免双层滚动条。
    inWrapper: false,
    ignoreWidth: true,
    ignoreHeight: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
  });
}

// ============ PPT（pptx）============

export interface PptxHandle {
  slideCount: number;
  destroy: () => void;
}

/**
 * 渲染 pptx 到容器。
 *
 * worker 来源显式指定：该库在 Web Worker 里解析，默认用
 * `new URL('./worker/pptx.worker.js', import.meta.url)` 推导地址。生产部署在网关子路径
 * （/cgi/ThirdParty/gouxiangdb/index.cgi/）下这条推导不保证成立，所以改由 Vite 自己 emit
 * 一份 worker（?worker 后缀），通过 workerFactory 交给库 —— 与页面同源、随构建产物走。
 */
export async function renderPptx(container: HTMLElement, buf: ArrayBuffer): Promise<PptxHandle> {
  const { PptxViewer } = await import("@file-viewer/pptx");
  container.innerHTML = "";
  const viewer = await PptxViewer.open(buf, container, {
    workerFactory: () => new PptxWorkerCtor(),
    fitMode: "contain",
  });
  return {
    slideCount: typeof viewer?.slideCount === "number" ? viewer.slideCount : 0,
    destroy: () => {
      try {
        viewer?.destroy?.();
      } catch {
        // 销毁失败无所谓：容器马上会被卸载，残留 DOM 随 React 一起消失。
      }
    },
  };
}
