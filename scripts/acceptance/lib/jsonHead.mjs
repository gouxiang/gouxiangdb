// scripts/acceptance/lib/jsonHead.mjs
// 从"JSON + 追加人类可读文本"的混合 stdout 中提取并解析【首个】完整 JSON 值。
//
// 背景：nav/authz 的 reconcile CLI 在 --json 模式下打印 JSON 后，还会再向 stdout
// 追加一行 "applied changes=N"/"no changes"（见 reconcile-nav.ts、reconcile-policies.ts）。
// 整段 JSON.parse 会抛错；本函数做字符串/转义感知的括号配平，只取头部 JSON，
// 使验收能真正读到 fix.* 字段，而不是因解析失败回退到 ?? 0 而"空转通过"。

/**
 * @param {string} text 混合输出
 * @returns {any|null} 解析出的首个 JSON 对象/数组；无法解析时 null
 */
export function parseJsonHead(text) {
  if (typeof text !== "string") return null;
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}
