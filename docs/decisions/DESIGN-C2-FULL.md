# DESIGN-C2-FULL: @引用 与画布/文档联动 — 完整改造方案

> 生成日期：2026-09-09
> 承接：C 阶段（@ 引用 + 画布/文档联动缺陷修复 + 节点编辑能力增强 + 版本预览增强）
> 用户原话："成熟生产级产品体验；鼠标与键盘一致；可撤销重做；无回归"
> 适用范围：`GouXiangDB-v2`（apps/web + apps/api）

---

## 0. 总览与编号

| 编号 | 标题 | 优先级 | 类别 |
|------|------|--------|------|
| **B1** | @ 插入后光标定位修复（鼠标 + 键盘） | P0 | 缺陷修复 |
| **B2** | @ 引用点击跳转 + 异常态处理（自身引用 / 无权限 / 已删除 / 已移动） | P0 | 缺陷修复 |
| **B3** | 标题锚点链接图标 + 锚点复制/跳转/粘贴 | P0 | 缺陷修复 + 增强 |
| **F1** | 版本管理器预览增强（滑动 / 缩放 / 还原 / 适配） | P0 | 功能优化 |
| **F2** | 画布节点设置面板增强（线宽 / 文字样式 / 插图 / 注释 / 关联）— 已闭环 | P1 | 功能优化 |
| **F3** | 流程图分支线 + 普通连接线样式扩展 | P1 | 功能优化 |
| **F4** | 直接插入式关联（NEW — 与节点设置类关联并存） | P1 | 新增能力 |
| **F5** | 思维导图适配（节点设置 / 连线 / 直接插入均生效） | P1 | 新增能力 |

每条均覆盖：**交互规则 / 数据状态 / 边界情况 / 异常提示 / UI 样式 / 验收标准 / 鼠标键盘一致 / 撤销重做 / 回归范围**。

---

## 一、缺陷修复

### B1. @ 插入后光标定位修复（鼠标 + 键盘）  ⛔ P0

#### 1.1 根因分析

**截图症状**（来自戴总反馈）：

```
未命名文档@ 未命名文档         ← 顶部多余 @ 未剥离
       @Owner                  ← 成员 chip
                                  [远端右缘光标]    ← 红色框：光标漂到了页面/块外
```

**根因链**（从代码逐层定位）：

1. **光标位置被 `placeCaretEnd` 误落到块根外** — `apps/web/src/features/kb/WysiwygEditor.tsx:2165-2173`
   ```ts
   function placeCaretEnd(el: HTMLElement) {
     el.focus();
     const range = document.createRange();
     range.selectNodeContents(el);
     range.collapse(false);   // ← 选块根的"末尾"位置
     ...
   }
   ```
   `selectNodeContents(el).collapse(false)` 把光标放到 `el.childNodes` 的最后一个 childNode 之后的位置。**当块内最后一个 childNode 是 `<a class="md-link">` 或 `<span class="md-mention" contenteditable=false>` 时，浏览器会把"块根末位置"自动吸附到该子元素的内部末尾**（如 `<a>(textNode, 1)`），而非块根的真正间隙。后续 `splitBlock` 的 `caretRootPoint` 会把此吸附点归一化上提到块根——但 `placeCaretEnd` 本身没做同样归一化，导致 chip 紧贴时光标进入 chip 内部，用户看上去"看不见"光标（contenteditable=false）。

2. **emit → state 更新 → DOM re-render 与聚焦时序竞争** — `WysiwygEditor.tsx:1366-1371`
   ```ts
   requestAnimationFrame(() =>
     requestAnimationFrame(() => {
       const el = editableEl(blockId);
       if (el) placeCaretEnd(el);
     }),
   );
   ```
   双 rAF 等 DOM 更新——但当 emit 触发了 `blocks` 数组引用变更时，**React 可能在双 rAF 之间再次 reconcile**，把已聚焦的 `el` 替换为新 `el`，导致 `placeCaretEnd` 落在旧节点上、Selection 被 detach 到 body。

3. **截图里的多余 `@` 字符** — `WysiwygEditor.tsx:1337`
   ```ts
   const stripped = (blk.text ?? "").replace(/(^|\s)@[^\s@]*$/, "$1").replace(/\u00A0/g, " ");
   ```
   当用户在 `未命名文档@`（无空格）后输入 `未命名文档`，触发条件 `(^|\s)@` 不满足（@ 紧跟在普通字符后），**面板不会弹出**，用户继续敲 `@` → 文本变 `未命名文档@@未命名文档`。这是设计取舍：仅当 @ 前是"行首或空白"才视为触发字符——**当前实现符合预期但用户体感差**（@ 紧贴文字时无任何反馈）。

4. **`@Owner` 成员 chip 显示正常 → 说明 `@[u:..]` 协议序列化/解析 OK** — 真正的 B1 是光标定位。

#### 1.2 修复方案

**修复 R1：光标归一化到块根间隙（不进入 contenteditable=false）**
```ts
// 新增 helper（与 caretRootPoint 对称）
function placeCaretAfterBlock(el: HTMLElement) {
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  // 把光标放到 el.childNodes 的最后一个非空间隙（跳过空白文本节点）
  const nodes = Array.from(el.childNodes);
  let idx = nodes.length;
  // 跳过尾随空白文本节点（同步 contenteditable 末尾可能插入的零宽节点）
  while (idx > 0 && nodes[idx - 1].nodeType === Node.TEXT_NODE &&
         /^\s*$/.test((nodes[idx - 1] as Text).data)) idx--;
  range.setStart(el, idx);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}
```
在 `onMentionPick` 替换 `placeCaretEnd` 为 `placeCaretAfterBlock`（行 1369）。

