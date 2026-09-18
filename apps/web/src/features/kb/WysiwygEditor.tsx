// apps/web/src/features/kb/WysiwygEditor.tsx
// 知识库文档"编辑"态：所见即所得块编辑器（对标 Notion/Obsidian 实时预览）。
//  - 块级语法（# 标题、- 列表、1. 有序、- [ ] 待办、> 引用、``` 代码、| 表格、--- 分割线、图片、$$ 公式）
//    直接渲染成真实视觉元素（大标题/圆点/勾选框/引用条/代码框/表格），用户看不到源码符号。
//  - 块内行内语法（粗/斜/删/码/高亮/链接）在 contentEditable 中以真实格式呈现，编辑后序列化回 Markdown。
//  - 输入 "/" 唤起斜杠菜单；回车续块/分裂；退格合并/降级；行首 "# " 等快捷转换。
//  - 与"源码"态（textarea）、"预览"态（只读）共享同一份 Markdown，切换无损。

import { Fragment, memo, useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Icon, type IconName } from "../../components/icons";
import { ContextMenu, type ContextMenuItem, toast } from "../../components/ui";
import { ColorPicker } from "../../components/ColorPicker";
import { EntityPicker, type PickedEntity } from "../../components/EntityPicker";
import { internalHref } from "../../lib/internal-links";
import { MentionPicker } from "./MentionPicker";
import { CanvasEmbed } from "./CanvasEmbed";
import { useLinkResolve } from "./hooks/useLinkResolve";
import { useAuthStore } from "../../store/auth";
import { withBase } from "../../api/client";
import { authHeaders } from "../../api/authHeader";
import {
  Block,
  BlockType,
  blocksToMd,
  CalloutVariant,
  CALLOUT_VARIANTS,
  htmlToInlineMd,
  inlineMdToHtml,
  isSafeUrl,
  mdToBlocks,
  mediaKindOf,
  newBlock,
  uid,
} from "@gx/blocks";
import { shiftTableSpans, tableOccupancy } from "@gx/blocks";
import { slugify } from "@gx/blocks";
import { loadUploadLimits, validateUpload } from "./upload-limits";
import { createEditorHistory } from "./editor-history";
import "./kb.css";

/* ---------------- 文件 -> data URL ---------------- */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error("文件读取失败"));
    r.readAsDataURL(file);
  });
}

/** 带进度回调的 dataURL 读取（progress: 0-100） */
function fileToDataUrlProgress(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) onProgress(Math.round((ev.loaded / ev.total) * 100));
    };
    r.onload = () => { onProgress?.(100); resolve(r.result as string); };
    r.onerror = () => reject(new Error("文件读取失败"));
    r.onabort = () => reject(new Error("已取消"));
    r.readAsDataURL(file);
  });
}

/** 上传任务（仅编辑器本地态，绝不进入 Block 模型 / Markdown） */
interface UploadTask {
  id: string;
  kind: "image" | "video" | "audio" | "pdf" | "file";
  name: string;
  sizeLabel: string;
  progress: number;
  status: "reading" | "error";
  error?: string;
  file: File;
}
function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
/* ---------------- 斜杠命令（WYSIWYG 版） ---------------- */
type CmdKind = "type" | "wrap" | "insert" | "image" | "file" | "media" | "entity";
interface WCmd {
  id: string;
  title: string;
  desc: string;
  icon: IconName;
  keywords: string;
  kind: CmdKind;
  blockType?: BlockType; // type 转换目标
  wrap?: [string, string]; // 行内包裹
  insert?: BlockType; // 插入块
  media?: "video" | "audio" | "pdf"; // 媒体上传类型
}
const CMDS: WCmd[] = [
  { id: "p", title: "正文", desc: "普通段落文本", icon: "text", keywords: "p text paragraph 正文 zhengwen", kind: "type", blockType: "p" },
  { id: "h1", title: "标题 1", desc: "# 一级标题", icon: "text", keywords: "h1 heading biaoti 标题 大标题", kind: "type", blockType: "h1" },
  { id: "h2", title: "标题 2", desc: "## 二级标题", icon: "text", keywords: "h2 heading 标题", kind: "type", blockType: "h2" },
  { id: "h3", title: "标题 3", desc: "### 三级标题", icon: "text", keywords: "h3 heading 标题", kind: "type", blockType: "h3" },
  { id: "h4", title: "标题 4", desc: "#### 四级标题", icon: "text", keywords: "h4 标题", kind: "type", blockType: "h4" },
  { id: "ul", title: "无序列表", desc: "圆点列表项", icon: "list", keywords: "ul bullet list 无序 列表 liebiao", kind: "type", blockType: "ul" },
  { id: "ol", title: "有序列表", desc: "编号列表项", icon: "list", keywords: "ol ordered number 有序 列表", kind: "type", blockType: "ol" },
  { id: "task", title: "待办清单", desc: "可勾选待办项", icon: "check", keywords: "todo task 待办 任务 daiban", kind: "type", blockType: "task" },
  { id: "quote", title: "引用", desc: "引用块", icon: "quote", keywords: "quote 引用 yinyong", kind: "type", blockType: "quote" },
  { id: "code", title: "代码块", desc: "插入代码块", icon: "code", keywords: "code 代码块 daima", kind: "insert", insert: "code" },
  { id: "table", title: "表格", desc: "插入 3×3 表格", icon: "table", keywords: "table 表格 biaoge", kind: "insert", insert: "table" },
  { id: "math", title: "数学公式", desc: "$$ 公式块", icon: "hash", keywords: "math formula 公式 gongshi latex", kind: "insert", insert: "math" },
  { id: "hr", title: "分割线", desc: "水平分割线", icon: "minus", keywords: "hr divider 分割线 fengexian", kind: "insert", insert: "hr" },
  { id: "pagebreak", title: "分页符", desc: "插入分页符（打印/导出分页）", icon: "minus", keywords: "pagebreak 分页 fenye 分页符", kind: "insert", insert: "pagebreak" },
  { id: "toggle", title: "折叠块", desc: "可展开/收起的内容块", icon: "chevronRight", keywords: "toggle details 折叠 zhedie 折叠块", kind: "insert", insert: "toggle" },
  { id: "callout-note", title: "提示块", desc: "高亮提示信息（NOTE）", icon: "sparkles", keywords: "callout note 提示 tishi 提示块", kind: "insert", insert: "callout" },
  { id: "image", title: "图片", desc: "上传图片并插入", icon: "image", keywords: "image 图片 tupian 上传", kind: "image" },
  { id: "video", title: "视频", desc: "上传视频并内嵌播放", icon: "video", keywords: "video 视频 shipin mp4 上传", kind: "media", media: "video" },
  { id: "audio", title: "音频", desc: "上传音频并内嵌播放", icon: "audio", keywords: "audio 音频 yinpin mp3 录音 上传", kind: "media", media: "audio" },
  { id: "pdf", title: "嵌入 PDF", desc: "上传 PDF 并内嵌预览", icon: "file", keywords: "pdf 文档 wendang 嵌入 上传", kind: "media", media: "pdf" },
  { id: "file", title: "附件", desc: "上传文件并插入下载卡片", icon: "paperclip", keywords: "file attachment 附件 fujian", kind: "file" },
  { id: "link-doc", title: "链接到文档/画布", desc: "插入知识库文档或画布的内部链接", icon: "link", keywords: "link doc 文档 画布 链接 内部 关联 neilian", kind: "entity" },
  { id: "link-table", title: "链接到数据表", desc: "插入一张数据表的内部链接", icon: "table", keywords: "link table 数据表 链接 内部 关联", kind: "entity" },
  { id: "bold", title: "加粗", desc: "**粗体**", icon: "bold", keywords: "bold 加粗 cu", kind: "wrap", wrap: ["**", "**"] },
  { id: "italic", title: "斜体", desc: "*斜体*", icon: "italic", keywords: "italic 斜体 xie", kind: "wrap", wrap: ["*", "*"] },
  { id: "strike", title: "删除线", desc: "~~删除~~", icon: "strikethrough", keywords: "strike 删除线 shanchu", kind: "wrap", wrap: ["~~", "~~"] },
  { id: "mark", title: "高亮", desc: "==高亮==", icon: "sparkles", keywords: "mark highlight 高亮 gaoliang", kind: "wrap", wrap: ["==", "=="] },
  { id: "inlinecode", title: "行内代码", desc: "`代码`", icon: "code", keywords: "inline code 行内代码", kind: "wrap", wrap: ["`", "`"] },
  { id: "link", title: "链接", desc: "[文字](网址)", icon: "link", keywords: "link 链接 lianjie", kind: "wrap", wrap: ["[", "](https://)"] },
];

/**
 * 原子块：渲染为不可编辑的预览（图片/视频/音频/PDF/附件/分割线/分页符）。
 * 这类块无法容纳光标，统一走"点击选中 → Delete/Backspace 删除 / 回车在下方插入空段落"交互，
 * 与 Notion / NocoDB 文档的媒体块行为一致。
 */
const ATOMIC_TYPES: ReadonlySet<BlockType> = new Set([
  "image", "video", "audio", "pdf", "attachment", "hr", "pagebreak",
]);

/**
 * 占用型块：在编辑器中**不能承载光标**但本身可含可编辑子区
 * （callout/toggle 的 body/code/math/table），仍需要"前/后自动空段"保证光标自由进出。
 * 与纯原子块区别：占用型块有可编辑子区，原子块完全没有。
 */
const OCCUPY_TYPES: ReadonlySet<BlockType> = new Set([
  "callout", "toggle", "code", "math", "table",
  ...ATOMIC_TYPES,
]);

/** 是否需要"自动补空段 + 上下点击热区"：所有占用型 + 原子型 */
function needsEmptyPair(type: BlockType): boolean {
  return OCCUPY_TYPES.has(type);
}

interface SlashState {
  blockId: string;
  query: string;
  top: number;
  left: number;
  triggerOffset: number; // 块内 "/" 起始字符偏移（textContent）
}

/*
 * contentEditable 容器：聚焦时绝不重写 innerHTML（避免输入中光标跳动），
 * 仅在非聚焦或块类型/外部内容变化时同步为最新格式化 HTML。
 */
const Editable = memo(function Editable({
  blockId,
  html,
  readOnly,
  focused,
  isComposing,
  className,
  onInput,
  onFocus,
  onBlur,
}: {
  blockId: string;
  html: string;
  readOnly: boolean;
  focused: boolean;
  /** IME 组词中：修复 Issue 3（快速输入中文时 IME 提前消失）。组词期间浏览器管 DOM，外层不得覆写 innerHTML */
  isComposing: boolean;
  className?: string;
  onInput: (id: string) => void;
  onFocus: (id: string) => void;
  onBlur: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 聚焦中由浏览器管理 DOM（避免光标跳动）；失焦后或内容外部变化时同步为最新 html
    // IME 组词中绝不覆写：覆写会摧毁浏览器维护的 composition span，IME 会话立即终止
    if (focused || isComposing) return;
    if (el.innerHTML !== html) el.innerHTML = html;
  }, [html, focused, isComposing]);
  return (
    <div
      ref={ref}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      data-editable={blockId}
      className={className}
      onInput={() => onInput(blockId)}
      onFocus={() => onFocus(blockId)}
      onBlur={() => onBlur(blockId)}
    />
  );
});

