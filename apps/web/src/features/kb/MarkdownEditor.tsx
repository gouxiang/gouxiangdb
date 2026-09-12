// apps/web/src/features/kb/MarkdownEditor.tsx
// 知识库文档编辑器：三种状态
//   - 编辑（默认，所见即所得）：块级语法视觉映射（# 变大标题、- 变圆点、> 变引用条、``` 变代码框、
//     | 变表格、--- 变分割线），块内粗/斜/删/码/高亮/链接以真实格式呈现；输入 "/" 唤起插入菜单。
//   - 源码：纯 Markdown textarea，高级用户直接写语法，输入 "/" 同样唤起斜杠命令。
//   - 预览：只读渲染最终效果。
// 三态共享同一份 Markdown，切换无损。资源类（图片/附件）走文件选择 → data URL 内嵌自动插入。

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Icon, type IconName } from "../../components/icons";
import { EntityPicker, type PickedEntity } from "../../components/EntityPicker";
import { internalHref } from "../../lib/internal-links";
import { renderMarkdown } from "./markdown";
import { mediaKindOf } from "./blocks";
import { loadUploadLimits, validateUpload } from "./upload-limits";
import { makeLinkClickHandler } from "../../lib/internal-links";
import { WysiwygEditor } from "./WysiwygEditor";
import { MentionPicker } from "./MentionPicker";
import { enhanceCanvasEmbeds } from "./enhanceEmbeds";
import "./kb.css";

/* ---------------- 文件 → data URL ---------------- */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}
/* ---------------- 斜杠命令（源码态） ---------------- */
interface SlashCmd {
  id: string;
  title: string;
  desc: string;
  icon: IconName;
  keywords: string;
  kind: "prefix" | "wrap" | "block" | "image" | "file" | "media" | "entity";
  prefix?: string;
  wrap?: [string, string];
  block?: string;
  media?: "video" | "audio" | "pdf";
}
const SLASH_CMDS: SlashCmd[] = [
  { id: "h1", title: "标题 1", desc: "# 一级标题", icon: "text", keywords: "h1 heading biaoti 标题 大标题", kind: "prefix", prefix: "# " },
  { id: "h2", title: "标题 2", desc: "## 二级标题", icon: "text", keywords: "h2 heading 标题", kind: "prefix", prefix: "## " },
  { id: "h3", title: "标题 3", desc: "### 三级标题", icon: "text", keywords: "h3 标题", kind: "prefix", prefix: "### " },
  { id: "h4", title: "标题 4", desc: "#### 四级标题", icon: "text", keywords: "h4 标题", kind: "prefix", prefix: "#### " },
  { id: "bold", title: "加粗", desc: "**粗体文字**", icon: "bold", keywords: "bold 加粗 cu", kind: "wrap", wrap: ["**", "**"] },
  { id: "italic", title: "斜体", desc: "*斜体文字*", icon: "italic", keywords: "italic 斜体 xie", kind: "wrap", wrap: ["*", "*"] },
  { id: "strike", title: "删除线", desc: "~~文字~~", icon: "strikethrough", keywords: "strike 删除线 shanchu", kind: "wrap", wrap: ["~~", "~~"] },
  { id: "mark", title: "高亮", desc: "==高亮文字==", icon: "sparkles", keywords: "mark highlight 高亮 gaoliang", kind: "wrap", wrap: ["==", "=="] },
  { id: "code-inline", title: "行内代码", desc: "`code`", icon: "code", keywords: "inline code 行内代码 daima", kind: "wrap", wrap: ["`", "`"] },
  { id: "ul", title: "无序列表", desc: "- 列表项", icon: "list", keywords: "ul bullet 无序 列表 liebiao", kind: "prefix", prefix: "- " },
  { id: "ol", title: "有序列表", desc: "1. 列表项", icon: "list", keywords: "ol ordered number 有序 列表", kind: "prefix", prefix: "1. " },
  { id: "task", title: "待办清单", desc: "- [ ] 待办项", icon: "check", keywords: "todo task 待办 daiban", kind: "prefix", prefix: "- [ ] " },
  { id: "quote", title: "引用", desc: "> 引用内容", icon: "quote", keywords: "quote 引用 yinyong", kind: "prefix", prefix: "> " },
  { id: "code", title: "代码块", desc: "``` 代码块", icon: "code", keywords: "code block fence 代码块", kind: "block", block: "```js\n// 在这里输入代码\nconsole.log(\"hello\");\n```" },
  { id: "math", title: "数学公式", desc: "$$ 公式块", icon: "hash", keywords: "math formula 公式 gongshi latex", kind: "block", block: "$$\nE = mc^2\n$$" },
  { id: "table", title: "表格", desc: "插入 Markdown 表格", icon: "table", keywords: "table 表格 biaoge", kind: "block", block: "| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n| 内容 | 内容 | 内容 |" },
  { id: "hr", title: "分割线", desc: "---", icon: "minus", keywords: "hr divider 分割线 fengexian", kind: "block", block: "---" },
  { id: "pagebreak", title: "分页符", desc: "打印/导出时分页", icon: "minus", keywords: "pagebreak 分页 fenye 分页符", kind: "block", block: '<div class="kb-page-break"></div>' },
  { id: "toggle", title: "折叠块", desc: "可展开/收起的内容块", icon: "chevronRight", keywords: "toggle details 折叠 zhedie 折叠块", kind: "block", block: "<details>\n<summary>折叠块标题</summary>\n\n折叠内容\n\n</details>" },
  { id: "callout", title: "提示块", desc: "高亮提示信息", icon: "sparkles", keywords: "callout note alert 提示 tishi 提示块", kind: "block", block: "> [!NOTE]\n> 提示内容" },
  { id: "link", title: "链接", desc: "[文字](https://...)", icon: "link", keywords: "link url 链接 lianjie", kind: "wrap", wrap: ["[", "](https://)"] },
  { id: "image", title: "图片", desc: "上传图片并插入", icon: "image", keywords: "image picture 图片 tupian 上传", kind: "image" },
  { id: "video", title: "视频", desc: "上传视频并内嵌播放", icon: "video", keywords: "video 视频 shipin mp4 上传", kind: "media", media: "video" },
  { id: "audio", title: "音频", desc: "上传音频并内嵌播放", icon: "audio", keywords: "audio 音频 yinpin mp3 录音 上传", kind: "media", media: "audio" },
  { id: "pdf", title: "嵌入 PDF", desc: "上传 PDF 并内嵌预览", icon: "file", keywords: "pdf 文档 wendang 嵌入 上传", kind: "media", media: "pdf" },
  { id: "file", title: "附件", desc: "上传文件并插入下载卡片", icon: "paperclip", keywords: "file attachment 附件 fujian 上传", kind: "file" },
  { id: "link-doc", title: "链接到文档/画布", desc: "插入知识库文档或画布内部链接", icon: "link", keywords: "link doc 文档 画布 链接 内部 关联", kind: "entity" },
  { id: "link-table", title: "链接到数据表", desc: "插入一张数据表的内部链接", icon: "table", keywords: "link table 数据表 链接 内部 关联", kind: "entity" },
];