**修复 R2：emit 后用 ref 引用稳定 + 第三 rAF 兜底**
```ts
function onMentionPick(snippet: string, isCanvasEmbed = false) {
  ...
  emit(updated);  // 同步 state
  // 用 requestIdleCallback 等待 DOM 完全稳定，必要时降级为 setTimeout
  const focusEnd = () => {
    const el = editableEl(blockId);
    if (!el || !el.isConnected) return setTimeout(focusEnd, 16);
    placeCaretAfterBlock(el);
  };
  if ('requestIdleCallback' in window) {
    requestIdleCallback(focusEnd, { timeout: 100 });
  } else {
    setTimeout(focusEnd, 0);
  }
}
```
关键：用 `el.isConnected` 判断元素是否还在 DOM（React 卸载后再挂载的边界）；`requestIdleCallback` 让浏览器在空闲帧聚焦，避免与 reconcile 抢帧。

**修复 R3：紧贴字符后的 `@` 触发反馈**
```ts
// detectMention：增加"非空白前 @ 也提示，但提示文案不同"
const atLoose = /@([^\s@]*)$/.exec(pre);
if (atLoose && !at) {
  // 用户在非空白字符后输入 @ —— 不开面板，但 toast 提示"@ 需在行首或空白后"
  // 仅在第一次触发时 toast，避免重复刷屏
  if (!mentionToastShownRef.current) {
    toast('@ 引用需在行首或空格后输入', 'hint');
    mentionToastShownRef.current = true;
    setTimeout(() => { mentionToastShownRef.current = false; }, 1500);
  }
  setMention(null);
  return;
}
```

#### 1.3 验收标准

| AC 编号 | 行为 | 验证方式 |
|---------|------|----------|
| B1-AC-01 | 鼠标点选 MemberPicker 项后，光标落在该块末尾 chip/链接之后（**不进入 chip 内部**，可立即输入文字） | 真机：行 5 字符"测试" → @ → 选 Owner → 立刻敲"X" → 文本应为 `@OwnerX`，光标在 X 之后 |
| B1-AC-02 | 键盘 ↑↓ Enter 选中 MentionPicker 项后，光标行为同上 | 真机键盘流程 |
| B1-AC-03 | 连续插入两个 chip，光标始终在最后一个 chip 之后 | 真机：@ → Owner → 再 @ → Doc1 → 文本应为 `@Owner @Doc1` |
| B1-AC-04 | 在 `未命名文档@` 后继续输入（无空格），面板不弹；toast 提示一次 | 真机 |
| B1-AC-05 | chip 是块最后一个节点时按 →（ArrowRight），光标进入块根末间隙，可继续输入 | 真机 |
| B1-AC-06 | 在 chip 后按 Backspace → 删除 chip（整段） | 既有 |
| B1-AC-07 | 撤销/重做：插入 chip 后 Ctrl+Z 移除 chip 并保留触发词 | 真机 + 单测 |

#### 1.4 鼠标键盘一致性

- 鼠标：点击 picker 项 → 同上 R1/R2
- 键盘：↑↓ + Enter → 同上
- 触屏（触屏 pick）： 同上

#### 1.5 撤销/重做

`onMentionPick` 通过 `emit` 走 `pushHistory`（既有逻辑），整段操作进栈。撤销可还原到 chip 插入前的文本。

#### 1.6 回归范围

- `apps/web/src/features/kb/WysiwygEditor.tsx:1366-1371` `placeCaretEnd` → 替换为 `placeCaretAfterBlock`
- `apps/web/src/features/kb/WysiwygEditor.tsx:2165-2173` 原 `placeCaretEnd` 函数保留供 `splitBlock` 使用，但内部归一化
- `splitBlock` 内 `caretRootPoint` 已归一化，无需改
- 单测：覆盖 7 个 AC（vitest describe('onMentionPick caret', ...)）
- E2E：连续 5 次插入 chip，每 + 都断言 `Range.endContainer.parentElement === editableEl`

---

### B2. @ 引用点击跳转 + 异常态处理  ⛔ P0

#### 2.1 现状

`WysiwygEditor.tsx:2040-2052`：
```ts
if (anchor) {
  const href = anchor.getAttribute("data-href") || anchor.getAttribute("href") || "";
  if (href) {
    e.preventDefault();
    if (href.startsWith("/kb") || href.startsWith("/base")) {
      navigate(href);     // ← 直接跳转，无任何校验
    }
    ...
  }
}
```

**问题**：
1. **自身引用**：用户在文档 A 中 @ 文档 A 自身（错误用法但 UI 不拦截），点击直接跳转到自己→困惑
2. **无权限**：跳转后落到 403/404 页面才报错，体感差
3. **已删除**：目标被软删后 @ 链接仍可点击，但 navigate 后页面打不开
4. **已移动**：目标 docId 变了（虽本项目 kbId 不允许跨 kb 移动），链接失效无反馈

#### 2.2 修复方案

**修复 R4：自身引用禁止**
```ts
// MentionPicker：成员 / 文档 / 画布 三组都需排除自身
// 成员：自身始终允许（@ 自己是常规操作）
// 文档：filter currentDocId
// 画布：filter currentDocId
```
文件：`MentionPicker.tsx:48-55`
```ts
const docItems = useMemo(() => {
  const kw = q.trim().toLowerCase();
  return (docs ?? [])
    .filter((d) => !d.deletedAt)
    .filter((d) => d.id !== currentDocId)   // ← 新增排除自身
    .filter((d) => !kw || d.title.toLowerCase().includes(kw))
    .slice(0, 8)
    .map(...);
}, [docs, q, currentDocId]);
```
`MentionPicker` 接 `currentDocId?: string` prop；`WysiwygEditor` 把 `docId`（来自 `useParams`）传入。

**修复 R5：点击时实时探测异常态**

新增 `apps/web/src/features/kb/hooks/useLinkResolve.ts`：
```ts
export function useLinkResolve() {
  return useCallback(async (href: string): Promise<LinkResolveResult> => {
    const m = /^\/kb\/([^/]+)\/(doc|canvas)\/([^/?#]+)/.exec(href);
    if (!m) return { kind: 'external', ok: true, href };
    const [, kbId, kind, docId] = m;
    try {
      const r = await fetch(`/api/kb/${kbId}/docs/${docId}/acl`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.status === 200) return { kind: 'ok', ok: true, href };
      if (r.status === 404) return { kind: 'deleted', ok: false, href, toast: '该文档已删除' };
      if (r.status === 403) return { kind: 'forbidden', ok: false, href, toast: '无访问权限' };
      return { kind: 'unknown', ok: false, href, toast: '目标不可访问' };
    } catch {
      return { kind: 'network', ok: false, href, toast: '网络错误，请稍后重试' };
    }
  }, [token]);
}
```