export function WysiwygEditor({
  initialMarkdown,
  onChange,
  readOnly = false,
  docId,
}: {
  initialMarkdown: string;
  onChange: (md: string) => void;
  readOnly?: boolean;
  /** 当前编辑文档 id——传给 MentionPicker 排除自身引用 */
  docId?: string;
}) {
  const [blocks, setBlocks] = useState<Block[]>(() => mdToBlocks(initialMarkdown));
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  // 撤销/重做栈：Cmd/Ctrl+Z / Cmd+Shift+Z / Cmd+Y 走 historyRef.undo()/redo()。
  // 挂载时推入一次 initial state，确保 canUndo() 在用户首次输入后才返回 true。
  const historyRef = useRef(createEditorHistory());
  useEffect(() => {
    historyRef.current.push(blocksRef.current);
  }, []);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const uploadKind = useRef<"image" | "file" | "video" | "audio" | "pdf">("image");
  const [uploading, setUploading] = useState(false);
  // 上传任务列表（占位进度条 / 错误重试），仅本地态，不进 Markdown
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const uploadSeq = useRef(0);
  // 上传落点锚点：斜杠菜单/工具栏触发上传时记录目标块，媒体块插到它后面（而不是文档末尾）
  const uploadAnchorRef = useRef<string | null>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [activeCmd, setActiveCmd] = useState(0);
  // 「@」跨文档引用/提及面板：记录触发块与面板视口坐标
  const [mention, setMention] = useState<{ blockId: string; top: number; left: number } | null>(null);
  // IME 组词状态：用 ref 同步传递（避免 setState 延迟），用于 Issue 3 修复——快速输入中文时
  // 浏览器管 DOM 的窗口期，绝对不能覆写 innerHTML / 重读 DOM / 重渲染整树，否则 IME 会话立即终止。
  const isComposingRef = useRef(false);
  const [isComposingState, setIsComposingState] = useState(false);
  const { kbId } = useParams();
  const navigate = useNavigate();
  // 内部链接可达性探测（ok / 已删除 / 无权限）—— 点击 md-link 时异步校验
  const resolveLink = useLinkResolve();
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusedIdRef = useRef<string | null>(null);
  focusedIdRef.current = focusedId;
  // 原子块（图片/视频/音频/PDF/附件/分割线/分页符）选中态：点击选中后可 Delete/Backspace 删除
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedBlockId;
  /**
   * 「已经空过一次」的列表/任务块 id 集合：
   *  - 列表项按 Enter 续同类项；空列表项第一次 Enter 不退出、只清空 text 并把自己加入 set
   *  - 同一空列表项再按一次 Enter 才真正退出（从 set 移除 + 切 p）
   *  - 用户在该块内输入任何字符或失去焦点都会清掉标记（避免误判）
   */
  const emptyListOnceRef = useRef<Set<string>>(new Set());
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const [pickerOpen, setPickerOpen] = useState(false);
  const entityBlockRef = useRef<string | null>(null);
  // 斜杠菜单容器：键盘上下选择时驱动高亮项滚动跟随
  const slashMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!slash) return;
    const menu = slashMenuRef.current;
    if (!menu) return;
    const item = menu.querySelector<HTMLElement>(`.kb-slash-item.active`);
    item?.scrollIntoView({ block: "nearest" });
  }, [activeCmd, slash]);

  /**
   * 右键菜单：受控状态 — 点击元素 + 视口坐标
   * 由根容器的 onContextMenu 委托填充；点击/键盘/外部点击由 ContextMenu 内部处理
   */
  type CtxHit =
    | { kind: "text"; blockId: string; hasSelection: boolean; selectedText: string; range: Range | null }
    | { kind: "atomic"; blockId: string }
    | { kind: "table"; blockId: string; cell?: { row: number; col: number } }
    | { kind: "toggle-sum"; blockId: string }
    | { kind: "link"; blockId: string; href: string; anchor: HTMLElement }
    | { kind: "callout-head"; blockId: string };
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hit: CtxHit } | null>(null);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const emit = useCallback(
    (next: Block[]) => {
      blocksRef.current = next;
      setBlocks(next);
      historyRef.current.push(next);
      onChange(blocksToMd(next));
    },
    [onChange],
  );

  /**
   * 由历史栈（undo/redo）恢复 blocks 时使用：与 emit 同样的副作用，但语义上是
   * "应用历史态"，不再次入栈——避免 undo 自身被记入栈造成回弹。
   * 修复 Bug-A：undo/redo 后必须强制刷新 editable 的 DOM。原实现只 setBlocks(next)，
   * 但 Editable 聚焦中不同步 innerHTML（WysiwygEditor.tsx:189 的 !focused 守卫），
   * 导致失焦时 syncBlock 读到陈旧 DOM 把撤销"抵消"。
   * 修复 Issue 3：IME 组词中跳过 rAF 覆写——覆写会摧毁浏览器维护的 composition span。
   */
  const applyHistoryState = useCallback(
    (next: Block[]) => {
      blocksRef.current = next;
      setBlocks(next);
      onChange(blocksToMd(next));
      // 强制刷新所有文本块 editable 的 DOM，与新的 blocks 状态对齐。
      // 用 rAF 等 React commit 完成后再刷，避免被随后 render 的 !focused 守卫覆盖。
      requestAnimationFrame(() => {
        if (isComposingRef.current) return; // IME 期间绝不刷 DOM
        for (const b of next) {
          const el = editableEl(b.id);
          if (!el) continue;
          const html = b.text != null ? inlineMdToHtml(b.text) : "";
          if (el.innerHTML !== html) el.innerHTML = html;
        }
      });
    },
    [onChange],
  );

  /*
   * 仅在挂载时用 initialMarkdown 初始化 blocks。
   * 三态为条件渲染：切到其它模式本组件卸载、切回时重新挂载并拿到最新 md，
   * 草稿恢复/版本回滚由父级用 key 重挂载整棵编辑器。因此不在此监听 initialMarkdown
   * 变化——否则自身 onChange 回流会误判为"外部变更"而重建 blocks，导致输入光标丢失。
   */

  const patchBlock = useCallback(
    (id: string, patch: Partial<Block>) => {
      emit(blocksRef.current.map((b) => (b.id === id ? { ...b, ...patch } : b)));
    },
    [emit],
  );

  /* ---------------- 块编辑：读取 contentEditable 内容回写 ---------------- */
  const editableEl = (blockId: string): HTMLElement | null =>
    rootRef.current?.querySelector(`[data-editable="${blockId}"]`) ?? null;

  const syncBlock = useCallback(
    (blockId: string) => {
      // 修复 Issue 3（IME 组词丢失）：IME 期间浏览器管 DOM（包括 composition span），
      // 读 DOM → htmlToInlineMd → mutate ref.text → onChange 会把未提交的拼音当成已落字，
      // 紧接着的父级 setMd 重渲染会通过 Editable 的 effect 把 innerHTML 覆写，摧毁 IME composition 会话。
      if (isComposingRef.current) return;
      const el = editableEl(blockId);
      if (!el) return;
      const md = htmlToInlineMd(el);
      const b = blocksRef.current.find((x) => x.id === blockId);
      if (b && b.text !== md) {
        // 直接改 ref 文本但不触发重渲染（避免光标跳动）；延迟到结构操作才 setState
        b.text = md;
        historyRef.current.push(blocksRef.current);
        onChange(blocksToMd(blocksRef.current));
      }
    },
    [onChange],
  );

  /**
   * IME 组词结束回调：合成 ref + 同步 setState 标记解除，
   * 并对当前聚焦块重放一次 syncBlock 把 IME 期间"被浏览器暂存"的最终字符落地。
   * 修复 Issue 3：纯异步 setState 会有 1 帧延迟，期间下一次 input 可能命中错误的 isComposing 值。
   */
  const onCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
    setIsComposingState(false);
    const fid = focusedIdRef.current;
    if (fid) syncBlock(fid);
  }, [syncBlock]);

  const onCompositionStart = useCallback(() => {
    isComposingRef.current = true;
    setIsComposingState(true);
  }, []);

  /* ---------------- 斜杠菜单检测（在块 input 后） ---------------- */
  const detectSlash = useCallback((blockId: string) => {
    // 修复 Issue 3：IME 组词中不检测斜杠菜单（input 事件触发但语义未提交）
    if (isComposingRef.current) return;
    const el = editableEl(blockId);
    if (!el) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      setSlash(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const caret = range.startOffset;
    // 取光标前纯文本
    const pre = range.startContainer.textContent?.slice(0, caret) ?? el.textContent?.slice(0, caret) ?? "";
    const m = /^(\s*)\/([^\s/]*)$/.exec(pre);
    if (m && (range.startContainer === el || el.contains(range.startContainer))) {
      // 仅当 "/" 出现在块首（或仅空白后）
      const rect = range.getBoundingClientRect();
      const rootRect = rootRef.current!.getBoundingClientRect();
      setSlash({
        blockId,
        query: m[2] ?? "",
        top: rect.bottom - rootRect.top + 6 + rootRef.current!.scrollTop,
        left: rect.left - rootRect.left,
        triggerOffset: m[1]!.length,
      });
      setActiveCmd(0);
    } else if (slashRef.current?.blockId === blockId) {
      setSlash(null);
    }
  }, []);

  /* ---------------- 「@」提及/引用检测（块 input 后，任意位置） ---------------- */
  // 「@」后紧贴字符（非空白）触发一次 toast 提示，避免用户敲出"未命名文档@未命名文档"无反馈
  const mentionToastShownRef = useRef<number>(0);
  const detectMention = useCallback((blockId: string) => {
    if (readOnly) return;
    const el = editableEl(blockId);
    if (!el) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      setMention(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!(range.startContainer === el || el.contains(range.startContainer))) {
      return;
    }
    const caret = range.startOffset;
    const pre =
      range.startContainer.textContent?.slice(0, caret) ?? el.textContent?.slice(0, caret) ?? "";
    // 行首或空白后输入 @，@ 后为非空白非@的检索词
    const at = /(^|\s)@([^\s@]*)$/.exec(pre);
    if (at) {
      const rect = range.getBoundingClientRect();
      // MentionPicker 为 fixed 定位，直接用视口坐标
      setMention({
        blockId,
        top: rect.bottom + 6,
        left: Math.max(8, rect.left),
      });
    } else {
      setMention((m) => (m && m.blockId === blockId ? null : m));
      // R3：紧贴非空白字符后输入 @（未触发）—— 给一次 toast 提示（1.5s 内不重复）
      const loose = /@([^\s@]*)$/.exec(pre);
      if (loose) {
        const now = Date.now();
        if (now - mentionToastShownRef.current > 1500) {
          mentionToastShownRef.current = now;
          try {
            const t = (window as unknown as { __gxToast?: (msg: string, kind: string) => void }).__gxToast;
            if (typeof t === "function") t("@ 引用需在行首或空格后输入", "hint");
          } catch {
            /* 忽略：toast 不存在时静默 */
          }
        }
      }
    }
  }, [readOnly]);

  const onBlockInput = useCallback(
    (blockId: string) => {
      // 先处理行首 markdown 快捷转换
      maybeShortcutConvert(blockId);
      syncBlock(blockId);
      // 一旦用户在空过一次后继续输入，则清除"待退出"标记，下一次 Enter 重新计为第一次
      const b = blocksRef.current.find((x) => x.id === blockId);
      if (b && (b.text ?? "").trim() !== "") {
        emptyListOnceRef.current.delete(blockId);
      }
      detectSlash(blockId);
      detectMention(blockId);
    },
    [detectSlash, detectMention, syncBlock],
  );

  /* 行首快捷转换："# " "## " "- " "1. " "> " "[ ] " "```" 等 */
  function maybeShortcutConvert(blockId: string) {
    const el = editableEl(blockId);
    if (!el) return;
    const text = el.textContent ?? "";
    const b = blocksRef.current.find((x) => x.id === blockId);
    if (!b) return;
    let match: { type: BlockType; len: number; checked?: boolean } | null = null;
    if (/^#\s$/.test(text)) match = { type: "h1", len: 2 };
    else if (/^##\s$/.test(text)) match = { type: "h2", len: 3 };
    else if (/^###\s$/.test(text)) match = { type: "h3", len: 4 };
    else if (/^####\s$/.test(text)) match = { type: "h4", len: 5 };
    else if (/^[-*+]\s$/.test(text) && b.type === "p") match = { type: "ul", len: 2 };
    else if (/^1\.\s$/.test(text) && b.type === "p") match = { type: "ol", len: 3 };
    else if (/^\[\s\]\s$/.test(text) && b.type === "p") match = { type: "task", len: 4, checked: false };
    else if (/^>\s$/.test(text) && b.type === "p") match = { type: "quote", len: 2 };
    if (match) {
      el.innerHTML = "";
      const nb = blocksRef.current.map((x) =>
        x.id === blockId ? { ...x, type: match!.type, text: "", checked: match!.checked ?? x.checked } : x,
      );
      emit(nb);
      setSlash(null);
      requestAnimationFrame(() => {
        const nel = editableEl(blockId);
        nel?.focus();
      });
    }
  }

  /* ---------------- 键盘：回车 / 退格 / 斜杠导航 ---------------- */
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // 中文输入法组词期间不拦截任何键（Enter=上屏候选词、Backspace=删拼音、方向键=选词）
    if (e.nativeEvent.isComposing) return;

    // === 修饰键快捷键（Cmd on Mac / Ctrl on Win/Linux）===
    // 平台无关 mod：e.metaKey || e.ctrlKey 等价"Cmd 或 Ctrl"，
    // 与 DrawnixCanvas.tsx:229 / KbShell.tsx:17 既有写法保持一致。
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey) {
      const key = e.key.toLowerCase();
      switch (key) {
        case "b":
          e.preventDefault();
          execInline("bold");
          return;
        case "i":
          e.preventDefault();
          execInline("italic");
          return;
        case "x":
          // 仅拦截 Cmd/Ctrl+Shift+X（删除线）；裸 Cmd/Ctrl+X 放行给浏览器原生剪切
          if (e.shiftKey) {
            e.preventDefault();
            execInline("strikeThrough");
          }
          return;
        case "e":
          e.preventDefault();
          execInline("insertHTML", "<code></code>");
          return;
        case "z": {
          e.preventDefault();
          const r = e.shiftKey ? historyRef.current.redo() : historyRef.current.undo();
          if (r) applyHistoryState(r);
          return;
        }
        case "y": {
          // 裸 Cmd/Ctrl+Y = redo；Shift+Y 不处理（与浏览器/系统约定一致）
          if (!e.shiftKey) {
            const r = historyRef.current.redo();
            if (r) {
              e.preventDefault();
              applyHistoryState(r);
            }
          }
          return;
        }
      }
    }
    // Cmd/Ctrl+Alt+N：循环切换当前块的类型（不在 mod && !e.altKey 分支里——单独拎出）
    if (mod && e.altKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      cycleBlockType();
      return;
    }
    // Alt+↑/Alt+↓：上移/下移当前块（与 macOS Finder / VS Code 一致；与跨块 ArrowUp/Down 导航不冲突，因本分支单独占 Alt）
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      moveBlock(e.key === "ArrowUp" ? -1 : 1);
      return;
    }

    const target = e.target as HTMLElement;
    // 折叠块（toggle）的 summary 是独立的 contentEditable，没有 data-editable；单独识别
    const editable = target.closest("[data-editable]") as HTMLElement | null;
    const sumEl = target.closest("[data-toggle-sum]") as HTMLElement | null;
    const blockId = editable?.dataset.editable ?? sumEl?.dataset.toggleSum ?? undefined;
    const inSummary = !!sumEl;
    const b = blockId ? blocksRef.current.find((x) => x.id === blockId) : null;

    if (slashRef.current) {
      const list = filteredCmds();
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveCmd((i) => Math.min(i + 1, list.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActiveCmd((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); const c = list[activeCmd] ?? list[0]; if (c) applyCmd(c); return; }
      if (e.key === "Escape") { e.preventDefault(); setSlash(null); return; }
    }

    // 折叠块 summary：方向键越界跳到上下块；Backspace 空时合并/退到上一块
    if (inSummary && b) {
      if (e.key === "ArrowDown") {
        const atEnd = isCaretAtEdge(target, false);
        if (atEnd) {
          e.preventDefault();
          // 落到 body（如果折叠块打开）或下一块
          const det = target.closest("details") as HTMLDetailsElement | null;
          if (det?.open) {
            requestAnimationFrame(() => editableEl(b.id)?.focus());
          } else {
            moveCaretAcross(b.id, 1);
          }
          return;
        }
      } else if (e.key === "ArrowUp") {
        const atStart = isCaretAtEdge(target, true);
        if (atStart) {
          e.preventDefault();
          moveCaretAcross(b.id, -1);
          return;
        }
      } else if (e.key === "Backspace" && (target.textContent ?? "") === "") {
        // summary 完全空：把 toggle 降级为 p（保留 text），让用户能继续编辑
        e.preventDefault();
        emit(blocksRef.current.map((x) =>
          x.id === b.id ? { ...x, type: "p", summary: "" } : x,
        ));
        requestAnimationFrame(() => editableEl(b.id)?.focus());
        return;
      } else if (e.key === "Enter" && !e.shiftKey) {
        // summary 不可换行：直接落到 body
        e.preventDefault();
        requestAnimationFrame(() => editableEl(b.id)?.focus());
        return;
      }
    }

    // 跨块方向键：文本块在边缘按 ArrowUp/ArrowDown 越界到上下可编辑块
    if (b && !inSummary && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const atEdge = isCaretAtEdge(target, e.key === "ArrowUp");
      if (atEdge) {
        e.preventDefault();
        moveCaretAcross(b.id, e.key === "ArrowUp" ? -1 : 1);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && b) {
      e.preventDefault();
      setSlash(null);
      // 在折叠块的标题上按回车：直接落焦到正文，避免分裂 summary（summary 不可换行）
      if (inSummary) {
        requestAnimationFrame(() => editableEl(b.id)?.focus());
        return;
      }
      splitBlock(b);
      return;
    }
    if (e.key === "Backspace" && b) {
      const el = target!;
      const text = el.textContent ?? "";
      const sel = window.getSelection();
      const atStart = sel && sel.isCollapsed && (sel.anchorOffset === 0 || (el.firstChild && sel.anchorNode === el && sel.anchorOffset === 0));
      if (text === "" || atStart) {
        e.preventDefault();
        mergeOrDemote(b);
        return;
      }
    }
  }

  /**
   * 判断光标是否在某 contentEditable 元素的起点/终点。
   * 用 Range API 比较 caret 位置与 Node 的 start/end 边界。
   */
  function isCaretAtEdge(el: HTMLElement, atStart: boolean): boolean {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return false;
    const probe = document.createRange();
    probe.selectNodeContents(el);
    probe.collapse(atStart);
    // 起点对比：startContainer/startOffset 一致；终点对比：endContainer/endOffset
    if (atStart) {
      return range.startContainer === probe.startContainer && range.startOffset === probe.startOffset;
    } else {
      return range.endContainer === probe.endContainer && range.endOffset === probe.endOffset;
    }
  }

  /**
   * 把光标边界归一化到「块根可编辑元素 el」的坐标。
   *
   * 背景：@成员 渲染为 <span contenteditable=false data-user>（隐藏 @[u:id|名] 协议），
   * @文档 渲染为 <a data-href>（隐藏 URL）。当 chip/链接是块的最后一个节点、光标紧贴其
   * 右侧按回车时，浏览器上报的 Selection 边界位于内层节点末端（span 的 (span,1)、
   * 或 a 内文本节点的末端字符偏移），而非块根坐标。直接拿内层边界构造分裂区间会
   * 「跨越元素边界却不含文字」，cloneContents 仍克隆外壳与属性（data-user/data-href），
   * htmlToInlineMd 据此把隐藏协议还原进新块——即「回车泄露隐藏映射」。
   *
   * 这里把内层边界逐级上提为 el.childNodes 的间隙索引，使 pre/post 在块根同一间隙切分，
   * 不再跨越包装元素。块根直接文本节点的字符偏移合法且不跨包装，保持原样（普通打字分裂）。
   */
  function caretRootPoint(el: HTMLElement, container: Node, offset: number): { node: Node; offset: number } {
    if (container === el) return { node: container, offset };
    if (container.nodeType === Node.TEXT_NODE && container.parentNode === el) {
      return { node: container, offset };
    }
    let node: Node = container;
    let local = offset;
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentNode;
      if (!parent || !el.contains(parent)) return { node: container, offset };
      const i = Array.from(parent.childNodes).indexOf(node as ChildNode);
      const len = node.textContent?.length ?? 0;
      // 文本末端 -> 该文本节点之后的间隙；起点/中间 -> 之前的间隙（中间位置落在包装内本就罕见）
      local = offset >= len ? i + 1 : i;
      node = parent;
    }
    while (node !== el) {
      const parent = node.parentNode;
      if (!parent || !el.contains(parent)) return { node: container, offset };
      const i = Array.from(parent.childNodes).indexOf(node as ChildNode);
      local = i + local;
      node = parent;
    }
    return { node: el, offset: local };
  }

  /** 回车：列表/任务续同类项；标题/引用后回正文；普通段落分裂；列表双 Enter 才退出 */
  function splitBlock(b: Block) {
    const el = editableEl(b.id)!;
    const sel = window.getSelection();
    let before = b.text ?? "";
    let after = "";
    if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0);
      // 归一化到块根坐标，避免光标紧贴 @成员 chip / @文档链接右边界时跨越包装元素泄露隐藏协议
      const cut = caretRootPoint(el, range.startContainer, range.startOffset);
      const pre = range.cloneRange();
      pre.selectNodeContents(el);
      pre.setEnd(cut.node, cut.offset);
      before = htmlToInlineMd(pre.cloneContents() as unknown as HTMLElement);
      const post = range.cloneRange();
      post.selectNodeContents(el);
      post.setStart(cut.node, cut.offset);
      after = htmlToInlineMd(post.cloneContents() as unknown as HTMLElement);
    }
    const idx = blocksRef.current.findIndex((x) => x.id === b.id);
    let nextType: BlockType = "p";
    let extra: Partial<Block> = {};
    if (b.type === "ul" || b.type === "ol") {
      // 列表双 Enter 退出：第二次 Enter 命中「空过一次」的同一块时真正退出
      if ((b.text ?? "").trim() === "") {
        if (emptyListOnceRef.current.has(b.id)) {
          // 第二次 Enter：退出列表 + 清理标记
          emptyListOnceRef.current.delete(b.id);
          nextType = "p";
        } else {
          // 第一次 Enter：标记「空过一次」，保持列表项
          emptyListOnceRef.current.add(b.id);
          const updated = blocksRef.current.map((x) => (x.id === b.id ? { ...x, text: "" } : x));
          emit(updated);
          setSlash(null);
          requestAnimationFrame(() => {
            const oel = editableEl(b.id);
            if (oel) {
              oel.innerHTML = "";
              placeCaretStart(oel);
            }
          });
          return;
        }
      } else {
        nextType = b.type;
        // 用户输入了新文字，之前的「空过一次」标记失效
        emptyListOnceRef.current.delete(b.id);
      }
    } else if (b.type === "task") {
      if ((b.text ?? "").trim() === "") {
        if (emptyListOnceRef.current.has(b.id)) {
          emptyListOnceRef.current.delete(b.id);
          nextType = "p";
        } else {
          emptyListOnceRef.current.add(b.id);
          const updated = blocksRef.current.map((x) => (x.id === b.id ? { ...x, text: "" } : x));
          emit(updated);
          setSlash(null);
          requestAnimationFrame(() => {
            const oel = editableEl(b.id);
            if (oel) {
              oel.innerHTML = "";
              placeCaretStart(oel);
            }
          });
          return;
        }
      } else {
        nextType = "task";
        extra.checked = false;
        emptyListOnceRef.current.delete(b.id);
      }
    } else if (b.type === "quote") {
      nextType = "quote";
    } else if (b.type.startsWith("h")) {
      nextType = "p";
    }
    const nb: Block = newBlock(nextType, { text: after, ...extra });
    const updated = blocksRef.current.map((x) => (x.id === b.id ? { ...x, text: before } : x));
    updated.splice(idx + 1, 0, nb);
    emit(updated);
    setSlash(null);
    requestAnimationFrame(() => {
      // 先把旧块 DOM 重置为"光标前"内容，避免焦点移出时 blur 同步读到分裂前的全文
      const oel = editableEl(b.id);
      if (oel) oel.innerHTML = inlineMdToHtml(before);
      const nel = editableEl(nb.id);
      if (nel) placeCaretStart(nel);
    });
  }

  /** 退格：空块降级/合并到上一块 */
  function mergeOrDemote(b: Block) {
    const idx = blocksRef.current.findIndex((x) => x.id === b.id);
    // 折叠块「真为空」= summary 与 text 都为空，仅 summary 空不算空
    const isBlockEmpty = b.type === "toggle"
      ? ((b.summary ?? "").trim() === "" && (b.text ?? "").trim() === "")
      : (b.text ?? "") === "";
    // 非正文的非空块先降级为正文；空块则删除并把光标接到上一块末尾
    if (!isBlockEmpty) {
      if (b.type !== "p") {
        emit(blocksRef.current.map((x) => (x.id === b.id ? { ...x, type: "p" } : x)));
        return;
      }
      return;
    }
    // 空块
    if (b.type !== "p") {
      emit(blocksRef.current.map((x) => (x.id === b.id ? { ...x, type: "p" } : x)));
      return;
    }
    if (idx === 0) return;
    const prev = blocksRef.current[idx - 1]!;
    const removed = blocksRef.current.filter((x) => x.id !== b.id);
    emit(removed);
    requestAnimationFrame(() => {
      const el = editableEl(prev.id);
      if (el) placeCaretEnd(el);
    });
  }

  /* ---------------- 原子块（预览型组件）选中 / 删除 / 越过 ---------------- */
  function deleteBlock(id: string) {
    const idx = blocksRef.current.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const removed = blocksRef.current.filter((x) => x.id !== id);
    emptyListOnceRef.current.delete(id);
    setSelectedBlockId(null);
    emit(removed);
    // 删除后把光标落到相邻可编辑块，保证用户能继续输入
    requestAnimationFrame(() => {
      const neighbor = removed[Math.min(idx, removed.length - 1)];
      const el = neighbor ? editableEl(neighbor.id) : null;
      if (el) placeCaretEnd(el);
      else rootRef.current?.focus();
    });
  }

  /** 在原子块下方插入一个空段落并聚焦，保证光标总能落到预览组件之后 */
  function insertParagraphAfter(id: string) {
    const idx = blocksRef.current.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const nb = newBlock("p", { text: "" });
    const updated = [...blocksRef.current];
    updated.splice(idx + 1, 0, nb);
    setSelectedBlockId(null);
    emit(updated);
    requestAnimationFrame(() => {
      const el = editableEl(nb.id);
      if (el) placeCaretStart(el);
    });
  }

  /**
   * 在指定块位置「正确地」插入一个占用型/原子型块：
   *  - 替换：若该位置当前是空 p（斜杠菜单触发场景），直接用 nb 顶替，不再额外补空
   *  - 插入：若目标块非空或不是 p，则在它后面插入 nb，并自动**补一个空 p 段**在 nb 后，
   *          保证光标能落到预览组件后继续输入（与媒体上传 runUpload 同源逻辑）
   *  - 前空段：若锚点位置的前一块本身就是占用型（紧贴另一个预览组件），强制补一个空 p 在前
   *
   * 返回最终 blocks 列表（供调用方继续操作；emit 已在内部完成）。
   */
  function insertBlockWithNeighbors(blockId: string, nb: Block, opts: { replaceIfEmpty?: boolean } = {}): Block[] {
    const updated = [...blocksRef.current];
    const idx = updated.findIndex((x) => x.id === blockId);
    if (idx < 0) return updated;
    const cur = updated[idx]!;
    const isCurEmpty = cur.type === "p" && (cur.text ?? "").trim() === "";
    if (opts.replaceIfEmpty !== false && isCurEmpty) {
      // 斜杠菜单在空段触发：用 nb 顶替，不补前/后空段
      updated[idx] = nb;
    } else {
      // 前空段：当前块的前一块也是占用型时补一个空 p（罕见，但保证"两个组件之间有可输入段"）
      const prev = updated[idx - 1];
      const needPrev = prev && needsEmptyPair(prev.type);
      const needNext = needsEmptyPair(nb.type);
      const inserts: Block[] = [];
      if (needPrev) inserts.push(newBlock("p", { text: "" }));
      inserts.push(nb);
      if (needNext) inserts.push(newBlock("p", { text: "" }));
      updated.splice(idx + 1, 0, ...inserts);
    }
    setSelectedBlockId(null);
    return updated;
  }

  /**
   * 在原子/占用型块的「上方」插入一个空段落并聚焦
   * - 紧贴另一个占用型块下方时也能正确插入（避免两个组件相邻）
   */
  function insertParagraphBefore(id: string) {
    const idx = blocksRef.current.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const updated = [...blocksRef.current];
    const nb = newBlock("p", { text: "" });
    updated.splice(idx, 0, nb);
    setSelectedBlockId(null);
    emit(updated);
    requestAnimationFrame(() => {
      const el = editableEl(nb.id);
      if (el) placeCaretStart(el);
    });
  }

  /** 方向键越过原子块：跳到上/下一个可编辑块 */
  function moveCaretAcross(id: string, dir: -1 | 1) {
    const idx = blocksRef.current.findIndex((x) => x.id === id);
    if (idx < 0) return;
    for (let k = idx + dir; k >= 0 && k < blocksRef.current.length; k += dir) {
      const cand = blocksRef.current[k]!;
      const el = editableEl(cand.id);
      if (el) {
        setSelectedBlockId(null);
        requestAnimationFrame(() => (dir === 1 ? placeCaretStart(el) : placeCaretEnd(el)));
        return;
      }
    }
    // 越过方向上没有可编辑块（例如末尾是媒体）：在该方向补一个空段落
    if (dir === 1) insertParagraphAfter(id);
  }

  /**
   * Alt+↑ / Alt+↓：把当前焦点所在块与上下相邻块互换位置。
   * 找不到当前块（焦点不在 contentEditable 内，如原子块）/ 已到边界则不响应。
   * 互换后重新聚焦到该块（上移→开头；下移→末尾）以保留手感的连续性。
   */
  function moveBlock(direction: -1 | 1) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const node = sel.anchorNode;
    if (!node) return;
    const editable = (node as HTMLElement).parentElement?.closest?.("[data-editable]") as HTMLElement | null;
    const id = editable?.dataset.editable;
    if (!id) return;
    const idx = blocksRef.current.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= blocksRef.current.length) return;
    const updated = [...blocksRef.current];
    const tmp = updated[idx]!;
    updated[idx] = updated[swapIdx]!;
    updated[swapIdx] = tmp;
    emit(updated);
    requestAnimationFrame(() => {
      const el = editableEl(id);
      if (!el) return;
      el.focus();
      if (direction === -1) placeCaretStart(el);
      else placeCaretEnd(el);
    });
  }

  /**
   * Cmd/Ctrl+Alt+N：循环切换当前块的类型（在常用 8 类之间循环）。
   * 与斜杠菜单对齐，避免误改列表/表格等结构化块。
   */
  const CYCLE_TYPES: BlockType[] = ["p", "h1", "h2", "h3", "ul", "ol", "task", "quote"];
  function cycleBlockType() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const node = sel.anchorNode;
    if (!node) return;
    const editable = (node as HTMLElement).parentElement?.closest?.("[data-editable]") as HTMLElement | null;
    const id = editable?.dataset.editable;
    if (!id) return;
    const cur = blocksRef.current.find((x) => x.id === id);
    if (!cur) return;
    const curIdx = CYCLE_TYPES.indexOf(cur.type);
    const nextType = CYCLE_TYPES[(curIdx + 1) % CYCLE_TYPES.length] ?? "p";
    const updated = blocksRef.current.map((x) => (x.id === id ? { ...x, type: nextType } : x));
    emit(updated);
  }

  // 原子块被选中时，在窗口层监听键盘（此时焦点不在 contentEditable 内）
  useEffect(() => {
    if (!selectedBlockId) return;
    const onKey = (e: KeyboardEvent) => {
      // 输入法组词期间的按键不处理（Enter 上屏候选词、Backspace 删拼音）
      if (e.isComposing) return;
      const id = selectedRef.current;
      if (!id) return;
      // 仅当事件目标在编辑器内（或无具体目标）才处理：
      // 否则焦点已移到侧栏输入框/弹窗/搜索框等处时，Backspace 会被这里劫持误删原子块。
      const target = e.target as Node | null;
      if (target && rootRef.current && !rootRef.current.contains(target)) return;
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        deleteBlock(id);
      } else if (e.key === "Enter") {
        e.preventDefault();
        insertParagraphAfter(id);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setSelectedBlockId(null);
      } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        moveCaretAcross(id, 1);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        moveCaretAcross(id, -1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBlockId]);

  /** 点击原子块：选中它（点内部的链接/按钮/控件不触发选中） */
  function onAtomicClick(e: React.MouseEvent, b: Block) {
    if (readOnly) return;
    if ((e.target as HTMLElement).closest("a,button,input,select,textarea,video,audio,iframe,summary")) return;
    e.preventDefault();
    setSelectedBlockId(b.id);
  }

  /** 在文档末尾追加空段落并聚焦（用于末尾是媒体块时落光标） */
  function appendParagraph() {
    const nb = newBlock("p", { text: "" });
    const updated = [...blocksRef.current, nb];
    setSelectedBlockId(null);
    emit(updated);
    requestAnimationFrame(() => {
      const el = editableEl(nb.id);
      if (el) placeCaretStart(el);
    });
  }

  /* ---------------- 右键菜单：命中探测 + 菜单项构造 ---------------- */

  /**
   * 从根容器的 onContextMenu 中：探测命中元素属于哪类菜单上下文。
   * 优先级：链接 > 表格单元格 > 折叠标题 > 提示头 > 原子块 > 文本。
   * 文本命中时还会判断选区是否塌陷（决定菜单项"加粗/斜体..."是否启用）。
   */
  function onContextMenu(e: React.MouseEvent) {
    if (readOnly) return;
    const target = e.target as HTMLElement;
    // 链接菜单（必须在文本菜单前判断，链接是文本的子集）
    const anchor = target.closest("a.md-link") as HTMLAnchorElement | null;
    if (anchor) {
      const editable = anchor.closest("[data-editable]") as HTMLElement | null;
      if (editable?.dataset.editable) {
        e.preventDefault();
        setCtxMenu({
          x: e.clientX,
          y: e.clientY,
          hit: { kind: "link", blockId: editable.dataset.editable, href: anchor.getAttribute("data-href") || anchor.getAttribute("href") || "", anchor },
        });
        return;
      }
    }
    // 表格单元格
    const cell = target.closest("td") as HTMLTableCellElement | null;
    if (cell) {
      const tbl = cell.closest("[data-block]") as HTMLElement | null;
      const blockId = tbl?.dataset.block;
      if (blockId) {
        const tr = cell.parentElement as HTMLTableRowElement;
        const rowIdx = Array.from(tr.parentElement!.children).indexOf(tr);
        // 合并单元格后 DOM td 数 < 网格列数：按前置兄弟的 colSpan 累加出网格列号
        let colIdx = 0;
        for (const sib of Array.from(tr.children)) {
          if (sib === cell) break;
          colIdx += (sib as HTMLTableCellElement).colSpan || 1;
        }
        e.preventDefault();
        setCtxMenu({
          x: e.clientX, y: e.clientY,
          hit: { kind: "table", blockId, cell: { row: rowIdx, col: colIdx } },
        });
        return;
      }
    }
    // 折叠标题
    const sumEl = target.closest("[data-toggle-sum]") as HTMLElement | null;
    if (sumEl?.dataset.toggleSum) {
      e.preventDefault();
      setCtxMenu({ x: e.clientX, y: e.clientY, hit: { kind: "toggle-sum", blockId: sumEl.dataset.toggleSum } });
      return;
    }
    // 提示头
    const calloutHead = target.closest("[data-callout-head]") as HTMLElement | null;
    if (calloutHead?.dataset.calloutHead) {
      e.preventDefault();
      setCtxMenu({ x: e.clientX, y: e.clientY, hit: { kind: "callout-head", blockId: calloutHead.dataset.calloutHead } });
      return;
    }
    // 原子块
    const atomic = target.closest("[data-atomic]") as HTMLElement | null;
    if (atomic) {
      const blockId = atomic.dataset.atomic;
      if (blockId) {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY, hit: { kind: "atomic", blockId } });
        return;
      }
    }
    // 文本（contentEditable / 任意 [data-block]）
    const editable = target.closest("[data-editable]") as HTMLElement | null;
    if (editable?.dataset.editable) {
      e.preventDefault();
      const sel = window.getSelection();
      const text = sel?.toString() ?? "";
      const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      setCtxMenu({
        x: e.clientX, y: e.clientY,
        hit: { kind: "text", blockId: editable.dataset.editable, hasSelection: !!(sel && !sel.isCollapsed), selectedText: text, range },
      });
      return;
    }
    // 不在任何已识别块上：交给浏览器默认
  }

  /** 构造文本菜单：行内格式 + 对齐 + 颜色 + 背景色 */
  function buildTextMenuItems(hit: Extract<CtxHit, { kind: "text" }>, closeRoot: () => void) {
    const cur = getBlockAlign(hit.blockId);
    // 推断当前选区的 color / background（用于 ColorPicker 当前色高亮）
    const curColor = readSelectionColor("color");
    const curBg = readSelectionColor("background");
    const items: ContextMenuItem[] = [
      {
        kind: "item", label: "加粗", icon: "bold", shortcut: "⌘B", disabled: !hit.hasSelection,
        onClick: () => { focusEditable(hit.blockId); execInline("bold"); },
      },
      {
        kind: "item", label: "斜体", icon: "italic", shortcut: "⌘I", disabled: !hit.hasSelection,
        onClick: () => { focusEditable(hit.blockId); execInline("italic"); },
      },
      {
        kind: "item", label: "删除线", icon: "strikethrough", disabled: !hit.hasSelection,
        onClick: () => { focusEditable(hit.blockId); execInline("strikeThrough"); },
      },
      {
        kind: "item", label: "高亮", icon: "sparkles", disabled: !hit.hasSelection,
        onClick: () => {
          focusEditable(hit.blockId);
          const t = hit.selectedText || "高亮";
          execInline("insertHTML", `<mark class="md-mark">${t}</mark>`);
        },
      },
      { kind: "divider" },
      {
        kind: "submenu", label: "对齐", icon: "minus", items: [
          { kind: "item", label: "居左", active: cur === undefined || cur === "left", onClick: () => setBlockAlign(hit.blockId, "left") },
          { kind: "item", label: "居中", active: cur === "center", onClick: () => setBlockAlign(hit.blockId, "center") },
          { kind: "item", label: "居右", active: cur === "right", onClick: () => setBlockAlign(hit.blockId, "right") },
        ],
      },
      {
        // 文字色：作为 submenu hover 弹出 ColorPicker，避免主菜单过长
        kind: "submenu", label: "文字色", icon: "palette", items: [
          {
            kind: "custom",
            className: "p-0",
            render: () => (
              <ColorPicker
                mode="text"
                current={curColor}
                onClose={closeRoot}
                onChange={(hex) => {
                  focusEditable(hit.blockId);
                  if (hex) applyColorToSelection("color", hex);
                }}
              />
            ),
          },
        ],
      },
      {
        // 背景色：作为 submenu hover 弹出 ColorPicker
        kind: "submenu", label: "背景色", icon: "palette", items: [
          {
            kind: "custom",
            className: "p-0",
            render: () => (
              <ColorPicker
                mode="bg"
                current={curBg}
                onClose={closeRoot}
                onChange={(hex) => {
                  focusEditable(hit.blockId);
                  if (hex == null) clearColorOnSelection("background");
                  else applyColorToSelection("background", hex);
                }}
              />
            ),
          },
        ],
      },
    ];
    return items;
  }

  /**
   * 从当前 Selection 读出 inline style 的 color 或 background-color（取第一处出现）。
   * 用于 ColorPicker 当前色高亮。
   */
  function readSelectionColor(kind: "color" | "background"): string | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const anchor = sel.anchorNode;
    if (!anchor) return null;
    let el: HTMLElement | null =
      anchor.nodeType === 1 ? (anchor as HTMLElement) : anchor.parentElement;
    while (el && el !== document.body) {
      const cs = window.getComputedStyle(el);
      const raw = kind === "color" ? cs.color : cs.backgroundColor;
      if (raw && raw !== "rgba(0, 0, 0, 0)" && raw !== "transparent") {
        return rgbToHex(raw);
      }
      el = el.parentElement;
    }
    return null;
  }

  /** 把 window.getComputedStyle 返回的 rgb()/rgba() 转 #RRGGBB 大写 hex */
  function rgbToHex(rgb: string): string | null {
    const m = rgb.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!m) return null;
    const r = Number(m[1]).toString(16).padStart(2, "0");
    const g = Number(m[2]).toString(16).padStart(2, "0");
    const b = Number(m[3]).toString(16).padStart(2, "0");
    return `#${r}${g}${b}`.toUpperCase();
  }

  /** 构造原子块菜单：删除、复制（data: URL 媒体可下载）、打开（媒体） */
  function buildAtomicMenuItems(hit: Extract<CtxHit, { kind: "atomic" }>, _closeRoot: () => void): ContextMenuItem[] {
    const b = blocksRef.current.find((x) => x.id === hit.blockId);
    const items: ContextMenuItem[] = [];
    if (b && (b.type === "image" || b.type === "video" || b.type === "audio" || b.type === "pdf" || b.type === "attachment") && b.src) {
      items.push({
        kind: "item", label: "在新窗口打开", icon: "expand",
        onClick: () => window.open(b.src, "_blank", "noopener,noreferrer"),
      });
      if (b.src.startsWith("data:") || b.src.startsWith("blob:")) {
        items.push({
          kind: "item", label: "下载到本地", icon: "download",
          onClick: () => {
            const a = document.createElement("a");
            a.href = b.src!;
            a.download = b.alt || b.name || "下载";
            document.body.appendChild(a);
            a.click();
            a.remove();
          },
        });
      }
    }
    items.push({ kind: "divider" });
    items.push({
      kind: "item", label: "删除", icon: "trash", danger: true,
      onClick: () => deleteBlock(hit.blockId),
    });
    return items;
  }

  /** 构造表格菜单：行/列插入删除、清空、合并/拆分 */
  function buildTableMenuItems(hit: Extract<CtxHit, { kind: "table" }>, _closeRoot: () => void): ContextMenuItem[] {
    const b = blocksRef.current.find((x) => x.id === hit.blockId);
    if (!b || b.type !== "table") return [];
    const rows = (b.rows ?? []).map((r) => [...r]);
    const cols = Math.max(1, ...rows.map((r) => r.length));
    const cell = hit.cell ?? { row: 0, col: 0 };
    const occ = tableOccupancy(rows, b.spans);
    // 命中格 → 锚点格坐标（合并区域内右键视为操作锚点）
    const anchorKey = occ.anchorAt[cell.row]?.[cell.col] ?? `${cell.row},${cell.col}`;
    const [ar, ac] = anchorKey.split(",").map(Number);
    const anchorSpan = b.spans?.[anchorKey];
    const isMerged = !!anchorSpan && (anchorSpan.rs > 1 || anchorSpan.cs > 1);
    const newRow = () => Array.from({ length: cols }, () => "");
    /** patch rows+spans（spans 传 undefined 表示清除全部合并） */
    const patchTable = (nextRows: string[][], nextSpans: Record<string, { rs: number; cs: number }> | undefined) => {
      patchBlock(b.id, { rows: nextRows, spans: nextSpans });
    };
    /** 合并：把 (r1,c1) 与 (r2,c2) 两格所在合并区取包围盒并成一个矩形（锚点=左上） */
    const mergeCells = (r1: number, c1: number, r2: number, c2: number) => {
      const a1 = occ.anchorAt[r1]?.[c1] ?? `${r1},${c1}`;
      const a2 = occ.anchorAt[r2]?.[c2] ?? `${r2},${c2}`;
      const [ar1, ac1] = a1.split(",").map(Number);
      const [ar2, ac2] = a2.split(",").map(Number);
      const s1 = b.spans?.[a1];
      const s2 = b.spans?.[a2];
      const rTop = Math.min(ar1, ar2), rBot = Math.max(ar1 + (s1?.rs ?? 1) - 1, ar2 + (s2?.rs ?? 1) - 1);
      const cL = Math.min(ac1, ac2), cR = Math.max(ac1 + (s1?.cs ?? 1) - 1, ac2 + (s2?.cs ?? 1) - 1);
      const rs = rBot - rTop + 1, cs = cR - cL + 1;
      if (rs < 1 || cs < 1 || (rs === 1 && cs === 1)) return;
      // 检查包围盒内所有格是否空闲（除两个参与合并的区域）——有第三个合并区挡道则放弃
      for (let r = rTop; r <= rBot; r++) {
        for (let c = cL; c <= cR; c++) {
          const k = occ.anchorAt[r]?.[c];
          if (k && k !== a1 && k !== a2 && k !== `${r},${c}`) return;
        }
      }
      const nextSpans: Record<string, { rs: number; cs: number }> = {};
      for (const [key, sp] of Object.entries(b.spans ?? {})) {
        if (key !== a1 && key !== a2) nextSpans[key] = { ...sp };
      }
      nextSpans[`${rTop},${cL}`] = { rs, cs };
      const nextRows = rows.map((r) => [...r]);
      // 内容拼接：两个旧锚点的正文并入新锚点，被覆盖格清空
      const parts = [
        (nextRows[ar1]?.[ac1] ?? "").trim(),
        (nextRows[ar2]?.[ac2] ?? "").trim(),
      ].filter(Boolean);
      if (nextRows[rTop]) nextRows[rTop]![cL] = parts.join(" ");
      for (let r = rTop; r <= rBot; r++) {
        for (let c = cL; c <= cR; c++) {
          if (r === rTop && c === cL) continue;
          if (nextRows[r]) nextRows[r]![c] = "";
        }
      }
      patchTable(nextRows, nextSpans);
    };
    /** 拆分：锚点 span 恢复 1x1，被覆盖格变可编辑空格 */
    const splitCell = () => {
      if (!b.spans) return;
      const nextSpans: Record<string, { rs: number; cs: number }> = {};
      for (const [key, sp] of Object.entries(b.spans)) {
        if (key !== anchorKey) nextSpans[key] = { ...sp };
      }
      patchTable(rows, Object.keys(nextSpans).length ? nextSpans : undefined);
    };
    // 可合并性判定（用占用图，不越界且目标格存在）
    const canMergeRight = (ac + (anchorSpan?.cs ?? 1)) < cols && ar < rows.length;
    const canMergeDown = (ar + (anchorSpan?.rs ?? 1)) < rows.length && ac < cols;
    return [
      {
        kind: "submenu", label: "插入行", icon: "plus", items: [
          { kind: "item", label: "在上方插入", onClick: () => {
            const next = [...rows];
            next.splice(cell.row, 0, newRow());
            patchTable(next, shiftTableSpans(b.spans, "row", cell.row, 1));
          } },
          { kind: "item", label: "在下方插入", onClick: () => {
            const next = [...rows];
            next.splice(cell.row + 1, 0, newRow());
            patchTable(next, shiftTableSpans(b.spans, "row", cell.row + 1, 1));
          } },
        ],
      },
      {
        kind: "submenu", label: "插入列", icon: "plus", items: [
          { kind: "item", label: "在左侧插入", onClick: () => {
            const next = rows.map((r) => { const nr = [...r]; nr.splice(cell.col, 0, ""); return nr; });
            patchTable(next, shiftTableSpans(b.spans, "col", cell.col, 1));
          } },
          { kind: "item", label: "在右侧插入", onClick: () => {
            const next = rows.map((r) => { const nr = [...r]; nr.splice(cell.col + 1, 0, ""); return nr; });
            patchTable(next, shiftTableSpans(b.spans, "col", cell.col + 1, 1));
          } },
        ],
      },
      { kind: "divider" },
      {
        kind: "submenu", label: "合并单元格", icon: "table", items: [
          { kind: "item", label: "向右合并", disabled: !canMergeRight, onClick: () => mergeCells(ar, ac, ar, ac + (anchorSpan?.cs ?? 1)) },
          { kind: "item", label: "向下合并", disabled: !canMergeDown, onClick: () => mergeCells(ar, ac, ar + (anchorSpan?.rs ?? 1), ac) },
        ],
      },
      { kind: "item", label: "拆分单元格", disabled: !isMerged, onClick: splitCell },
      { kind: "divider" },
      {
        kind: "submenu", label: "删除", icon: "trash", items: [
          { kind: "item", label: "删除当前行", danger: true, disabled: rows.length <= 1, onClick: () => {
            const next = rows.filter((_, i) => i !== cell.row);
            patchTable(next, shiftTableSpans(b.spans, "row", cell.row, -1));
          } },
          { kind: "item", label: "删除当前列", danger: true, disabled: cols <= 1, onClick: () => {
            const next = rows.map((r) => r.filter((_, i) => i !== cell.col));
            patchTable(next, shiftTableSpans(b.spans, "col", cell.col, -1));
          } },
        ],
      },
      { kind: "divider" },
      {
        kind: "item", label: "清空当前单元格", onClick: () => {
          const next = rows.map((r) => [...r]);
          if (next[ar]) next[ar]![ac] = "";
          patchTable(next, b.spans ? { ...b.spans } : undefined);
        },
      },
    ];
  }

  /** 链接菜单：编辑/复制 URL/打开/删除 */
  function buildLinkMenuItems(hit: Extract<CtxHit, { kind: "link" }>, _closeRoot: () => void): ContextMenuItem[] {
    const isSafe = isSafeUrl(hit.href);
    return [
      { kind: "item", label: "编辑链接", icon: "link", onClick: () => {
        const next = window.prompt("链接 URL", hit.href);
        if (next == null) return;
        const trimmed = next.trim();
        if (trimmed === "") {
          // 空 = 删除
          hit.anchor.outerHTML = hit.anchor.innerHTML;
          syncBlock(hit.blockId);
          return;
        }
        if (!isSafeUrl(trimmed)) {
          window.alert("链接协议不安全，已拒绝保存");
          return;
        }
        hit.anchor.setAttribute("data-href", trimmed);
        if (trimmed.startsWith("/kb") || trimmed.startsWith("/base")) {
          hit.anchor.removeAttribute("target");
          hit.anchor.setAttribute("class", "md-link md-link-internal");
        } else {
          hit.anchor.setAttribute("target", "_blank");
          hit.anchor.setAttribute("rel", "noopener noreferrer");
          hit.anchor.setAttribute("class", "md-link");
        }
        syncBlock(hit.blockId);
      } },
      { kind: "item", label: "复制链接", icon: "copy", onClick: () => {
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(hit.href).catch(() => {});
      } },
      { kind: "item", label: "在新窗口打开", icon: "expand", disabled: !isSafe, onClick: () => window.open(hit.href, "_blank", "noopener,noreferrer") },
      { kind: "divider" },
      { kind: "item", label: "移除链接", icon: "trash", danger: true, onClick: () => {
        hit.anchor.outerHTML = hit.anchor.innerHTML;
        syncBlock(hit.blockId);
      } },
    ];
  }

  /** 折叠标题菜单：删除折叠块 */
  function buildToggleMenuItems(hit: Extract<CtxHit, { kind: "toggle-sum" }>, _closeRoot: () => void): ContextMenuItem[] {
    return [
      { kind: "item", label: "删除折叠块", icon: "trash", danger: true, onClick: () => deleteBlock(hit.blockId) },
    ];
  }

  /** 提示块头菜单：改类型 / 删除 */
  function buildCalloutMenuItems(hit: Extract<CtxHit, { kind: "callout-head" }>, _closeRoot: () => void): ContextMenuItem[] {
    const b = blocksRef.current.find((x) => x.id === hit.blockId);
    if (!b || b.type !== "callout") return [];
    return [
      {
        kind: "submenu", label: "切换类型", icon: "sparkles",
        items: CALLOUT_VARIANTS.map((v) => ({
          kind: "item" as const,
          label: v === "note" ? "提示" : v === "tip" ? "技巧" : v === "warning" ? "注意" : v === "important" ? "重要" : "警告",
          active: b.variant === v,
          onClick: () => patchBlock(b.id, { variant: v }),
        })),
      },
      { kind: "divider" },
      { kind: "item", label: "删除提示块", icon: "trash", danger: true, onClick: () => deleteBlock(hit.blockId) },
    ];
  }

  /** 选区已经塌陷时，"加粗/斜体/..." 应先聚焦到 hit.blockId 让 execInline 找到光标 */
  function focusEditable(blockId: string) {
    const el = editableEl(blockId);
    el?.focus();
  }

  function buildCtxItems(hit: CtxHit, closeRoot: () => void): ContextMenuItem[] {
    switch (hit.kind) {
      case "text": return buildTextMenuItems(hit, closeRoot);
      case "atomic": return buildAtomicMenuItems(hit, closeRoot);
      case "table": return buildTableMenuItems(hit, closeRoot);
      case "link": return buildLinkMenuItems(hit, closeRoot);
      case "toggle-sum": return buildToggleMenuItems(hit, closeRoot);
      case "callout-head": return buildCalloutMenuItems(hit, closeRoot);
    }
  }

  /** 原子块统一包装：点击选中、蓝色高亮、悬浮删除按钮 */
  function atomicWrap(b: Block, node: React.ReactNode) {
    const selected = selectedBlockId === b.id;
    return (
      <div
        key={b.id}
        data-atomic={b.id}
        contentEditable={false}
        className={`kb-wy-atomic${selected ? " is-selected" : ""}`}
        onClick={(e) => onAtomicClick(e, b)}
      >
        {node}
        {selected && !readOnly && (
          <button
            type="button"
            className="kb-wy-atomic-del"
            title="删除（Delete / Backspace）"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => { e.stopPropagation(); deleteBlock(b.id); }}
          >
            <Icon name="trash" size={13} />
          </button>
        )}
      </div>
    );
  }

  /* ---------------- 斜杠命令应用 ---------------- */
  const filteredCmds = useCallback((): WCmd[] => {
    const q = (slashRef.current?.query ?? "").toLowerCase();
    if (!q) return CMDS;
    return CMDS.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.keywords.toLowerCase().includes(q) ||
        c.desc.toLowerCase().includes(q),
    );
  }, []);

  /**
   * 斜杠菜单仅在"空块行首输入 /query"时触发（detectSlash 正则锚定块首、且光标前只有
   * 空白 + / + 查询词），因此选中命令后该块除触发文本外无正文，直接清空即可。
   */
  function removeSlashTrigger(blockId: string) {
    const el = editableEl(blockId);
    if (el) el.innerHTML = "";
    const b = blocksRef.current.find((x) => x.id === blockId);
    if (b) b.text = "";
  }

  function applyCmd(cmd: WCmd) {
    const st = slashRef.current;
    if (!st) return;
    const b = blocksRef.current.find((x) => x.id === st.blockId);
    if (!b) { setSlash(null); return; }
    removeSlashTrigger(b.id);

    if (cmd.kind === "type" && cmd.blockType) {
      const target = cmd.blockType;
      const after = blocksRef.current.map((x) =>
        x.id === b.id ? { ...x, type: target, text: "", checked: target === "task" ? false : x.checked } : x,
      );
      emit(after);
      setSlash(null);
      requestAnimationFrame(() => editableEl(b.id)?.focus());
    } else if (cmd.kind === "wrap" && cmd.wrap) {
      // 斜杠下的行内包裹（空块场景）：插入带占位的格式 DOM
      wrapInline(cmd.wrap[0], cmd.wrap[1], cmd.id === "link");
      setSlash(null);
    } else if (cmd.kind === "insert" && cmd.insert) {
      insertBlockAfter(b.id, cmd.insert);
      setSlash(null);
    } else if (cmd.kind === "media" && cmd.media) {
      uploadKind.current = cmd.media;
      uploadAnchorRef.current = b.id;
      setSlash(null);
      fileRef.current?.click();
    } else if (cmd.kind === "image" || cmd.kind === "file") {
      uploadKind.current = cmd.kind === "image" ? "image" : "file";
      uploadAnchorRef.current = b.id;
      setSlash(null);
      fileRef.current?.click();
    } else if (cmd.kind === "entity") {
      entityBlockRef.current = b.id;
      setSlash(null);
      setPickerOpen(true);
    }
  }

  /** 实体选择器回调：把内部链接以 Markdown 链接形式写入目标块 */
  function onEntityPick(e: PickedEntity) {
    const href = internalHref(e.target);
    const blockId = entityBlockRef.current;
    const updated = [...blocksRef.current];
    const blk = blockId ? updated.find((x) => x.id === blockId) : undefined;
    if (blk) {
      blk.text = (blk.text ? blk.text.replace(/\s*$/, "") + " " : "") + `[${e.title}](${href})`;
    } else {
      updated.push(newBlock("p", { text: `[${e.title}](${href})` }));
      updated.push(newBlock("p", { text: "" }));
    }
    emit(updated);
    entityBlockRef.current = null;
    setPickerOpen(false);
  }

  /**
   * 「@」面板选择：把触发词替换为成员/文档/画布片段。
   * 关键：点击面板项时焦点在面板搜索框，contentEditable 块已失焦——不能依赖 window.getSelection()
   * 操作活动 DOM。改为纯 state 更新（emit 改 block.text / 插块），Editable 失焦态会自动把
   * innerHTML 同步为 inlineMdToHtml(text)。只写一次，不手动覆写 DOM，避免双写竞态重复。
   */
  function onMentionPick(snippet: string, isCanvasEmbed = false) {
    const st = mention;
    setMention(null);
    if (!st) return;
    const blockId = st.blockId;
    const blk = blocksRef.current.find((x) => x.id === blockId);
    if (!blk) return;

    // 触发块当前文本（syncBlock 在输入时已实时回写 b.text）去掉行尾 "@检索词"
    const stripped = (blk.text ?? "").replace(/(^|\s)@[^\s@]*$/, "$1").replace(/\u00A0/g, " ");

    if (isCanvasEmbed) {
      // 画布内嵌：去触发词 + 结构化 code(canvas-embed) 块插入其后 + 紧跟可编辑 spacer p
      // 修复 #2：插入完成后立刻把焦点与光标落到新 spacer p，用户可继续向下输入无需手动点击。
      const docId = snippet.replace(/^\s*```canvas-embed\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
      const cur = blocksRef.current.map((x) => (x.id === blockId ? { ...x, text: stripped } : x));
      const idx = cur.findIndex((x) => x.id === blockId);
      if (idx < 0) return;
      const isCurEmpty = cur[idx]!.type === "p" && (cur[idx]!.text ?? "").trim() === "";
      const embedBlock = newBlock("code", { lang: "canvas-embed", code: docId });
      const spacer = newBlock("p", { text: "" });
      let final: Block[];
      if (isCurEmpty) {
        final = [...cur.slice(0, idx), embedBlock, spacer, ...cur.slice(idx + 1)];
      } else {
        final = [...cur.slice(0, idx + 1), embedBlock, spacer, ...cur.slice(idx + 1)];
      }
      emit(final);
      // 同步把焦点落到新 spacer p 块的尾部（rAF 等 React commit 完再操作 DOM，避开竞态）
      requestAnimationFrame(() => {
        const spacerEl = rootRef.current?.querySelector(`[data-editable="${spacer.id}"]`) as HTMLElement | null;
        if (spacerEl) {
          spacerEl.focus();
          placeCaretEnd(spacerEl);
        }
      });
      return;
    }

    // 成员/文档引用：行内片段追加到当前块（成员 @[u:..] / 文档 [标题](链接)）
    const needsSpace = stripped.length > 0 && !/[ \n]$/.test(stripped);
    const newText = stripped + (needsSpace ? " " : "") + snippet;
    emit(blocksRef.current.map((x) => (x.id === blockId ? { ...x, text: newText } : x)));
    // 修复 #1：原本走 requestIdleCallback 触发 placeCaretAfterBlock，但 Editable 在
    // 聚焦态 useEffect 不会把新的 inlineMdToHtml 同步到 innerHTML，导致操作的是旧 DOM
    // → 光标落点在错误位置 / 看起来在页面宽度末尾。改为：emit 后立即同步 innerHTML
    // 并同步落光标，跳过 setTimeout/idleCallback（用户点击 picker 期间没有浏览器渲染
    // 抖动风险，不再需要延迟）。
    const el = editableEl(blockId);
    if (!el) return;
    // 与 Editable useEffect 的同一路径生成 html，避免下次 re-render 触发覆写
    el.innerHTML = inlineMdToHtml(newText);
    placeCaretAfterBlock(el);
  }

  function wrapInline(a: string, b: string, isLink: boolean) {
    // 直接对选区包一层真实格式 DOM，序列化时由 htmlToInlineMd 转回 markdown 符号
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const selected = range.toString();
    const blockEl = (range.commonAncestorContainer as HTMLElement).nodeType === 1
      ? (range.commonAncestorContainer as HTMLElement).closest("[data-editable]") as HTMLElement | null
      : (range.commonAncestorContainer.parentElement?.closest("[data-editable]") as HTMLElement | null);
    if (!blockEl) return;
    const blockId = blockEl.dataset.editable!;

    let el: HTMLElement;
    if (isLink) {
      const aEl = document.createElement("a");
      aEl.className = "md-link";
      aEl.setAttribute("data-href", "https://");
      aEl.textContent = selected || "链接文字";
      el = aEl;
    } else {
      const tag = a === "**" ? "strong" : a === "*" ? "em" : a === "~~" ? "del" : a === "`" ? "code" : "mark";
      el = document.createElement(tag);
      if (tag === "code") el.className = "md-code-inline";
      if (tag === "mark") el.className = "md-mark";
      el.textContent = selected || (tag === "code" ? "代码" : "文字");
    }
    range.deleteContents();
    range.insertNode(el);
    // 选中新插入节点便于继续输入/替换
    const r2 = document.createRange();
    r2.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(r2);
    syncBlock(blockId);
    // 触发一次轻量 setState 以保证 Editable 外部状态一致（不重写聚焦块 DOM）
    const md = blockEl.textContent ?? "";
    setBlocks((prev) => prev.map((x) => (x.id === blockId ? { ...x, text: htmlToInlineMd(blockEl) || md } : x)));
    historyRef.current.push(blocksRef.current);
    onChange(blocksToMd(blocksRef.current));
  }

  function insertBlockAfter(blockId: string, type: BlockType) {
    let nb: Block;
    if (type === "code") nb = newBlock("code", { lang: "", code: "" });
    else if (type === "table")
      nb = newBlock("table", {
        rows: [
          ["列 1", "列 2", "列 3"],
          ["内容", "内容", "内容"],
          ["内容", "内容", "内容"],
        ],
      });
    else if (type === "math") nb = newBlock("math", { formula: "" });
    else if (type === "hr") nb = newBlock("hr");
    else if (type === "pagebreak") nb = newBlock("pagebreak");
    else if (type === "toggle") nb = newBlock("toggle", { summary: "折叠块", text: "" });
    else if (type === "callout") nb = newBlock("callout", { variant: "note", text: "提示内容" });
    else nb = newBlock("p");
    const updated = insertBlockWithNeighbors(blockId, nb, { replaceIfEmpty: true });
    emit(updated);
    requestAnimationFrame(() => {
      // 优先尝试容器 data-focus 焦点（code/math/table 内部 textarea/input）
      const el = rootRef.current?.querySelector(`[data-focus="${nb.id}"]`) as HTMLElement | null;
      if (el) {
        el.focus();
        return;
      }
      // 否则聚焦自动补出的空段（保证光标立刻落在新组件之后可继续输入）
      const idx = updated.findIndex((x) => x.id === nb.id);
      const tail = updated[idx + 1];
      const tailEl = tail ? editableEl(tail.id) : null;
      tailEl?.focus();
    });
  }

  /* ---------------- 文件上传 ---------------- */
  function patchUpload(id: string, patch: Partial<UploadTask>) {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  }
  function removeUpload(id: string) {
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }

  /** 读取文件并插入媒体块；供首次上传与失败重试共用 */
  async function runUpload(task: UploadTask) {
    patchUpload(task.id, { status: "reading", progress: 0, error: undefined });
    setUploading(true);
    try {
      const url = await fileToDataUrlProgress(task.file, (pct) =>
        patchUpload(task.id, { progress: pct }),
      );
      const safe = task.file.name.replace(/[\[\]()<>]/g, "_");
      let nb: Block;
      if (task.kind === "image") nb = newBlock("image", { src: url, alt: safe });
      else if (task.kind === "video") nb = newBlock("video", { src: url, alt: safe });
      else if (task.kind === "audio") nb = newBlock("audio", { src: url, alt: safe });
      else if (task.kind === "pdf") nb = newBlock("pdf", { src: url, alt: safe });
      else nb = newBlock("attachment", { src: url, name: safe });

      // 落点：优先插到触发上传的锚点块之后（斜杠菜单/工具栏），没有锚点才追加到文档末尾
      const anchorId = uploadAnchorRef.current;
      uploadAnchorRef.current = null;
      const list = anchorId
        ? insertBlockWithNeighbors(anchorId, nb, { replaceIfEmpty: true })
        : [...blocksRef.current, nb, newBlock("p", { text: "" })];
      // 若追加到末尾且前一块也是占用型，补前空段
      let finalList = list;
      if (!anchorId && finalList.length >= 2) {
        const prev = finalList[finalList.length - 2]!;
        if (prev && needsEmptyPair(prev.type)) {
          finalList = [...finalList.slice(0, finalList.length - 2), newBlock("p", { text: "" }), prev, nb, newBlock("p", { text: "" })];
        }
      }
      emit(finalList);
      // 焦点落到 nb 后自动补的空段
      const idx = finalList.findIndex((x) => x.id === nb.id);
      const tail = finalList[idx + 1];
      setFocusedId(tail ? tail.id : nb.id);
      requestAnimationFrame(() => {
        if (tail) editableEl(tail.id)?.focus();
      });
      removeUpload(task.id);
    } catch (err) {
      patchUpload(task.id, {
        status: "error",
        error: err instanceof Error ? err.message : "文件读取失败",
      });
    } finally {
      setUploading(false);
    }
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const entry = uploadKind.current;
    // 明确入口优先；图片/附件入口则按文件类型自动识别
    const detected = mediaKindOf(file);
    const media: UploadTask["kind"] =
      entry === "video" || entry === "audio" || entry === "pdf" ? entry : detected;
    // 按知识库设置中的上传限制校验大小与格式（系统默认 + 用户补充）
    const limitError = validateUpload(media, file, loadUploadLimits());
    if (limitError) {
      window.alert(limitError);
      return;
    }
    uploadSeq.current += 1;
    const task: UploadTask = {
      id: `up-${Date.now()}-${uploadSeq.current}`,
      kind: media,
      name: file.name,
      sizeLabel: humanSize(file.size),
      progress: 0,
      status: "reading",
      file,
    };
    setUploads((prev) => [...prev, task]);
    void runUpload(task);
  }

  /* ---------------- 工具栏：行内格式 ---------------- */
  function execInline(cmd: "bold" | "italic" | "strikeThrough" | "insertHTML", html?: string) {
    rootRef.current?.focus();
    if (cmd === "insertHTML" && html !== undefined) {
      document.execCommand("insertHTML", false, html);
    } else {
      document.execCommand(cmd, false);
    }
    // 同步受影响块
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    const el = (node as HTMLElement | null)?.parentElement?.closest?.("[data-editable]") as HTMLElement | null;
    if (el?.dataset.editable) syncBlock(el.dataset.editable);
  }

  /**
   * 把指定 RGB 字符串 sanitize 成 6 位大写 hex：仅允许 #[0-9a-fA-F]{3,8}。
   * 用于右键菜单的文字色/背景色：拒绝任意用户输入进入内联 style，杜绝 CSS 注入。
   */
  function safeColor(c: string): string {
    const m = /^#([0-9a-fA-F]{3,8})$/.exec(c.trim());
    if (!m) return "#000000";
    let h = m[1]!;
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length === 4) h = h.split("").map((c) => c + c).join(""); // #RGBA -> #RRGGBBAA
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length !== 6) return "#000000";
    return `#${h.toUpperCase()}`;
  }

  /**
   * 对当前选区应用文字色/背景色：检测选区是否塌陷，塌陷时无操作。
   * 选区不塌陷时，用 Range.extractContents + 包 span + range.insertNode 重新插入。
   * 这样比 document.execCommand('foreColor') 跨浏览器更稳定（execCommand 已被现代浏览器标记 deprecated）。
   */
  function applyColorToSelection(kind: "color" | "background", hex: string) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const root = rootRef.current?.querySelector(`[data-editable][data-focused="true"]`) as HTMLElement | null
      || (range.commonAncestorContainer as HTMLElement).parentElement?.closest?.("[data-editable]") as HTMLElement | null;
    if (!root) {
      // 选区不在 contentEditable 内，放弃
      return;
    }
    const blockId = root.dataset.editable!;
    // 提取选区内容、用 span 包裹后插回
    const wrapper = document.createElement("span");
    wrapper.style[kind === "color" ? "color" : "backgroundColor"] = safeColor(hex);
    try {
      wrapper.appendChild(range.extractContents());
      range.insertNode(wrapper);
    } catch {
      // 跨多节点选区失败：退化为逐段 wrap
      const texts = sel.toString();
      if (texts) wrapper.textContent = texts;
      range.deleteContents();
      range.insertNode(wrapper);
    }
    // 重新选中插入的 wrapper 内
    const r2 = document.createRange();
    r2.selectNodeContents(wrapper);
    sel.removeAllRanges();
    sel.addRange(r2);
    syncBlock(blockId);
  }

  /**
   * 对当前选区清除文字色/背景色：把命中 span 的 style 去掉
   * 选区不塌陷时遍历选区内的 span，移除对应 style；塌陷时无操作。
   */
  function clearColorOnSelection(kind: "color" | "background") {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const root = (range.commonAncestorContainer as HTMLElement).parentElement?.closest?.("[data-editable]") as HTMLElement | null;
    if (!root) return;
    const blockId = root.dataset.editable!;
    const spanTag = kind === "color" ? "span[style*='color']" : "span[style*='background']";
    root.querySelectorAll(spanTag).forEach((el) => {
      const e = el as HTMLElement;
      if (range.intersectsNode(e)) {
        e.style.removeProperty(kind === "color" ? "color" : "background-color");
        if (!e.getAttribute("style")) e.removeAttribute("style");
      }
    });
    syncBlock(blockId);
  }

  /**
   * 块级对齐（left/center/right）：通过设置最近 [data-editable] 祖先的 style.textAlign
   * 用 inline style 持久化：序列化时由 htmlToInlineMd 抽取并在段落块上挂 data-align
   * 为简化实现，对齐存储在 Block 的 align 字段上（不入 markdown text），与样式独立。
   */
  function setBlockAlign(blockId: string, align: "left" | "center" | "right" | null) {
    emit(blocksRef.current.map((x) => (x.id === blockId ? { ...x, align } : x)));
  }

  function getBlockAlign(blockId: string): "left" | "center" | "right" | undefined {
    const b = blocksRef.current.find((x) => x.id === blockId);
    return b?.align ?? undefined;
  }

  /* ---------------- 渲染 ---------------- */
  const editableNode = (b: Block, className?: string) => (
    <Editable
      blockId={b.id}
      html={inlineMdToHtml(b.text ?? "")}
      readOnly={readOnly}
      focused={focusedId === b.id}
      isComposing={isComposingState}
      className={`kb-wy-editable${className ? " " + className : ""}`}
      onInput={onBlockInput}
      onFocus={(id) => setFocusedId(id)}
      onBlur={(id) => {
        syncBlock(id);
        // 失焦时清理「空过一次」标记：再次聚焦后第一次 Enter 重新计为第一次
        emptyListOnceRef.current.delete(id);
        setFocusedId((cur) => (cur === id ? null : cur));
        setSlash(null);
      }}
    />
  );

  /**
   * 文本类块（p/h 标题/quote/callout/toggle）的外层 div：把 align 应用到 inline style。
   * editableNode 内部用 contentEditable 接管光标，inline style 设在外层不会影响 contentEditable 内部输入。
   */
  const alignStyle = (b: Block): React.CSSProperties =>
    b.align && b.align !== "left" ? { textAlign: b.align } : {};

  const renderBlock = (b: Block, i: number) => {
    switch (b.type) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const Tag = b.type as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
        // B3: 标题锚点 id 用 slugify(text)（基于文本内容稳定生成，不随块 id 变化）
        // 这样复制锚点链接后再访问，URL hash 仍能命中——与 markdown.ts 中的 h1-h6 渲染一致。
        const headingId = `h-${slugify(b.text || "")}`;
        // 同 doc 内文本相同就用同一 id（追加 -N 区分重名）
        const sameTextCount = blocks.slice(0, i).reduce((acc, x) => acc + (x.type?.startsWith("h") && x.text === b.text ? 1 : 0), 0);
        const finalHeadingId = sameTextCount > 0 ? `${headingId}-${sameTextCount}` : headingId;
        return (
          <Tag
            key={b.id}
            data-block={b.id}
            data-heading-id={finalHeadingId}
            className={`kb-wy-block kb-wy-${b.type}`}
            style={alignStyle(b)}
          >
            {editableNode(b)}
            {/* 锚点复制按钮：hover 显示，点击复制 URL 到剪贴板 */}
            <button
              type="button"
              className="md-heading-anchor"
              title="复制锚点链接"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const base = window.location.origin + window.location.pathname;
                navigator.clipboard.writeText(`${base}#${finalHeadingId}`).then(
                  () => toast("已复制标题锚点链接", "success"),
                  () => toast("复制失败，请手动复制", "error"),
                );
              }}
            >
              <Icon name="link" size={13} />
            </button>
          </Tag>
        );
      }
      case "ul":
        return (
          <div key={b.id} data-block={b.id} className="kb-wy-block kb-wy-li kb-wy-ul" style={alignStyle(b)}>
            <span className="kb-wy-marker">•</span>
            {editableNode(b)}
          </div>
        );
      case "ol": {
        let n = 1;
        for (let k = i - 1; k >= 0 && blocks[k]!.type === "ol"; k--) n++;
        return (
          <div key={b.id} data-block={b.id} className="kb-wy-block kb-wy-li kb-wy-ol" style={alignStyle(b)}>
            <span className="kb-wy-marker">{n}.</span>
            {editableNode(b)}
          </div>
        );
      }
      case "task":
        return (
          <div key={b.id} data-block={b.id} className="kb-wy-block kb-wy-li kb-wy-task" style={alignStyle(b)}>
            <input
              type="checkbox"
              className="kb-wy-check"
              checked={!!b.checked}
              disabled={readOnly}
              onChange={() => patchBlock(b.id, { checked: !b.checked })}
            />
            {editableNode(b, b.checked ? "kb-wy-done" : "")}
          </div>
        );
      case "quote":
        return (
          <blockquote key={b.id} data-block={b.id} className="kb-wy-block kb-wy-quote" style={alignStyle(b)}>
            {editableNode(b)}
          </blockquote>
        );
      case "code":
        // 画布内嵌块（```canvas-embed + docId）：渲染为可交互画布预览卡片，而非代码框
        if (b.lang === "canvas-embed") {
          const canvasDocId = (b.code ?? "").trim();
          if (canvasDocId) {
            return (
              <div key={b.id} data-block={b.id} className="kb-wy-block kb-wy-canvas-embed" contentEditable={false}>
                <CanvasEmbed docId={canvasDocId} kbId={kbId} canEdit={!readOnly} onNavigate={(p) => navigate(p)} />
                {!readOnly && (
                  <button
                    type="button"
                    className="kb-wy-embed-del"
                    title="移除画布引用"
                    contentEditable={false}
                    onClick={(e) => { e.stopPropagation(); deleteBlock(b.id); }}
                  >
                    <Icon name="close" size={13} />
                  </button>
                )}
              </div>
            );
          }
        }
        return (
          <div key={b.id} data-block={b.id} className="kb-wy-block kb-wy-code" data-focus={b.id} tabIndex={-1}>
            <div className="kb-wy-code-bar">
              <input
                className="kb-wy-code-lang"
                value={b.lang ?? ""}
                placeholder="语言"
                readOnly={readOnly}
                onChange={(e) => patchBlock(b.id, { lang: e.target.value })}
              />
            </div>
            <textarea
              className="kb-wy-code-area"
              value={b.code ?? ""}
              readOnly={readOnly}
              spellCheck={false}
              placeholder={"输入代码…"}
              onChange={(e) => patchBlock(b.id, { code: e.target.value })}
            />
          </div>
        );
      case "hr":
        return atomicWrap(b, <hr data-block={b.id} className="kb-wy-block kb-wy-hr" />);
      case "pagebreak":
        return atomicWrap(
          b,
          <div data-block={b.id} className="kb-wy-block kb-wy-pagebreak">
            <div className="kb-wy-pagebreak-line" />
            <span className="kb-wy-pagebreak-label">分页符</span>
            <div className="kb-wy-pagebreak-line" />
          </div>,
        );
      case "image":
        return atomicWrap(
          b,
          <figure data-block={b.id} className="kb-wy-block kb-wy-image">
            {b.src ? <img src={b.src} alt={b.alt ?? ""} className="md-img" /> : <div className="kb-wy-img-empty">图片</div>}
            {b.alt ? <figcaption className="kb-wy-cap">{b.alt}</figcaption> : null}
          </figure>,
        );
      case "video":
        return atomicWrap(
          b,
          <figure data-block={b.id} className="kb-wy-block kb-wy-media">
            {b.src ? (
              <video src={b.src} controls preload="metadata" className="kb-wy-video" />
            ) : <div className="kb-wy-img-empty">视频</div>}
            <figcaption className="kb-wy-cap">{b.alt ?? "视频"}</figcaption>
          </figure>,
        );
      case "audio":
        return atomicWrap(
          b,
          <figure data-block={b.id} className="kb-wy-block kb-wy-media kb-wy-audio-card">
            <span className="kb-wy-media-icon"><Icon name="audio" size={22} /></span>
            {b.src ? <audio src={b.src} controls preload="metadata" className="kb-wy-audio" /> : <div className="kb-wy-img-empty">音频</div>}
            <figcaption className="kb-wy-cap">{b.alt ?? "音频"}</figcaption>
          </figure>,
        );
      case "pdf":
        return atomicWrap(
          b,
          <figure data-block={b.id} className="kb-wy-block kb-wy-media kb-wy-pdf-card">
            {b.src ? (
              <>
                <iframe className="kb-wy-pdf" src={b.src} title={b.alt ?? "PDF 文档"} />
                <figcaption className="kb-wy-cap">
                  <a href={b.src} target="_blank" rel="noreferrer" className="md-link" onClick={(e) => e.stopPropagation()}>在新窗口打开：{b.alt ?? "PDF 文档"}</a>
                </figcaption>
              </>
            ) : <div className="kb-wy-img-empty">PDF</div>}
          </figure>,
        );
      case "attachment":
        return atomicWrap(
          b,
          <div data-block={b.id} className="kb-wy-block kb-wy-attach">
            <span className="kb-wy-attach-icon"><Icon name="file" size={20} /></span>
            <span className="kb-wy-attach-name">{b.name ?? "附件"}</span>
            {b.src ? (
              <a className="kb-wy-attach-dl" href={b.src} download={b.name} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>下载</a>
            ) : null}
          </div>,
        );
      case "toggle":
        return (
          <details key={b.id} data-block={b.id} className="kb-wy-block kb-wy-toggle" open style={alignStyle(b)}>
            <summary className="kb-wy-toggle-sum" contentEditable={!readOnly} suppressContentEditableWarning
              data-toggle-sum={b.id}
              onBlur={(e) => {
                // 用最新 blocksRef 拼出 next，再写入并 emit；
                // 直接读 blocksRef.current 调 onChange 会因 setBlocks 还未提交而写入过期快照
                const v = e.currentTarget.textContent ?? "";
                const next = (blocksRef.current as Block[]).map((x) =>
                  x.id === b.id ? { ...x, summary: v } : x,
                );
                setBlocks(next);
                historyRef.current.push(next);
                onChange(blocksToMd(next));
              }}
              onKeyDown={(e) => {
                // 折叠块 summary 内方向键越界跳到 body
                if (e.nativeEvent.isComposing) return;
                if (e.key === "ArrowDown" && isCaretAtEdge(e.currentTarget, false)) {
                  e.preventDefault();
                  requestAnimationFrame(() => editableEl(b.id)?.focus());
                } else if (e.key === "ArrowUp" && isCaretAtEdge(e.currentTarget, true)) {
                  e.preventDefault();
                  moveCaretAcross(b.id, -1);
                }
              }}
            >{b.summary || "折叠块"}</summary>
            <div className="kb-wy-toggle-body">
              <Editable
                blockId={b.id}
                html={inlineMdToHtml(b.text ?? "")}
                readOnly={readOnly}
                focused={focusedId === b.id}
                isComposing={isComposingState}
                className="kb-wy-editable kb-wy-toggle-editable"
                onInput={onBlockInput}
                onFocus={(id) => setFocusedId(id)}
                onBlur={(id) => { syncBlock(id); setSlash(null); setFocusedId(null); }}
              />
            </div>
          </details>
        );
      case "callout": {
        const variants: Record<string, string> = {
          note: "提示", tip: "技巧", warning: "注意", important: "重要", caution: "警告",
        };
        const v = b.variant ?? "note";
        return (
          <div key={b.id} data-block={b.id} data-callout-head={b.id} className={`kb-wy-block kb-wy-callout kb-wy-callout-${v}`} style={alignStyle(b)}>
            <div className="kb-wy-callout-head">
              <span className="kb-wy-callout-title">{variants[v] ?? v}</span>
              {!readOnly && (
                <select
                  className="kb-wy-callout-type"
                  value={v}
                  onChange={(e) => patchBlock(b.id, { variant: e.target.value as CalloutVariant })}
                >
                  <option value="note">提示</option>
                  <option value="tip">技巧</option>
                  <option value="warning">注意</option>
                  <option value="important">重要</option>
                  <option value="caution">警告</option>
                </select>
              )}
            </div>
            <Editable
              blockId={b.id}
              html={inlineMdToHtml(b.text ?? "")}
              readOnly={readOnly}
              focused={focusedId === b.id}
              isComposing={isComposingState}
              className="kb-wy-editable kb-wy-callout-editable"
              onInput={onBlockInput}
              onFocus={(id) => setFocusedId(id)}
              onBlur={(id) => { syncBlock(id); setSlash(null); setFocusedId(null); }}
            />
          </div>
        );
      }
      case "math":
        return (
          <div key={b.id} data-block={b.id} className="kb-wy-block kb-wy-math" data-focus={b.id} tabIndex={-1}>
            <div className="kb-wy-math-label">公式</div>
            <textarea
              className="kb-wy-math-area"
              value={b.formula ?? ""}
              readOnly={readOnly}
              spellCheck={false}
              placeholder={"输入 LaTeX 公式，例如 E = mc^2"}
              onChange={(e) => patchBlock(b.id, { formula: e.target.value })}
            />
          </div>
        );
      case "table": {
        const rows = b.rows ?? [];
        const occ = tableOccupancy(rows, b.spans);
        return (
          <div key={b.id} data-block={b.id} className="kb-wy-block kb-wy-table-wrap" data-focus={b.id} tabIndex={-1}>
            <table className="md-table kb-wy-table">
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => {
                      // 被合并覆盖的格不渲染 td（由锚点格的 rowSpan/colSpan 顶位）
                      if (occ.anchorAt[ri]?.[ci] !== `${ri},${ci}`) return null;
                      const sp = b.spans?.[`${ri},${ci}`];
                      const spanProps = sp && (sp.rs > 1 || sp.cs > 1)
                        ? { colSpan: sp.cs, rowSpan: sp.rs }
                        : {};
                      return (
                        <td key={ci} className={ri === 0 ? "kb-wy-th" : ""} {...spanProps}>
                          <input
                            value={cell}
                            readOnly={readOnly}
                            onChange={(e) => {
                              const next = (b.rows ?? []).map((r) => [...r]);
                              next[ri]![ci] = e.target.value;
                              patchBlock(b.id, { rows: next });
                            }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {!readOnly && (
              <div className="kb-wy-table-actions">
                <button type="button" onClick={() => {
                  const rows2 = (b.rows ?? []).map((r) => [...r]);
                  rows2.push(Array.from({ length: rows2[0]?.length ?? 3 }, () => "内容"));
                  patchBlock(b.id, { rows: rows2 });
                }}>+ 行</button>
                <button type="button" onClick={() => {
                  const rows2 = (b.rows ?? []).map((r) => [...r, "内容"]);
                  patchBlock(b.id, { rows: rows2 });
                }}>+ 列</button>
              </div>
            )}
          </div>
        );
      }
      case "raw":
        return <div key={b.id} data-block={b.id} className="kb-wy-block kb-wy-raw">{b.raw}</div>;
      case "p":
      default:
        return (
          <div key={b.id} data-block={b.id} className="kb-wy-block kb-wy-p" style={alignStyle(b)}>
            {editableNode(b)}
          </div>
        );
    }
  };

  /**
   * 在占用型/原子型块（callout/toggle/code/math/table/image/...）前后包一层透明可点击热区，
   * 用户在组件上下空白处点击即插入一个空段落并聚焦，避免光标被卡在组件内无法前后编辑。
   *
   * 设计要点：
   *  - 热区是一个细高（~6px）的 div，hover 出现淡蓝色横线作为视觉提示（与拖放手柄风格统一）
   *  - onMouseDown + preventDefault：避免点热区时把当前焦点状态搞乱
   *  - 已在两个块之间有可编辑段时**不**重复包热区（避免视觉噪音）
   */
  const renderBlockWithZones = (b: Block, i: number) => {
    const node = renderBlock(b, i);
    if (!needsEmptyPair(b.type)) return node;
    const prev = blocks[i - 1];
    const next = blocks[i + 1];
    // 紧邻的块已经可编辑（p/h*/list...）则不需要在那一侧补热区
    const showPrevZone = !!prev && needsEmptyPair(prev.type);
    const showNextZone = !!next && needsEmptyPair(next.type);
    // 始终在文档末尾的占用型块后补一个 next zone，便于继续输入
    const isLast = i === blocks.length - 1;
    const isFirst = i === 0;
    return (
      <Fragment key={`zone-${b.id}`}>
        {(showPrevZone || isFirst) && (
          <div
            className="kb-wy-prev-zone"
            data-zone-before={b.id}
            contentEditable={false}
            onMouseDown={(e) => { e.preventDefault(); insertParagraphBefore(b.id); }}
          />
        )}
        {node}
        {(showNextZone || isLast) && (
          <div
            className="kb-wy-next-zone"
            data-zone-after={b.id}
            contentEditable={false}
            onMouseDown={(e) => { e.preventDefault(); insertParagraphAfter(b.id); }}
          />
        )}
      </Fragment>
    );
  };

  const list = slash ? CMDS.filter(
    (c) =>
      !slash.query ||
      c.title.toLowerCase().includes(slash.query.toLowerCase()) ||
      c.keywords.toLowerCase().includes(slash.query.toLowerCase()) ||
      c.desc.toLowerCase().includes(slash.query.toLowerCase()),
  ) : [];

  return (
    <div className="kb-wy">
      <input ref={fileRef} type="file" style={{ display: "none" }} onChange={onFilePicked}
        accept="image/*,video/*,audio/*,.pdf,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv" />
      <EntityPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={onEntityPick} />

      {!readOnly && (
        <div className="kb-md-toolbar">
          <button type="button" className="kb-md-btn" title="加粗" onMouseDown={(e) => e.preventDefault()} onClick={() => execInline("bold")}><Icon name="bold" size={15} /></button>
          <button type="button" className="kb-md-btn" title="斜体" onMouseDown={(e) => e.preventDefault()} onClick={() => execInline("italic")}><Icon name="italic" size={15} /></button>
          <button type="button" className="kb-md-btn" title="删除线" onMouseDown={(e) => e.preventDefault()} onClick={() => execInline("strikeThrough")}><Icon name="strikethrough" size={15} /></button>
          <button type="button" className="kb-md-btn" title="高亮" onMouseDown={(e) => e.preventDefault()} onClick={() => execInline("insertHTML", "<mark class='md-mark'>" + (window.getSelection()?.toString() || "高亮") + "</mark>")}><Icon name="sparkles" size={15} /></button>
          <button type="button" className="kb-md-btn" title="行内代码" onMouseDown={(e) => e.preventDefault()} onClick={() => { const t = window.getSelection()?.toString() || "代码"; execInline("insertHTML", `<code class="md-code-inline">${t.replace(/`/g, "'")}</code>`); }}><Icon name="code" size={15} /></button>
          <button type="button" className="kb-md-btn" title="链接" onMouseDown={(e) => e.preventDefault()} onClick={() => { const t = window.getSelection()?.toString() || "链接文字"; execInline("insertHTML", `<a class="md-link" data-href="https://">${t}</a>`); }}><Icon name="link" size={15} /></button>
          <span className="kb-rich-sep" />
          <button type="button" className="kb-md-btn" title="上传图片" onMouseDown={(e) => e.preventDefault()} onClick={() => { uploadKind.current = "image"; uploadAnchorRef.current = focusedIdRef.current; fileRef.current?.click(); }}><Icon name="image" size={15} /></button>
          <button type="button" className="kb-md-btn" title="上传附件" onMouseDown={(e) => e.preventDefault()} onClick={() => { uploadKind.current = "file"; uploadAnchorRef.current = focusedIdRef.current; fileRef.current?.click(); }}><Icon name="paperclip" size={15} /></button>
          <span className="kb-md-hint">输入 / 唤起插入菜单 · 回车新建块 · 行首 # 空格 快捷排版</span>
          <span className="kb-rich-spacer" />
          {uploading && <span className="kb-md-uploading">上传中…</span>}
        </div>
      )}
      <div
        ref={rootRef}
        className="kb-wy-scroll"
        onKeyDown={onKeyDown}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onContextMenu={onContextMenu}
        onClick={(e) => {
          // 内部/外部链接：点击即导航（contentEditable 默认吞掉链接点击，这里显式委托）。
          // Cmd/Ctrl+点击或直接点击链接文字都跳转；点链接外区域仍正常落光标。
          // 内部链接走 resolveLink 异步校验：已删除/无权限时 chip 视觉降级 + toast 异常，
          // 拒绝跳转。外部 http(s) 直接外链打开，不做权限管控。
          const anchor = (e.target as HTMLElement).closest("a.md-link") as HTMLAnchorElement | null;
          if (anchor) {
            const href = anchor.getAttribute("data-href") || anchor.getAttribute("href") || "";
            if (href) {
              e.preventDefault();
              if (href.startsWith("/kb") || href.startsWith("/base")) {
                void resolveLink(href).then((res) => {
                  if (!res.ok) {
                    // 视觉降级：保留文本（不删除），加 CSS 类变灰+删除线/锁图标，鼠标悬浮保持原标题
                    anchor.classList.remove("md-link-broken", "md-link-forbidden");
                    anchor.classList.add(res.kind === "forbidden" ? "md-link-forbidden" : "md-link-broken");
                    if (res.toast) toast(res.toast, "error");
                    return;
                  }
                  // 校验通过：清除历史降级类（之前可能误标）
                  anchor.classList.remove("md-link-broken", "md-link-forbidden");
                  navigate(href);
                });
              } else if (/^https?:\/\//i.test(href)) {
                window.open(href, "_blank", "noopener,noreferrer");
              }
              return;
            }
          }
          // B3: 粘贴降级为伪纯文本的锚点 span（md-anchor-pasted）—— 点击走 resolveLink 跳转
          const pasted = (e.target as HTMLElement).closest(".md-anchor-pasted") as HTMLElement | null;
          if (pasted) {
            const path = pasted.dataset.href ?? "";
            const anchor = pasted.dataset.anchor ?? "";
            if (path) {
              e.preventDefault();
              const target = `${path}#${anchor}`;
              void resolveLink(path).then((res) => {
                if (!res.ok) {
                  pasted.classList.add("md-link-broken");
                  if (res.toast) toast(res.toast, "error");
                  return;
                }
                pasted.classList.remove("md-link-broken");
                navigate(target);
              });
              return;
            }
          }
          // 点到可编辑文本块：取消原子块选中
          if ((e.target as HTMLElement).closest("[data-editable]")) {
            setSelectedBlockId(null);
            return;
          }
          // 点到文档末尾空白区：若末尾是原子块（无法在其后落光标），补一个空段落并聚焦
          const last = blocksRef.current[blocksRef.current.length - 1];
          if (last && ATOMIC_TYPES.has(last.type) && (e.target as HTMLElement).closest(".kb-wy-doc")) {
            appendParagraph();
          }
        }}
      >
        <div
          className="kb-wy-doc"
          onPaste={(e) => {
            // B3: 粘贴锚点 URL → 降级为伪纯文本（看起来是标题文字，可点击跳转）
            // 例：https://.../kb/:kb/doc/:id?#h-abc123
            const text = e.clipboardData?.getData("text/plain") ?? "";
            // 匹配"绝对URL + #h-xxxxx" 或 "/kb/...?#h-xxxxx"（同时兼容裸 # 与 ?# 两种 fragment 形式）
            // 注：WysiwygEditor 复制锚点时用的是裸 `${base}#${id}`，但历史上也用过 `${base}?#${id}` 形式
            const m = /^(?:https?:\/\/[^\s]+)?(\/kb\/[^/?#]+\/(?:doc|canvas)\/[^?#]+)(?:\?)?(#[a-z0-9\u4e00-\u9fff\-]+)$/i.exec(text.trim());
            if (!m) return; // 走原生粘贴
              e.preventDefault();
              const path = m[1]!;
              const anchor = m[2]!.slice(1); // 去掉 "#" 前缀，得到 "h-xxxxx"
            // 1) 异步取目标标题——拉一次文档接口
            void resolveLink(path).then((res) => {
              if (!res.ok) {
                toast(res.toast || "目标不可访问", "error");
                return;
              }
              const fallback = anchor;
              // 修复 #3b：必须从 Zustand store 取 token（window.__gxAuth 在生产代码中从未赋值，
              // 之前 fetch 永远无 Authorization → 401 → 文档拉不到 → title 退化为 anchor 字符串）
              const token = useAuthStore.getState().token;
              const headers: Record<string, string> = authHeaders(token);
              const docIdMatch = /\/kb\/[^/]+\/(?:doc|canvas)\/([^/?#]+)/.exec(path);
              const docId = docIdMatch?.[1];
              if (!docId) {
                const bid = insertAnchorPastedSpan(path, anchor, fallback);
                if (bid) syncBlock(bid);
                return;
              }
              fetch(withBase(`/api/kb/docs/${docId}`), { headers })
                .then((r) => r.ok ? r.json() : null)
                .then((doc) => {
                  // 修复 #3b (round 3)：后端响应是 { doc: { content, title, ... } }，旧代码误读为 doc.content
                  // 导致取不到 markdown → extractHeadingText 始终空 → title 退化为 anchor 字符串
                  const md = doc?.doc?.content ?? "";
                  const title = extractHeadingText(md, anchor) || fallback;
                  const bid = insertAnchorPastedSpan(path, anchor, title);
                  if (bid) syncBlock(bid);
                })
                .catch(() => {
                  const bid = insertAnchorPastedSpan(path, anchor, fallback);
                  if (bid) syncBlock(bid);
                });
            });
          }}
        >
          {blocks.map(renderBlockWithZones)}
          {blocks.length === 0 && <div className="kb-wy-block kb-wy-p" />}

          {/* 上传占位层：进度条 / 失败重试（不进入 Markdown，完成后由真实媒体块替换） */}
          {uploads.map((u) => (
            <div key={u.id} className={`kb-wy-upload${u.status === "error" ? " is-error" : ""}`}>
              <span className="kb-wy-upload-icon">
                <Icon name={u.kind === "image" ? "image" : u.kind === "video" ? "video" : u.kind === "audio" ? "audio" : u.kind === "pdf" ? "file" : "paperclip"} size={20} />
              </span>
              <span className="kb-wy-upload-body">
                <span className="kb-wy-upload-name">
                  {u.name}
                  <span className="kb-wy-upload-size">{u.sizeLabel}</span>
                </span>
                {u.status === "reading" ? (
                  <>
                    <span className="kb-wy-upload-bar">
                      <span className="kb-wy-upload-fill" style={{ width: `${u.progress}%` }} />
                    </span>
                    <span className="kb-wy-upload-hint">正在读取文件… {u.progress}%</span>
                  </>
                ) : (
                  <span className="kb-wy-upload-hint kb-wy-upload-err">
                    上传失败：{u.error ?? "文件读取失败"}
                  </span>
                )}
              </span>
              {u.status === "error" ? (
                <span className="kb-wy-upload-actions">
                  <button type="button" className="kb-wy-upload-retry" onClick={() => void runUpload(u)}>
                    <Icon name="refresh" size={14} /> 重试
                  </button>
                  <button type="button" className="kb-wy-upload-cancel" onClick={() => removeUpload(u.id)}>
                    <Icon name="close" size={14} />
                  </button>
                </span>
              ) : (
                <button type="button" className="kb-wy-upload-cancel" onClick={() => removeUpload(u.id)} title="取消">
                  <Icon name="close" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>

        {slash && list.length > 0 && (
          <div ref={slashMenuRef} className="kb-slash-menu kb-wy-slash" style={{ top: slash.top, left: slash.left }}>
            <div className="kb-slash-title">插入内容</div>
            {list.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className={`kb-slash-item${i === activeCmd ? " active" : ""}`}
                onMouseDown={(e) => { e.preventDefault(); applyCmd(c); }}
                onMouseEnter={() => setActiveCmd(i)}
              >
                <span className="kb-slash-icon"><Icon name={c.icon} size={16} /></span>
                <span className="kb-slash-text">
                  <span className="kb-slash-name">{c.title}</span>
                  <span className="kb-slash-desc">{c.desc}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 右键菜单：受控浮层，由 onContextMenu 触发，命中类型决定菜单项 */}
      <ContextMenu
        open={!!ctxMenu}
        x={ctxMenu?.x ?? 0}
        y={ctxMenu?.y ?? 0}
        items={ctxMenu ? buildCtxItems(ctxMenu.hit, closeCtxMenu) : []}
        onClose={closeCtxMenu}
      />

      {/* 「@」跨文档引用 / 成员提及面板（fixed 视口定位） */}
      {mention && kbId && (
        <MentionPicker
          kbId={kbId}
          currentDocId={docId}
          pos={{ top: mention.top, left: mention.left }}
          onPick={onMentionPick}
          onClose={() => setMention(null)}
        />
      )}
    </div>
  );
}

/* ---------------- 选区工具 ---------------- */
/**
 * 空 contenteditable（零子节点）即使 Range 有效，Chrome 也不绘制 caret——
 * 元素内没有任何行盒可供光标落脚。从 contentEditable=false 且 mousedown preventDefault
 * 的悬停热区、原子块等「编辑器外部」程序化 focus 进空段落时必现：选区有效、敲键能写，
 * 就是看不到闪烁光标。
 *
 * 修法：补一个 <br> 作为可渲染锚点（contenteditable 空行的标准占位）。
 * 不污染保存：htmlToInlineMd 中 <br> → "\n"，外层 .trim() 把孤立 <br> 归一为空串；
 * 失焦后 Editable 的 DOM 同步 effect（innerHTML !== ""）会覆写回零子节点，自动自愈。
 */
function ensureCaretAnchor(el: HTMLElement) {
  if (el.childNodes.length === 0) {
    el.appendChild(document.createElement("br"));
  }
}
/** 选区当前是否落在 el 内（折叠态也成立） */
function isSelectionInside(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const node = sel.getRangeAt(0).startContainer;
  return el === node || el.contains(node);
}
/**
 * 落 caret 后再用一帧确认：从悬停热区等 contentEditable=false 入口程序化聚焦空段落时，
 * Editable 的 DOM 同步 effect（focused 状态生效前那一帧）可能把我们补的 <br> 用空 html 覆写掉。
 * 第二帧时该块已处于 focused（effect 不再覆写），若锚点被清空/选区漂走则重新补锚并落位，
 * 保证空段落稳定出现闪烁 caret。用户若已在块内开始打字（产生文本节点）则不打断。
 */
function reaffirmCaret(el: HTMLElement, atStart: boolean) {
  const reanchor = () => {
    const sel = window.getSelection();
    const anchored = isSelectionInside(el) && el.childNodes.length > 0;
    if (anchored) return;
    ensureCaretAnchor(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(atStart);
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  // 连续两帧确认：第一帧可能早于 React 提交 focused 状态（Editable 同步 effect 尚未放弃覆写），
  // 第二帧时 focus 引发的重渲染已落地、effect 已因 focused=true 跳过，此时再校准一次可稳定显示 caret。
  requestAnimationFrame(() => {
    reanchor();
    requestAnimationFrame(reanchor);
  });
}
function placeCaretStart(el: HTMLElement) {
  el.focus();
  ensureCaretAnchor(el);
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  reaffirmCaret(el, true);
}
function placeCaretEnd(el: HTMLElement) {
  el.focus();
  ensureCaretAnchor(el);
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  reaffirmCaret(el, false);
}

/**
 * B3: 粘贴锚点 URL → 在光标处插入伪纯文本 span（点击跳转）。
 * 视觉上是标题文本，但渲染为虚线下划线 + cursor pointer。
 */
function insertAnchorPastedSpan(path: string, anchor: string, title: string): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const span = document.createElement("span");
  span.className = "md-anchor-pasted";
  span.dataset.href = path;
  span.dataset.anchor = anchor;
  span.textContent = title;
  range.insertNode(span);
  // 光标移到 span 之后
  const r2 = document.createRange();
  r2.setStartAfter(span);
  r2.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r2);
  // 返回 span 所属的 data-editable blockId，由调用方直接 syncBlock。
  // 修复 #2 验证 Bug-B：原代码派发非冒泡 blur（new Event("blur", {bubbles:false})），
  // React 18 用 focusout 代理 onBlur，非冒泡 blur 不触发 syncBlock → 粘贴后 state 永远落后 → autosave 丢链接。
  const editable = span.closest("[data-editable]") as HTMLElement | null;
  return editable?.dataset.editable ?? null;
}

/**
 * B3: 从 markdown 中按 anchor id 找对应标题的纯文本。
 * anchor 形如 "h-第一章-概述"（WysiwygEditor 与 markdown.ts 用同一 slugify），
 * 需与 markdown 中"## 第一章 概述"经 slugify 的产物匹配；同文本追加 -N 后缀。
 */
function extractHeadingText(md: string, anchor: string): string | null {
  const targetSlug = anchor.replace(/^h-/, "");
  if (!targetSlug) return null;
  // 局部 slugify：与 markdown.ts / WysiwygEditor 同步（中英文 + 数字 + 小写 + 去标点 + 空格转 -）
  const slugify = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[\u2000-\u206f\u2e00-\u2e7f'!"#$%&()*+,./:;<=>?@\[\]^`{|}~]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 40) || "untitled";
  const lines = md.split("\n");
  const seen = new Map<string, number>();
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) continue;
    const text = m[2]!;
    const baseSlug = slugify(text);
    const count = seen.get(baseSlug) ?? 0;
    seen.set(baseSlug, count + 1);
    const candidate = count === 0 ? baseSlug : `${baseSlug}-${count}`;
    if (candidate === targetSlug) return text;
  }
  return null;
}

/**
 * 把光标放到块根最后一个非空白 childNode 之后的间隙（不进入 contenteditable=false 子元素内部）。
 * 用于 @ 提及 / @ 文档 插入后：chip/链接常是块内最后一个节点，
 * placeCaretEnd 会让浏览器把光标吸附到 chip 内部（contenteditable=false），
 * 看上去消失。这里跳到块根末间隙，光标"在 chip 之后"，可继续输入。
 */
function placeCaretAfterBlock(el: HTMLElement) {
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  const nodes = Array.from(el.childNodes);
  let idx = nodes.length;
  // 跳过尾随空白文本节点（同步 contenteditable 末尾可能插入的零宽节点）
  while (
    idx > 0 &&
    nodes[idx - 1].nodeType === Node.TEXT_NODE &&
    /^\s*$/.test((nodes[idx - 1] as Text).data)
  ) {
    idx--;
  }
  range.setStart(el, idx);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}