interface Sel { start: number; end: number; }
function applyEdit(value: string, _sel: Sel, edit: { replaceStart: number; replaceEnd: number; text: string; cursorOffset?: number }) {
  const next = value.slice(0, edit.replaceStart) + edit.text + value.slice(edit.replaceEnd);
  const pos = edit.cursorOffset != null ? edit.replaceStart + edit.cursorOffset : edit.replaceStart + edit.text.length;
  return { value: next, sel: { start: pos, end: pos } };
}
function lineRange(value: string, pos: number) {
  const start = value.lastIndexOf("\n", pos - 1) + 1;
  let end = value.indexOf("\n", pos);
  if (end === -1) end = value.length;
  return { start, end, text: value.slice(start, end) };
}

type Mode = "wysiwyg" | "source" | "preview";

export function MarkdownEditor({
  initialMarkdown,
  onChange,
  onSave,
  readOnly = false,
  publicToken,
  docId,
}: {
  initialMarkdown: string;
  onChange: (md: string) => void;
  /**
   * 立即云端保存（Cmd/Ctrl+S）。由 DocEditorPage 透传 `persist.saveNow()`；
   * SourceEditor 内的 Ctrl+S 拦截会调用它，避免与 DocEditorPage 顶层 useShortcuts 双触发。
   */
  onSave?: () => void | Promise<void>;
  readOnly?: boolean;
  /** 公开分享页传入：嵌入画布走匿名 PublicApi */
  publicToken?: string;
  /** 当前编辑文档 id——@ picker 排除自身引用 */
  docId?: string;
}) {
  const [md, setMd] = useState(initialMarkdown);
  const [mode, setMode] = useState<Mode>(readOnly ? "preview" : "wysiwyg");
  const navigate = useNavigate();
  const { kbId } = useParams();
  const onLinkClick = useCallback(makeLinkClickHandler((p) => navigate(p)), [navigate]);
  const mdRef = useRef(md);
  mdRef.current = md;
  const previewRef = useRef<HTMLDivElement>(null);

  // 预览模式：把画布内嵌占位增强为可交互预览器
  // C-3：cleanup 由 enhanceCanvasEmbeds 返回（unmount 独立 root），切换模式/文档变更时执行
  useEffect(() => {
    if (mode !== "preview" || !previewRef.current) return;
    return enhanceCanvasEmbeds(previewRef.current, {
      kbId,
      canEdit: !readOnly,
      publicToken,
      onNavigate: (p) => navigate(p),
    });
  }, [mode, md, kbId, readOnly, publicToken, navigate]);

  const emit = useCallback((v: string) => { setMd(v); onChange(v); }, [onChange]);

  /* 切换模式：只读用户固定预览 */
  const switchMode = (m: Mode) => {
    if (readOnly) { setMode("preview"); return; }
    setMode(m);
  };

  return (
    <div className="kb-md">
      {/* 三态切换 + 提示条（只读/外链查看时隐藏，只读用户不应看到编辑/源码入口） */}
      {!readOnly && (
      <div className="kb-md-toolbar">
        <div className="kb-mode-switch" role="tablist">
          <button type="button" className={mode === "wysiwyg" ? "active" : ""} onClick={() => switchMode("wysiwyg")} title="所见即所得编辑">
            <Icon name="edit" size={13} /> 编辑
          </button>
          <button type="button" className={mode === "source" ? "active" : ""} onClick={() => switchMode("source")} title="Markdown 源码">
            <Icon name="code" size={13} /> 源码
          </button>
          <button type="button" className={mode === "preview" ? "active" : ""} onClick={() => switchMode("preview")} title="只读预览">
            <Icon name="eye" size={13} /> 预览
          </button>
        </div>
        <span className="kb-rich-sep" />
        <span className="kb-md-hint">
          {mode === "wysiwyg" && "所见即所得：输入 / 插入内容，行首 # 空格 快捷排版"}
          {mode === "source" && "Markdown 源码：输入 / 唤起命令，可直接书写语法"}
          {mode === "preview" && "只读预览，展示最终渲染效果"}
        </span>
        <span className="kb-rich-spacer" />
      </div>
      )}

      {mode === "wysiwyg" && (
        <WysiwygEditor key="wy" initialMarkdown={md} onChange={emit} readOnly={readOnly} docId={docId} />
      )}
      {mode === "source" && (
        <SourceEditor value={md} onChange={emit} onSave={onSave} readOnly={readOnly} kbId={kbId} />
      )}
      {mode === "preview" && (
        <div className="kb-md-preview-scroll">
          <div
            ref={previewRef}
            className="md-preview kb-md-preview"
            onClick={onLinkClick}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(md) || "<p style='color:#888780'>暂无内容</p>" }}
          />
        </div>
      )}
    </div>
  );
}