**修复 R6：点击拦截 + 反馈**
```ts
// WysiwygEditor.tsx click handler
if (anchor) {
  e.preventDefault();
  const href = anchor.getAttribute("data-href") || anchor.getAttribute("href") || "";
  if (href.startsWith("/kb")) {
    void resolveLink(href).then((res) => {
      if (!res.ok) {
        toast(res.toast || '链接不可用', 'error');
        // 视觉降级：chip 加 gx-link-broken 类（删除线 + 灰色），不删除（保留信息）
        anchor.classList.add('md-link-broken');
        return;
      }
      navigate(href);
    });
  } else if (/^https?:\/\//i.test(href)) {
    window.open(href, "_blank", "noopener,noreferrer");
  }
}
```

**修复 R7：悬浮态预先探测（防点击才发现）**

利用 `useQuery` 预拉取已渲染文档的 ACL（鼠标进入 chip 后 200ms 探测一次）：
```ts
function MentionLink({ href, ... }) {
  const { data: acl } = useQuery({
    queryKey: ['link-acl', href],
    queryFn: () => fetch(`/api/kb/.../acl`).then(r => r.status),
    enabled: false,             // 默认不自动拉
    staleTime: 60_000,
  });
  return <a
    onMouseEnter={() => !acl && refetch()}
    className={`md-link ${acl === 404 ? 'md-link-broken' : acl === 403 ? 'md-link-forbidden' : ''}`}
    ...
  />;
}
```

#### 2.3 异常提示 UI 样式

| 状态 | 类名 | 视觉效果 |
|------|------|----------|
| 正常 | `md-link md-link-internal` | 蓝色下划线（既有） |
| 已删除 | `md-link md-link-broken` | 灰色删除线 + 鼠标悬浮"该文档已删除" |
| 无权限 | `md-link md-link-forbidden` | 灰色 + 🔒 图标 + 鼠标悬浮"您没有访问权限" |
| 网络错误 | 同 broken，提示文案不同 |  |

**CSS 新增**（`apps/web/src/features/kb/kb.css`）：
```css
.md-link-broken {
  color: theme(colors.gx-text-hint);
  text-decoration: line-through;
  cursor: not-allowed;
}
.md-link-forbidden {
  color: theme(colors.gx-text-hint);
  cursor: not-allowed;
  position: relative;
}
.md-link-forbidden::after {
  content: '🔒';
  margin-left: 2px;
  font-size: 10px;
  vertical-align: top;
}
```

#### 2.4 验收标准

| AC 编号 | 行为 | 验证方式 |
|---------|------|----------|
| B2-AC-01 | MentionPicker 排除当前文档/画布自身 | 真机：在文档 A 中 @ → 不显示 A 本身 |
| B2-AC-02 | 点击正常链接 → 跳转目标页 | 真机 |
| B2-AC-03 | 点击已删除文档链接 → toast "该文档已删除"，chip 视觉降级，不跳转 | 真机 + 后端软删文档后 |
| B2-AC-04 | 点击无权限文档链接 → toast "无访问权限"，chip 加 🔒 图标 | 真机 + 加入成员但删除权限 |
| B2-AC-05 | 网络断开 → toast "网络错误"，不跳转，视觉不变 | 真机离线模式 |
| B2-AC-06 | hover 正常链接 → 200ms 后预探测，结果以 chip 类名缓存 | DevTools 看请求 |
| B2-AC-07 | 撤销/重做：不涉及（无编辑） | N/A |

#### 2.5 鼠标键盘一致性

- 鼠标点击 → R5/R6
- 键盘 Enter 在链接 chip 上（Tab 聚焦后）→ 同 R5/R6
- 触屏：长按 → 同 R5/R6

#### 2.6 回归范围

- `apps/web/src/features/kb/MentionPicker.tsx`：过滤条件 + prop
- `apps/web/src/features/kb/WysiwygEditor.tsx`：click handler 改异步
- `apps/web/src/features/kb/kb.css`：新增 .md-link-broken/forbidden
- 后端：`apps/api/src/routes/kb.ts` GET `/docs/:docId/acl` 已有（确认含 deletedAt / permission 检查）；补 ACL 缓存头避免每次 hover 拉取
- 单测：覆盖 5 个 AC（mock fetch）
- E2E：真机逐步执行

---

### B3. 标题锚点链接图标 + 锚点复制/跳转/粘贴  ⛔ P0

#### 3.1 现状

- 文档各级标题（H1/H2/H3）渲染为 `<h1>`/`<h2>`/`<h3>`，无 `id` 属性 → 无法 URL 锚点定位
- 无复制锚点链接按钮
- `md-link` 仅支持 `/kb/...` 跳转，无法跳到 `#anchor`

#### 3.2 设计要点

##### 3.2.1 标题 `id` 生成

**编辑器内**（`WysiwygEditor.tsx`）：
```ts
// 渲染标题时根据 block.text 生成稳定 slug
function headingId(text: string, blockId: string): string {
  // 1. 优先用 blockId 末 6 字符（保证稳定，不随文字变更而变）
  // 2. 后备：text 的拼音/slugify（首 32 字符）
  return `h-${blockId.slice(-6)}`;
}
```
渲染：
```tsx
<h1 data-heading-id={headingId(b.text, b.id)} ...>
  <span className="md-heading-content">{inlineRich(b.text ?? "")}</span>
  <button className="md-heading-anchor" title="复制锚点链接">🔗</button>
</h1>
```

