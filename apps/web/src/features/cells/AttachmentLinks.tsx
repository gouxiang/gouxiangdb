// apps/web/src/features/cells/AttachmentLinks.tsx
// 附件只读渲染的**单一真源**：网格单元格（CellRenderer）、详情/抽屉（DetailLayout
// 的 ReadValue）、看板/画廊卡片（field-controls 的 FieldValue）三处共用同一个实现。
//
// 背景（后端/编辑器现状 U-3）：附件没有对象存储通道，CellEditor 用
// `FileReader.readAsDataURL` 把文件读成 dataURL，原样存入 records.fields JSON
// （见 features/cells/CellEditor.tsx 的 AttachmentEditor）。所以：
//
//   ① href 通常是 `data:<mime>;base64,...`。lib/base 的 withBase 对 `scheme://`、
//      `data:`、`blob:` 一律原样返回（见 lib/base.test.ts），包一层不会破坏 dataURL；
//      若将来附件改成服务端相对路径（如 /uploads/files/x.bin），同一句 withBase
//      会自动补上部署子路径前缀（飞牛网关 /cgi/ThirdParty/gouxiangdb/index.cgi/ 场景），
//      不需要再回来改这里。
//   ② 必须带 download：现代浏览器禁止**顶层导航**到 data: URL（Chrome 60+ 起直接
//      拦截并报 "Not allowed to navigate top frame to a data: URL"），只靠
//      target="_blank" 是点不开的；download 让浏览器走下载而不是导航。
//   ③ url 可能为空（脏数据 / 旧记录）：退化成纯文本，不渲染空 href 的 <a>
//      ——href="" 点击会跳到当前页，属于制造新故障。
//
// 交互：所在容器的点击语义各不相同（网格单击=选中、双击=进入编辑；详情=进入编辑），
// 链接只应该下载，因此 click 与 doubleClick 两层都 stopPropagation。
// 注意绝不能 preventDefault——那会把下载本身也拦掉。

import { clsx } from "clsx";
import { Icon } from "../../components/icons";
import { withBase } from "../../api/client";

/** 最多展示的文件数，超出折叠为 `+N`（沿用改造前看板/画廊的口径） */
export const ATTACHMENT_MAX_VISIBLE = 4;

/** 附件名的兜底文案（文件名缺失时） */
export const ATTACHMENT_FALLBACK_NAME = "附件";

export interface AttachmentLinkItem {
  url: string;
  name: string;
}

/**
 * 附件单元格值 → 展示模型（纯函数：不碰 DOM，node 环境可直接单测）。
 *
 * 容错：非数组、元素非对象、url 缺失、name 缺失/空白都不会抛错。
 *
 * @returns items 全量（含隐藏项，供调用方判断是否需要 +N）；
 *          visible 前 maxVisible 个；hiddenCount 被折叠的数量。
 */
export function toAttachmentLinks(
  value: unknown,
  maxVisible: number = ATTACHMENT_MAX_VISIBLE,
): { items: AttachmentLinkItem[]; visible: AttachmentLinkItem[]; hiddenCount: number } {
  const raw = Array.isArray(value) ? value : [];
  const items: AttachmentLinkItem[] = raw.map((v) => {
    const o = (v !== null && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const rawName = typeof o.name === "string" ? o.name.trim() : "";
    return {
      url: typeof o.url === "string" ? o.url : "",
      name: rawName || ATTACHMENT_FALLBACK_NAME,
    };
  });
  return {
    items,
    visible: items.slice(0, maxVisible),
    hiddenCount: Math.max(0, items.length - maxVisible),
  };
}

export interface AttachmentLinksProps {
  /** 原始单元格值（CellValue 里的附件数组） */
  value: unknown;
  /** 最多展示数量，缺省 4 */
  maxVisible?: number;
  /** 外层容器附加类名 */
  className?: string;
  /**
   * 可选：传入后点击文件名改为「打开在线预览」，并在名字后面额外给一个显式的下载按钮。
   * **不传时行为与改造前完全一致**（整条就是下载链接）——既有断言与三处调用点
   * （网格 / 详情 / 看板画廊）均不传，故默认路径零变更。
   */
  onPreview?: (file: AttachmentLinkItem) => void;
}

export function AttachmentLinks({
  value,
  maxVisible = ATTACHMENT_MAX_VISIBLE,
  className,
  onPreview,
}: AttachmentLinksProps) {
  const { visible, hiddenCount } = toAttachmentLinks(value, maxVisible);
  return (
    <span className={clsx("flex flex-wrap items-center gap-1", className)} data-testid="attachment-links">
      {visible.map((f, i) => {
        if (!f.url) {
          // url 缺失：只留文件名的纯文本，不给空 href 的链接
          return (
            <span key={i} className="text-gx-12 text-gx-text-hint">
              {f.name}
            </span>
          );
        }
        if (onPreview) {
          // 预览模式：文件名仍是真 <a>（保留 href/download/rel，键盘与右键菜单行为不变），
          // 只是 onClick 改成打开预览弹窗；另给一枚显式下载按钮，下载入口不被预览吞掉。
          return (
            <span key={i} className="inline-flex max-w-full items-center gap-0.5">
              <a
                href={withBase(f.url)}
                download={f.name}
                target="_blank"
                rel="noreferrer"
                title={f.name}
                className="max-w-full truncate text-gx-12 text-gx-accent underline"
                onClick={(e) => {
                  e.stopPropagation();
                  // 阻止默认下载：本分支的语义是「点名字=预览」。
                  // 可选调用：node 环境（既有单测的元素树内省）传的是极简 mock 事件。
                  e.preventDefault?.();
                  onPreview(f);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {f.name}
              </a>
              <a
                href={withBase(f.url)}
                download={f.name}
                target="_blank"
                rel="noreferrer"
                title={`下载 ${f.name}`}
                aria-label={`下载 ${f.name}`}
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-gx-text-tertiary hover:text-gx-accent"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <Icon name="download" size={11} />
              </a>
            </span>
          );
        }
        return (
          <a
            key={i}
            href={withBase(f.url)}
            download={f.name}
            target="_blank"
            rel="noreferrer"
            title={f.name}
            className="max-w-full truncate text-gx-12 text-gx-accent underline"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {f.name}
          </a>
        );
      })}
      {hiddenCount > 0 && <span className="text-gx-12 text-gx-text-hint">+{hiddenCount}</span>}
    </span>
  );
}

export default AttachmentLinks;