/* ---------------- 源码态编辑器（textarea + 斜杠命令 + 上传） ---------------- */
function SourceEditor({
  value,
  onChange,
  onSave,
  readOnly,
  kbId,
}: {
  value: string;
  onChange: (md: string) => void;
  /** 立即云端保存（Cmd/Ctrl+S）。来自 DocEditorPage → MarkdownEditor 透传。 */
  onSave?: () => void | Promise<void>;
  readOnly: boolean;
  kbId?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const [uploading, setUploading] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashPos, setSlashPos] = useState({ top: 40, left: 24 });
  const [slashRange, setSlashRange] = useState<{ trigger: number } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionPos, setMentionPos] = useState({ top: 40, left: 24 });
  const [mentionRange, setMentionRange] = useState<{ trigger: number } | null>(null);
  const [activeCmd, setActiveCmd] = useState(0);
  // 斜杠菜单容器：键盘上下选择时高亮项自动滚动到可视区域
  const slashMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!slashOpen) return;
    slashMenuRef.current
      ?.querySelector<HTMLElement>(`.kb-slash-item.active`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeCmd, slashOpen, slashQuery]);

  const emit = (v: string) => onChange(v);
  const setSelection = (sel: Sel) =>
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(sel.start, sel.end);
    });

  const caretCoords = (): { top: number; left: number } => {
    const ta = taRef.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror) return { top: 40, left: 24 };
    const style = window.getComputedStyle(ta);
    const props = ["boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderWidth", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "whiteSpace", "wordWrap", "wordBreak", "tabSize"] as const;
    for (const p of props) mirror.style.setProperty(p, style.getPropertyValue(p));
    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.wordWrap = "break-word";
    mirror.style.width = style.width;
    const pos = ta.selectionStart ?? 0;
    mirror.textContent = valueRef.current.slice(0, pos);
    const span = document.createElement("span");
    span.textContent = valueRef.current.slice(pos) || ".";
    mirror.appendChild(span);
    const taRect = ta.getBoundingClientRect();
    const wrapRect = ta.parentElement?.getBoundingClientRect() ?? taRect;
    const top = span.offsetTop - ta.scrollTop + (taRect.top - wrapRect.top);
    const left = span.offsetLeft - ta.scrollLeft + (taRect.left - wrapRect.left);
    return { top: top + 20, left };
  };

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    emit(v);
    if (readOnly) return;
    const pos = e.target.selectionStart ?? v.length;
    const line = lineRange(v, pos);
    const m = /^(\s*)\/([^\s/]*)$/.exec(line.text.slice(0, pos - line.start));
    const at = /(^|\s)@([^\s@]*)$/.exec(line.text.slice(0, pos - line.start));
    if (m) {
      setSlashRange({ trigger: line.start + m[1]!.length });
      setSlashQuery(m[2] ?? "");
      setSlashPos(caretCoords());
      setSlashOpen(true);
      setActiveCmd(0);
    } else if (slashOpen) {
      setSlashOpen(false);
    }
    if (at) {
      const ta = taRef.current;
      const wrapRect = ta?.parentElement?.getBoundingClientRect();
      const c = caretCoords();
      setMentionRange({ trigger: line.start + (at.index ?? 0) + (at[1] ? 1 : 0) });
      setMentionPos({ top: (wrapRect?.top ?? 0) + c.top + 26, left: (wrapRect?.left ?? 0) + c.left });
      setMentionOpen(true);
    } else if (mentionOpen) {
      setMentionOpen(false);
    }
  }

  const filtered = SLASH_CMDS.filter(
    (c) =>
      !slashQuery ||
      c.title.toLowerCase().includes(slashQuery.toLowerCase()) ||
      c.keywords.toLowerCase().includes(slashQuery.toLowerCase()) ||
      c.desc.toLowerCase().includes(slashQuery.toLowerCase()),
  );

  function applyCommand(cmd: SlashCmd) {
    const ta = taRef.current;
    if (!ta) return;
    const v = valueRef.current;
    const pos = ta.selectionStart ?? v.length;
    let sel: Sel = { start: ta.selectionStart ?? pos, end: ta.selectionEnd ?? pos };
    let work = { value: v, sel };
    if (slashRange) {
      work = {
        value: work.value.slice(0, slashRange.trigger) + work.value.slice(sel.start),
        sel: { start: slashRange.trigger, end: slashRange.trigger },
      };
    }
    const line = lineRange(work.value, work.sel.start);

    if (cmd.kind === "prefix" && cmd.prefix) {
      const curText = work.value.slice(line.start, line.end);
      const stripped = curText.replace(/^(#+\s|[-*+]\s(\[[ xX]\]\s)?|\d+\.\s|>\s?)/, "");
      const newLine = cmd.prefix + stripped;
      work = applyEdit(work.value, work.sel, { replaceStart: line.start, replaceEnd: line.end, text: newLine });
      work.sel = { start: line.start + cmd.prefix.length, end: line.start + cmd.prefix.length };
    } else if (cmd.kind === "wrap" && cmd.wrap) {
      const [a, b] = cmd.wrap;
      const hasSel = work.sel.start !== work.sel.end;
      const selected = hasSel ? work.value.slice(work.sel.start, work.sel.end) : "";
      const inner = selected || (cmd.id === "link" ? "链接文字" : cmd.id === "mark" ? "高亮文字" : "文字");
      const text = a + inner + b;
      work = applyEdit(work.value, work.sel, { replaceStart: work.sel.start, replaceEnd: work.sel.end, text });
      if (cmd.id === "link") {
        const urlStart = work.sel.start - "https://)".length;
        work.sel = { start: urlStart, end: urlStart + "https://".length };
      } else {
        work.sel = { start: work.sel.start - b.length - inner.length, end: work.sel.start - b.length };
      }
    } else if (cmd.kind === "block" && cmd.block) {
      const p = work.sel.start;
      const before = work.value.slice(0, p);
      const after = work.value.slice(p);
      const lead = before === "" || before.endsWith("\n") ? "" : "\n\n";
      const trail = after === "" || after.startsWith("\n") ? "\n" : "\n\n";
      const text = lead + cmd.block + trail;
      work = applyEdit(work.value, work.sel, { replaceStart: p, replaceEnd: p, text });
      work.sel = { start: p + text.length, end: p + text.length };
    } else if (cmd.kind === "image" || cmd.kind === "file" || cmd.kind === "media") {
      // 上传/实体走异步流程，必须先把 "/query" 触发文本从正文里清掉，
      // 否则它会残留在文档中（历史上选「上传图片」后正文留下 "/image"）。
      if (slashRange) {
        const caret = work.sel.start;
        emit(work.value);
        setSelection({ start: caret, end: caret });
      }
      setSlashOpen(false);
      fileRef.current && (fileRef.current.dataset.kind = cmd.kind === "media" ? (cmd.media ?? "video") : cmd.kind);
      fileRef.current?.click();
      return;
    } else if (cmd.kind === "entity") {
      if (slashRange) {
        const caret = work.sel.start;
        emit(work.value);
        setSelection({ start: caret, end: caret });
      }
      setSlashOpen(false);
      setPickerOpen(true);
      return;
    }
    setSlashOpen(false);
    emit(work.value);
    setSelection(work.sel);
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const entry = (fileRef.current?.dataset.kind as "image" | "file" | "video" | "audio" | "pdf") || "image";
    const detected = mediaKindOf(file);
    const media: "image" | "file" | "video" | "audio" | "pdf" =
      entry === "video" || entry === "audio" || entry === "pdf" ? entry : detected;
    const limitError = validateUpload(media, file, loadUploadLimits());
    if (limitError) {
      window.alert(limitError);
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      const safeName = file.name.replace(/[\[\]()<>]/g, "_");
      let snippet: string;
      if (media === "image") snippet = `![${safeName}](${dataUrl})`;
      else if (media === "video") snippet = `<video src="${dataUrl}" controls preload="metadata" title="${safeName}"></video>`;
      else if (media === "audio") snippet = `<audio src="${dataUrl}" controls preload="metadata" title="${safeName}"></audio>`;
      else if (media === "pdf") snippet = `<iframe class="kb-pdf" src="${dataUrl}" title="${safeName}"></iframe>`;
      else snippet = `<a class="kb-attach" href="${dataUrl}" download="${safeName}">${safeName}</a>`;
      const ta = taRef.current;
      const v = valueRef.current;
      const pos = ta?.selectionStart ?? v.length;
      const before = v.slice(0, pos);
      const after = v.slice(pos);
      const lead = before.length === 0 || before.endsWith("\n") ? "" : "\n";
      const trail = after.length === 0 || after.startsWith("\n") ? "\n" : "\n\n";
      const insert = `${lead}${snippet}${trail}`;
      emit(before + insert + after);
      setSelection({ start: before.length + insert.length, end: before.length + insert.length });
    } catch {
      window.alert("文件读取失败，请重试");
    } finally {
      setUploading(false);
    }
  }

  // 「@」提及/引用：把 @触发词到光标处替换为插入片段
  function onMentionPick(snippet: string, isCanvasEmbed = false) {
    const ta = taRef.current;
    const v = valueRef.current;
    const pos = ta?.selectionStart ?? v.length;
    const trigger = mentionRange?.trigger ?? pos;
    const before = v.slice(0, trigger);
    const after = v.slice(pos);
    const lead = before.length === 0 || before.endsWith("\n") ? "" : "\n";
    const trail = isCanvasEmbed ? "\n" : "";
    const insert = `${lead}${snippet}${trail}`;
    emit(before + insert + after);
    const caret = (before + insert).length;
    setSelection({ start: caret, end: caret });
    setMentionOpen(false);
    setMentionRange(null);
  }

  function onEntityPick(e: PickedEntity) {
    const href = internalHref(e.target);
    const snippet = `[${e.title}](${href})`;
    const ta = taRef.current;
    const v = valueRef.current;
    const pos = ta?.selectionStart ?? v.length;
    const before = v.slice(0, pos);
    const after = v.slice(pos);
    const lead = before.length === 0 || before.endsWith("\n") ? "" : "\n";
    const trail = after.length === 0 || after.startsWith("\n") ? "\n" : "\n\n";
    const insert = `${lead}${snippet}${trail}`;
    emit(before + insert + after);
    setSelection({ start: before.length + insert.length, end: before.length + insert.length });
    setPickerOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // 中文输入法组词期间不拦截任何键（Enter=上屏候选词、方向键=选词）
    if (e.nativeEvent.isComposing) return;
    // Cmd/Ctrl+S：立即云端保存。stopPropagation 防止 DocEditorPage 顶层
    // useShortcuts（rootRef=editorAreaRef，包含 SourceEditor 容器）二次触发。
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "s" || e.key === "S") && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      void onSave?.();
      return;
    }
    if (slashOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveCmd((i) => Math.min(i + 1, filtered.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActiveCmd((i) => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); const c = filtered[activeCmd] ?? filtered[0]; if (c) applyCommand(c); return; }
      if (e.key === "Escape") { e.preventDefault(); setSlashOpen(false); return; }
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const v = valueRef.current;
      const s = ta.selectionStart;
      const en = ta.selectionEnd;
      emit(v.slice(0, s) + "  " + v.slice(en));
      setSelection({ start: s + 2, end: s + 2 });
    }
  }

  return (
    <div className="kb-md-edit-wrap">
      <input ref={fileRef} type="file" style={{ display: "none" }} onChange={onFilePicked}
        accept="image/*,video/*,audio/*,.pdf,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv" />
      <EntityPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={onEntityPick} />
      {mentionOpen && kbId && (
        <MentionPicker
          kbId={kbId}
          pos={mentionPos}
          onPick={onMentionPick}
          onClose={() => setMentionOpen(false)}
        />
      )}
      <div ref={mirrorRef} className="kb-md-mirror" aria-hidden="true" />
      <div className="kb-md-source-tools">
        <button type="button" className="kb-md-btn" title="插入内部链接（文档/画布/数据表）" onClick={() => setPickerOpen(true)}><Icon name="link" size={15} /></button>
        <span className="kb-rich-sep" />
        <button type="button" className="kb-md-btn" title="上传图片" onClick={() => { fileRef.current && (fileRef.current.dataset.kind = "image"); fileRef.current?.click(); }}><Icon name="image" size={15} /></button>
        <button type="button" className="kb-md-btn" title="上传视频" onClick={() => { fileRef.current && (fileRef.current.dataset.kind = "video"); fileRef.current?.click(); }}><Icon name="video" size={15} /></button>
        <button type="button" className="kb-md-btn" title="上传音频" onClick={() => { fileRef.current && (fileRef.current.dataset.kind = "audio"); fileRef.current?.click(); }}><Icon name="audio" size={15} /></button>
        <button type="button" className="kb-md-btn" title="嵌入 PDF" onClick={() => { fileRef.current && (fileRef.current.dataset.kind = "pdf"); fileRef.current?.click(); }}><Icon name="file" size={15} /></button>
        <button type="button" className="kb-md-btn" title="上传附件" onClick={() => { fileRef.current && (fileRef.current.dataset.kind = "file"); fileRef.current?.click(); }}><Icon name="paperclip" size={15} /></button>
        {uploading && <span className="kb-md-uploading">上传中…</span>}
      </div>
      <textarea
        ref={taRef}
        className="kb-md-textarea"
        value={value}
        readOnly={readOnly}
        onChange={handleChange}
        onKeyDown={onKeyDown}
        onBlur={() => setSlashOpen(false)}
        spellCheck={false}
        placeholder={"用 Markdown 书写…\n\n在空行输入「/」可快速插入标题、列表、表格、图片、附件等；\n行首输入 # 、- 、1. 、> 、``` 也可快捷排版。"}
      />
      {slashOpen && filtered.length > 0 && (
        <div ref={slashMenuRef} className="kb-slash-menu" style={{ top: slashPos.top, left: slashPos.left }}>
          <div className="kb-slash-title">插入内容</div>
          {filtered.map((c, i) => (
            <button
              key={c.id}
              type="button"
              className={`kb-slash-item${i === activeCmd ? " active" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); applyCommand(c); }}
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
  );
}