**只读模式**（`apps/web/src/features/kb/Markdown.tsx`）：
```ts
// markdown.ts 渲染 h1/h2/h3 时同样生成 id
const slug = `h-${nanoid(6)}`;   // 浏览器渲染稳定后写入
// 或：服务端预渲染（更好但需改 schema）
```

##### 3.2.2 锚点链接图标

```tsx
function HeadingAnchor({ blockId, text }: { blockId: string; text: string }) {
  const id = headingId(text, blockId);
  const url = `${window.location.origin}${window.location.pathname}#${id}`;
  return (
    <button
      type="button"
      className="md-heading-anchor"
      title="复制锚点链接"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard.writeText(url);
        toast('已复制标题锚点链接', 'success');
      }}
    >
      <Icon name="link" size={14} />
    </button>
  );
}
```

**鼠标悬停时显示**：CSS
```css
.md-heading-anchor {
  opacity: 0;
  margin-left: 4px;
  transition: opacity 0.15s;
}
[data-heading-id]:hover .md-heading-anchor {
  opacity: 1;
}
```

##### 3.2.3 URL 锚点跳转

```ts
// DocEditorPage / CanvasEditorPage 路由参数后：
useEffect(() => {
  const hash = window.location.hash.slice(1);
  if (!hash || !hash.startsWith('h-')) return;
  // 1. 等内容渲染完
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-heading-id="${hash}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.add('md-heading-flash');
      setTimeout(() => el.classList.remove('md-heading-flash'), 2000);
    }
  });
}, [content]);
```

##### 3.2.4 链接形式 + 粘贴降级

```markdown
# 插入到本文档：[点击跳转](?#h-abc123)
# 插入到其他文档：[点击跳转](/kb/:kbId/doc/:otherId#h-xyz789)
```

**粘贴行为**（重要：与用户原文一致）：
```ts
// apps/web/src/features/kb/WysiwygEditor.tsx paste handler
function onPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData('text/plain') ?? '';
  // 检测是否锚点 URL
  const m = /^(https?:\/\/[^\s]+\/kb\/[^/]+\/[^/]+\/[^?#]+)(\?#h-[a-z0-9]+)$/i.exec(text);
  if (m) {
    e.preventDefault();
    const path = m[1].replace(window.location.origin, '');
    const anchor = m[2].slice(2);  // h-abc123
    // 1. 查询目标标题文本（fetch API 或本地缓存）
    void resolveHeadingTitle(path, anchor).then((title) => {
      // 2. 以**纯文本**插入（但 clickable）—— 实现方式：
      //  - 文本=纯标题（用户看到的就是标题文字，无链接样式）
      //  - 包一个 data-anchor-only span，click 时跳转
      insertText(title || anchor);
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType === Node.TEXT_NODE) {
        const span = document.createElement('span');
        span.className = 'md-anchor-pasted';
        span.dataset.href = path;
        span.dataset.anchor = anchor;
        span.textContent = node.textContent;
        // 替换文本节点为 span
        const parent = node.parentNode!;
        parent.replaceChild(span, node);
        range.selectNodeContents(span);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
    return;
  }
  // 其他粘贴逻辑既有
}
```

UI：纯文本外观 + `cursor: pointer` + hover 下划线
```css
.md-anchor-pasted {
  cursor: pointer;
  color: theme(colors.gx-text-secondary);
  border-bottom: 1px dashed theme(colors.gx-text-hint);
}
.md-anchor-pasted:hover {
  color: theme(colors.gx-accent);
  border-bottom-color: theme(colors.gx-accent);
}
```

点击行为：
```ts
function onClickAnchorPasted(e: MouseEvent) {
  const span = (e.target as HTMLElement).closest('.md-anchor-pasted');
  if (!span) return;
  const href = span.dataset.href;
  const anchor = span.dataset.anchor;
  if (!href) return;
  // 同 B2：探测 + 跳转
  ...
}
```

##### 3.2.5 反向 — 从标题生成 markdown 链接按钮

```tsx
// 复制按钮旁的二级操作（长按 / 菜单）
<ContextMenu>
  <MenuItem onClick={() => copyMarkdownLink(path, anchor, title)}>
    复制为 Markdown 链接
  </MenuItem>
</ContextMenu>
```

#### 3.3 验收标准

| AC 编号 | 行为 | 验证方式 |
|---------|------|----------|
| B3-AC-01 | 鼠标悬到 H1/H2/H3 上，右边出现锚点链接图标 | 真机 |
| B3-AC-02 | 点击锚点图标 → URL 复制到剪贴板 + toast "已复制锚点链接" | 真机 |
| B3-AC-03 | 在浏览器地址栏输入 `/kb/.../doc/...#h-abc123` → 页面加载后滚动到该标题 + 2 秒高亮闪烁 | 真机 |
| B3-AC-04 | 在文档 A 选中文本 → 点击"插入链接" → 填入 `/kb/:kb/doc/...#h-xyz` → 文档内显示蓝色下划线链接 | 既有 |
| B3-AC-05 | 复制锚点 URL → 在另一文档中粘贴 → 显示为标题纯文本（**不显示为链接样式**）+ 下划虚线 + 鼠标悬浮变蓝 | 真机 |
| B3-AC-06 | 点击粘贴的"伪纯文本" → 跳转到目标文档对应标题 + 高亮 | 真机 |
| B3-AC-07 | 目标已删除 → 点击粘贴的纯文本 → toast 异常 + 不跳转（复用 B2） | 真机 |
| B3-AC-08 | 撤销/重做：插入链接可撤销（既有） | 既有 |

#### 3.4 鼠标键盘一致性

- 鼠标：hover 显示图标 → 点击 → 复制 / 跳转
- 键盘：Tab 到图标按钮 → Enter 触发
- 触屏：长按标题 → 弹菜单（含复制锚点、复制 Markdown 链接）

#### 3.5 回归范围

- `apps/web/src/features/kb/WysiwygEditor.tsx`：标题渲染加 anchor 按钮 + paste handler
- `apps/web/src/features/kb/markdown.ts`：渲染 h1/h2/h3 加 id
- `apps/web/src/features/kb/DocEditorPage.tsx`：useEffect 监听 hash
- `apps/web/src/features/kb/kb.css`：.md-heading-anchor / .md-anchor-pasted / .md-heading-flash
- 单测：覆盖 6 个 AC

---

## 二、功能优化

### F1. 版本管理器预览增强  ⛔ P0

#### 1.1 现状

`apps/web/src/features/kb/VersionHistoryDrawer.tsx`：当前版本预览是 `DrawnixCanvas` 套 `allowViewInteraction`，**没有专用工具条**。只能通过触控板/鼠标滚轮缩放，不能点按钮放大/缩小、不能"还原"（回到 100%）、不能"适配视图"（fit）。

#### 1.2 修复方案

新增 `apps/web/src/features/kb/canvas/CanvasPreviewToolbar.tsx`：
```tsx
export function CanvasPreviewToolbar({ handle, onClose }: {
  handle: DrawnixCanvasHandle;   // 已有（forwardRef 暴露）
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  useEffect(() => handle.setZoom(zoom), [zoom]);    // 仅响应用户操作
  // 暴露给 handle 的 zoom 变化 hook
  useEffect(() => {
    const id = setInterval(() => {
      const z = handle.getZoom();
      setZoom(z => Math.abs(z - z) < 0.001 ? z : z);   // 占位：需要事件驱动
    }, 200);
    return () => clearInterval(id);
  }, [handle]);
  return (
    <div className="absolute right-4 top-4 z-50 flex items-center gap-1 rounded-gx-md border border-gx-separator bg-gx-surface p-1 shadow-lg">
      <button onClick={() => handle.zoomBy(-0.1)} title="缩小" disabled={zoom <= 0.2}>
        <Icon name="minus" size={14} />
      </button>
      <span className="px-2 text-gx-12 tabular-nums">{Math.round(zoom * 100)}%</span>
      <button onClick={() => handle.zoomBy(0.1)} title="放大" disabled={zoom >= 5}>
        <Icon name="plus" size={14} />
      </button>
      <Divider />
      <button onClick={() => handle.setZoom(1)} title="还原 100%">
        <Icon name="resetZoom" size={14} />
      </button>
      <button onClick={() => handle.fit()} title="适配视图">
        <Icon name="maximize" size={14} />
      </button>
      <Divider />
      <button onClick={() => {/* pan by arrow keys */}} title="滑动">
        <Icon name="hand" size={14} />
      </button>
    </div>
  );
}
```

`DrawnixCanvas` 已有 `zoomBy/setZoom/fit/getZoom`，无需新增 API。需要做的：
1. **DrawnixCanvas 透出 viewport 变化事件给 handle**：当前 `onViewportChange` 已暴露但 handle 未订阅；改为 handle 内订阅 prop
2. **滑动**：键盘 ←↑↓→ 平移 viewport，缩放后用户常丢失内容；可用 `BoardTransforms` 的 `updateOrigination`（plait 提供）

```ts
// DrawnixCanvas.tsx handle 加
panBy: (dx: number, dy: number) => {
  const b = boardRef.current;
  if (!b?.viewport) return;
  BoardTransforms.updateOrigination(b, [
    b.viewport.origination[0] + dx,
    b.viewport.origination[1] + dy,
  ]);
}
```

#### 1.3 工具条定位 + 行为

| 状态 | 工具条位置 |
|------|-----------|
| 默认 | 右下角浮动 |
| 只读快照（不可交互） | 隐藏工具条（既有 readonly mask） |
| 允许查看（历史版本） | 右下角浮动，可缩放但不可编辑 |
| 当前版本编辑 | 不显示该工具条（用主编辑器工具） |

#### 1.4 验收标准

| AC 编号 | 行为 | 验证方式 |
|---------|------|----------|
| F1-AC-01 | 历史版本预览 → 右下角出现工具条 | 真机 |
| F1-AC-02 | 点"+" / "-" → 缩放（步进 0.1，范围 0.2-5.0） | 真机 + 边缘禁用 |
| F1-AC-03 | 点"还原" → 100% | 真机 |
| F1-AC-04 | 点"适配视图" → fit 整张画布到当前可视区 | 真机 |
| F1-AC-05 | 工具条百分比随缩放同步更新 | 真机 |
| F1-AC-06 | 键盘 ←↑↓→ 平移视图（每次 50px） | 真机键盘 |
| F1-AC-07 | 撤销/重做：不涉及（只读模式） | N/A |

#### 1.5 鼠标键盘一致性

- 鼠标：点击按钮 / 滚轮缩放 / 拖拽平移（既有）
- 键盘：↑↓←→ 平移 / `+/-` 缩放 / `0` 还原 / `F` 适配 / `Esc` 关闭抽屉

#### 1.6 回归范围

- `apps/web/src/features/kb/canvas/DrawnixCanvas.tsx`：handle 加 `panBy`
- 新增 `apps/web/src/features/kb/canvas/CanvasPreviewToolbar.tsx`
- `apps/web/src/features/kb/VersionHistoryDrawer.tsx`：挂载工具条
- `apps/web/src/features/kb/kb.css`：.canvas-preview-toolbar 类
- E2E：真机 + 单元测 zoomBy/panBy 边界

---

### F2. 画布节点设置增强（已闭环于 2026-09-09）  ✓

详见上一会话验收报告。本节无新增；用户原话要求"覆盖思维导图"见 **F5**。

---

### F3. 流程图分支线 + 普通连接线样式扩展  P1

#### 3.1 现状

`canvas-ops.ts:setStrokeColor/setStrokeWidth/setStrokeStyle/setFillColor/toggleTextMark/setTextAlign/setTextColor` 已覆盖几何节点；连线有 `setArrowShape/setArrowMarker`。

**缺口**：
- 分支线（flowchart branch）的颜色/粗细/形态未独立可调
- 连线端点 marker 已有 7 种，但线型 (curve/elbow/straight) 仅在选中连线时显示

#### 3.2 设计要点

**修复 R8：分支线独立样式**

新增 `canvas-ops.ts`:
```ts
export function setBranchLineStyle(board: PlaitBoard, branchId: string, opts: {
  stroke?: string;
  strokeWidth?: number;
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
  shape?: 'curve' | 'elbow' | 'straight';
}) {
  const elem = resolveElement(board, branchId);
  if (!elem || !isBranchLine(elem)) return;
  withBatch(board, 'gx-branch-style', () => {
    if (opts.stroke !== undefined) PropertyTransforms.setStrokeColor(board, opts.stroke, { getMemorizeKey: () => 'gx' });
    if (opts.strokeWidth !== undefined) PropertyTransforms.setStrokeWidth(board, opts.strokeWidth);
    if (opts.strokeStyle !== undefined) PropertyTransforms.setStrokeStyle(board, opts.strokeStyle as any);
    if (opts.shape !== undefined) setArrowShape(board, opts.shape);
  });
}
```

`NodeStyleBar` 检测到选中分支线时，单独显示分支线样式面板（与连线面板并列）：
```tsx
{hasBranch && (
  <Section label="分支线样式">
    <Btn icon="palette" title="分支线颜色" onClick={() => pop("branchColor")} />
    <Btn icon="rowHeight" title="分支线粗细" onClick={() => pop("branchWidth")} />
    <Btn icon="swap" title="分支线线型" onClick={() => pop("branchStyle")} />
    <Btn icon="lineCurve" title="分支线形态" onClick={() => pop("branchShape")} />
  </Section>
)}
```

#### 3.3 验收标准

| AC 编号 | 行为 | 验证方式 |
|---------|------|----------|
| F3-AC-01 | 选中 flowchart 分支线 → 样式条出现"分支线样式"分组 | 真机 |
| F3-AC-02 | 分支线颜色 / 粗细 / 线型 / 形态独立设置，不影响主连线 | 真机 |
| F3-AC-03 | 多选：分支线 + 主连线 + 几何 → 改颜色仅影响分支线 | 真机 |
| F3-AC-04 | 撤销/重做：分支线样式操作进栈 | 真机 |

#### 3.4 鼠标键盘一致性

- 既有

#### 3.5 回归范围

- `apps/web/src/features/kb/canvas/canvas-ops.ts`：新增 setBranchLineStyle
- `apps/web/src/features/kb/canvas/NodeStyleBar.tsx`：检测 + 分组渲染
- 单测：setBranchLineStyle 单元测

---

### F4. 直接插入式关联（NEW — 与节点设置类关联并存）  P1

#### 4.1 与既有"节点设置类关联"对比

| 维度 | 节点设置类关联（F2） | 直接插入式关联（F4 本节） |
|------|---------------------|--------------------------|
| 触发入口 | 节点选中 → NodeStyleBar → "关联文档或画布" | 工具条"插入 → 关联块" / 画布右键菜单 / 斜杠 `/关联` |
| 数据模型 | 节点 metadata `gxDocRef`（修改节点） | 独立 Plait 元素 `gx-link-block`（不修改任何节点） |
| 视觉表现 | 节点右上角小图标 + 嵌入预览卡（嵌入式） | 独立的链接块（带标题/类型图标/可点击跳转） |
| 编辑影响 | 修改节点本身（影响其它属性） | 不污染节点，可独立移动/删除/调整尺寸 |
| 典型场景 | "这个矩形说的事项指向文档 A" | "我在画布中插入文档 A 的引用卡片" |
| 跳转方式 | 预览卡打开 / 点击跳转 | 点击卡片整体跳转 / 悬停预览摘要 |
| 共存 | | 同一画布可同时存在，互不干扰 |

#### 4.2 数据模型

新增 Plait 元素类型（写入 `gx-link-block`）：
```ts
// apps/web/src/features/kb/canvas/types.ts
export interface GxLinkBlock extends PlaitElement {
  type: 'gx-link-block';
  ref: GxDocRef;        // { docId, kind, title } 与节点关联一致
  width: number;         // 默认 280
  height: number;        // 默认 160
  updatedAt?: string;
}
```

#### 4.3 视觉设计

```
┌─────────────────────────────────┐
│ 📄  目录跳转测试文档       [↗] │  ← 顶部图标 + 标题 + 跳转按钮
├─────────────────────────────────┤
│ 这是文档 A 的第一段摘要内容...   │  ← 摘要（最多 6 行）
│ 这是文档 A 的第二段摘要内容...   │
│ 这是文档 A 的第三段...          │
│                          [更多] │
└─────────────────────────────────┘
   ↳ 拖拽调整尺寸 / 点击跳转
```

#### 4.4 实现

**R9：新增 `canvas-ops.ts:setLinkBlock / removeLinkBlock / updateLinkBlockRef`**
```ts
export function insertLinkBlock(board: PlaitBoard, ref: GxDocRef, position: ScreenPoint) {
  const element: GxLinkBlock = {
    id: generateId(),
    type: 'gx-link-block',
    ref,
    points: [position, [position[0] + 280, position[1] + 160]],
    width: 280,
    height: 160,
  };
  Transforms.insertNode(board, element, { getMemorizeKey: () => 'gx-link-block' });
}
```

**R10：新增 `GxLinkBlock` 渲染组件**

`apps/web/src/features/kb/canvas/GxLinkBlockView.tsx`：
- 接收 board + element，渲染纯 React overlay（与 NodeBadges / DocRefCard 同级 portal）
- 实现：title + 跳转按钮 + 摘要（useQuery 拉取文档前 200 字符 markdown）+ 拖拽手柄

```tsx
function GxLinkBlockView({ element, board, kbId, publicToken }: GxLinkBlockProps) {
  const rect = getElementScreenRect(board, element);
  const { data: doc } = useDoc(element.ref.docId);   // 已有 hook
  return (
    <div className="gx-link-block" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      <div className="gx-link-block-header">
        <DocKindIcon kind={element.ref.kind} size={14} />
        <span className="truncate">{element.ref.title}</span>
        <button onClick={() => navigate(`/kb/${kbId}/${element.ref.kind}/${element.ref.docId}`)}>
          <Icon name="externalLink" size={12} />
        </button>
      </div>
      <div className="gx-link-block-body">
        {doc?.content?.slice(0, 200) || '加载中...'}
      </div>
      <ResizeHandle element={element} />
    </div>
  );
}
```

**R11：交互入口**
- 工具条：插入按钮展开菜单 → "插入关联"
- 右键空白：菜单 → "插入关联"
- 斜杠 `/关联`（未来）：先预留，KB 文本编辑器侧

**R12：删除 / 编辑 / 移动**
- 选中 → 节点样式条（NodeStyleBar 检测到 gx-link-block）→ 显示"删除"按钮
- 双击 → 跳转到目标文档
- 拖拽整体移动（既有 plait 行为）

#### 4.5 数据保存与权限

- 元素进入 board.children → 既有 `onValueChange` 防抖 → `saveContent` 自动落库
- 公开分享页只读模式 → gx-linkBlock 仅渲染不可编辑/跳转受限（受 `publicToken` 权限）

#### 4.6 验收标准

| AC 编号 | 行为 | 验证方式 |
|---------|------|----------|
| F4-AC-01 | 工具条 → 插入 → 关联 → 弹出文档/画布选择器 → 选中 → 画布出现独立链接块 | 真机 |
| F4-AC-02 | 链接块拖拽移动 | 真机 |
| F4-AC-03 | 链接块右下角拖拽调整尺寸（最小 200×120，最大 600×400） | 真机 |
| F4-AC-04 | 双击链接块 → 跳转到目标文档 | 真机 |
| F4-AC-05 | 点击右上角 [↗] 按钮 → 跳转到目标文档 | 真机 |
| F4-AC-06 | 链接块与节点设置类关联同时存在 → 不互相干扰 | 真机 |
| F4-AC-07 | 删除链接块 → NodeStyleBar 删除按钮 / Backspace / 右键 | 真机 |
| F4-AC-08 | 目标文档更新 → 链接块摘要自动刷新（5s 内） | 真机 + 后端改文档 |
| F4-AC-09 | 目标文档已删除 → 链接块显示"文档已删除"+ toast | 真机 |
| F4-AC-10 | 撤销/重做：插入 / 删除 / 移动 / 改尺寸均进栈 | 真机 |
| F4-AC-11 | 公开分享页只读模式下，链接块可见但不可编辑/跳转 | 真机 |

#### 4.7 鼠标键盘一致性

- 鼠标：拖拽 / 调整尺寸 / 双击跳转 / 单击选中
- 键盘：选中后 Delete 删除 / Enter 跳转 / 方向键移动（已有 plait 行为）
- 触屏：双指捏合缩放、拖拽移动（已有 plait 行为）

#### 4.8 回归范围

- `apps/web/src/features/kb/canvas/types.ts`：新增 GxLinkBlock 类型
- `apps/web/src/features/kb/canvas/canvas-ops.ts`：insertLinkBlock / updateLinkBlockRef
- 新增 `apps/web/src/features/kb/canvas/GxLinkBlockView.tsx`
- `apps/web/src/features/kb/canvas/CanvasEnhanceOverlay.tsx`：渲染所有 gx-link-block
- `apps/web/src/features/kb/canvas/NodeStyleBar.tsx`：检测 gx-link-block 渲染不同按钮
- `apps/web/src/features/kb/canvas/canvas-toolbar.tsx`（如有）：新增"插入关联"入口
- `apps/web/src/features/kb/kb.css`：.gx-link-block / .gx-link-block-header / .gx-link-block-body
- 单测：insertLinkBlock / 摘要解析 / 类型守卫
- E2E：覆盖 8 个核心 AC

---

### F5. 思维导图适配（NEW — 节点设置/连线/直接插入均生效）  P1

#### 5.1 思维导图元素类型识别

Drawnix 的思维导图由特殊节点构成（mind-map-definition 包）：
- **中心节点**（root）
- **分支节点**（topic nodes）
- **连接线**（between topics — 不同于普通画布箭头连线）

```ts
// apps/web/src/features/kb/canvas/types.ts
export function isMindMapNode(el: PlaitElement): boolean {
  return el.type === 'mind-map-topic' || el.type === 'mind';
}
export function isMindMapLine(el: PlaitElement): boolean {
  return el.type === 'mind-map-line' || (isLineLike(el) && el.source?.kind === 'mind');
}
```

#### 5.2 思维导图节点设置面板适配

**R13：NodeStyleBar 检测思维导图节点时渲染专属面板**

```tsx
const mindMapNodes = elements.filter(isMindMapNode);
const hasMindMap = mindMapNodes.length > 0;

{hasMindMap && (
  <>
    <Divider />
    <Btn icon="palette" title="节点填充" onClick={() => pop("mindFill")} />
    <Btn icon="text" title="节点文字颜色" onClick={() => pop("mindTextColor")} />
    <Btn icon="bold" title="加粗" active={...} onClick={() => toggleTextMark(board, 'bold')} />
    <Btn icon="italic" title="斜体" active={...} onClick={() => toggleTextMark(board, 'italic')} />
    <Btn id="mindShape" icon="circle" title="节点形状" onClick={() => pop("mindShape")} />
  </>
)}

{popup === "mindShape" && (
  <MindMapShapePopover
    current={mindMapNodes[0].shape as string}
    onPick={(s) => { setMindMapShape(board, s); setPopup(null); }}
    onClose={() => setPopup(null)}
  />
)}
```

**思维导图节点形状选项**：圆形 / 椭圆 / 矩形 / 圆角矩形 / 下划线（mind-map 经典 5 种）

#### 5.3 思维导图分支线适配

思维导图分支线（mind-map-line）支持：
- 颜色：与 F3 普通连线共用
- 粗细：1-12px
- 形态：曲线 / 直线（**思维导图不支持折线 elbow**）
- 端点 marker：**固定无端点 marker**（思维导图线视觉规范）

```ts
function MarkerPopover({ ..., isMindMapLine = false }: ...) {
  if (isMindMapLine) return null;  // 思维导图线不显示端点选择
  ...
}
```

#### 5.4 思维导图节点 + 直接插入式关联共存

思维导图节点本身支持节点设置类关联（gxDocRef），与 F2 一致。
思维导图画布内也可插入 F4 的直接插入式关联块（gx-link-block），二者并存。

#### 5.5 验收标准

| AC 编号 | 行为 | 验证方式 |
|---------|------|----------|
| F5-AC-01 | 选中思维导图节点 → 样式条出现思维导图专属按钮（填充/文字色/B/I/形状） | 真机 |
| F5-AC-02 | 选中思维导图节点 → 改填充/文字色 → 全选多个思维导图节点 → 一起应用 | 真机 |
| F5-AC-03 | 切换思维导图节点形状 → 5 种可切换 | 真机 |
| F5-AC-04 | 选中思维导图分支线 → 样式条出现线色/线宽/线型/形态（**无端点 marker**） | 真机 |
| F5-AC-05 | 思维导图节点设置关联（gxDocRef）与直接插入关联（gx-link-block）共存 | 真机 |
| F5-AC-06 | 撤销/重做：思维导图节点属性操作进栈 | 真机 |

#### 5.6 鼠标键盘一致性

- 既有（plait mindmap 已支持拖拽 / Tab 创建子节点 / Enter 新增兄弟）

#### 5.7 回归范围

- `apps/web/src/features/kb/canvas/types.ts`：isMindMapNode / isMindMapLine
- `apps/web/src/features/kb/canvas/canvas-ops.ts`：setMindMapShape / setMindMapNodeFill / setMindMapTextColor
- `apps/web/src/features/kb/canvas/NodeStyleBar.tsx`：检测 + 渲染
- `apps/web/src/features/kb/canvas/MindMapShapePopover.tsx`（新增）
- `apps/web/src/features/kb/canvas/style-popups.tsx`：MarkerPopover 支持 isMindMapLine
- 单测：setMindMapShape 单元

---

## 三、变更记录

| 日期 | 变更内容 | 原因 | 影响范围 |
|------|----------|------|----------|
| 2026-09-09 | 设计文档 C2-FULL 初稿 | 用户需求 | apps/web（WysiwygEditor/MentionPicker/kb.css/canvas-ops/NodeStyleBar/CanvasEnhanceOverlay 新增 GxLinkBlockView/MindMapShapePopover/CanvasPreviewToolbar） |
| 待实施 | B1/R1-R3：@ 光标定位 + 触发反馈 | 截图症状 | WysiwygEditor + kb.css |
| 待实施 | B2/R4-R7：@ 跳转校验 | 无权限/已删除无提示 | MentionPicker + WysiwygEditor + 新增 hooks/useLinkResolve.ts |
| 待实施 | B3/R3/R7：标题锚点链接 | 无锚点定位 | WysiwygEditor + markdown.ts + DocEditorPage + kb.css |
| 待实施 | F1/R8：版本预览工具条 | 仅滚轮缩放 | DrawnixCanvas + 新增 CanvasPreviewToolbar + VersionHistoryDrawer |
| 待实施 | F3/R8：分支线样式 | 分支线不可独立设置 | canvas-ops + NodeStyleBar |
| 待实施 | F4/R9-R12：直接插入式关联 | 新增能力 | 新增 types + canvas-ops + 新增 GxLinkBlockView + overlay + toolbar |
| 待实施 | F5/R13-R15：思维导图适配 | 节点设置/连线对思维导图失效 | types + canvas-ops + NodeStyleBar + 新增 MindMapShapePopover |

---

## 四、验收总览

| 类别 | 编号 | 项目 | 优先级 | 验收 |
|------|------|------|--------|------|
| 缺陷修复 | B1 | @ 插入后光标定位 | P0 | 鼠标+键盘一致 + 7 个 AC |
| 缺陷修复 | B2 | @ 引用点击跳转 + 异常态 | P0 | 自身排除 + 5 个 AC |
| 缺陷修复 | B3 | 标题锚点链接图标 | P0 | 复制/跳转/粘贴 + 8 个 AC |
| 功能优化 | F1 | 版本管理器预览增强 | P0 | 缩放/还原/适配/滑动 + 7 个 AC |
| 功能优化 | F2 | 画布节点设置增强 | P1 | 已闭环于 2026-09-09 |
| 功能优化 | F3 | 流程图分支线 + 普通连接线样式 | P1 | 4 个 AC |
| 新增能力 | F4 | 直接插入式关联 | P1 | 11 个 AC |
| 新增能力 | F5 | 思维导图适配 | P1 | 6 个 AC |

**总计**：P0 5 项 + P1 3 项 = 8 项，~50 个 AC。

---

## 五、风险与依赖

| 风险 | 影响 | 缓解 |
|------|------|------|
| B2 引入 ACL 探测 → 高频请求 → QPS 上升 | 服务端压力 | 仅 hover 触发 + 60s staleTime + 缓存命中跳过；后端 ACL 端点加 ETag |
| B3 标题 slug 不稳定 → 链接失效 | 用户体验 | 用 blockId 末 6 位（不变）替代纯文本 slug；服务端 prerender 留待下轮 |
| F4 直接插入式关联需新增 Plait 元素类型 → 类型擦除兼容老数据 | 老画布打开异常 | 类型守卫 + 未知类型 fallback 渲染 + 不阻塞加载 |
| F5 思维导图节点 plait 内部 API 命名随版本变化 | 兼容性 | 类型守卫兜底，识别失败按普通几何处理 |
| 多选含不同类型（mindmap + shape + line） → 类型守卫复杂 | UI 复杂度 | 限定：选区同类型才显示对应面板；混选时显示公共项 |

---

## 六、文档版本

- v1.0 — 2026-09-09 初稿
- 后续版本按 ADR 编号惯例（ADR-002 之后）

— END —