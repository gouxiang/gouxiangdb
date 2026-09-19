// M6-FE PatList 组件级回归（node：react-dom/server + vi.mock，无 jsdom/新依赖，沿 nav-render.test.tsx 套路）。
// 覆盖：列表渲染（名称/前缀/中文 scope 标签/状态）、空态、新建表单默认只读勾选、
//       一次性明文弹窗仅 open 时含 token（关闭即焚）、吊销二次确认、永不过期强警示、token 不落 storage/URL。
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { renderToString as rtsRaw } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PatMetadata } from "../../api/client";

// ui.Modal 用 createPortal(children, document.body)；react-dom 的 legacy 服务端渲染器不支持 portal，
// 故把 createPortal 就地渲染（返回 children），使 Modal 内容可在 SSR 中断言；生产代码不变。
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (children: unknown) => children };
});

// Modal 仍会求值 document.body（作为已被 mock 的 createPortal 第二参），给最小桩。
beforeAll(() => {
  const g = globalThis as unknown as { document?: unknown };
  g.document = g.document ?? { body: {} };
});

// ---- mock 请求层（禁真实 fetch；list 由 QueryClient 预置数据驱动） ----
vi.mock("../../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown, public retryAfter?: number) {
      super(`API ${status}`);
    }
  },
  fetchEnterpriseMeta: vi.fn().mockResolvedValue(null),
  PatsApi: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), revoke: vi.fn() },
  // 接入方式块要用它拼 MCP 端点；这里按根部署返回原样路径（SSR 下无 location.origin）。
  withBase: (p: string) => p,
}));

import { PAT_QK } from "./pat-hooks";
import { PatListPanel, PatRow, RevokeConfirmModal, NeverExpiryConfirmModal } from "./PatListPanel";
import { PatTokenModal } from "./PatTokenModal";
import { CreatePatForm } from "./CreatePatForm";
import {
  NEVER_EXPIRY_WARNING,
  PAT_SCOPE_INHERIT_HINT,
  PAT_SCOPE_INHERIT_TITLE,
  REVOKE_WARNING,
  TOKEN_ONCE_WARNING,
} from "./pat-labels";

function render(node: ReactElement, seed?: { pats?: PatMetadata[] }): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } } });
  if (seed?.pats) qc.setQueryData(PAT_QK.list, seed.pats);
  return rtsRaw(<QueryClientProvider client={qc}>{node}</QueryClientProvider>).replace(/<!--[^>]*-->/g, "");
}

const TS = "2026-09-18T00:00:00.000Z";

function pat(over: Partial<PatMetadata> = {}): PatMetadata {
  return {
    id: "pat_1",
    name: "数据同步脚本",
    tokenPrefix: "gxpat_abcd1234",
    scopes: ["record:read", "doc:read", "canvas:read"],
    expiresAt: "2026-12-17T00:00:00.000Z",
    revokedAt: null,
    lastUsedAt: null,
    createdAt: TS,
    ...over,
  };
}

describe("PatListPanel 列表渲染", () => {
  it("空态：显示引导文案，不渲染列表表头", () => {
    const html = render(<PatListPanel />, { pats: [] });
    expect(html).toContain("还没有令牌");
    // 表头独有列名（新建表单不含），确认无数据时不渲染表格
    expect(html).not.toContain("从未使用");
  });

  // 语义适配（P3）：权限范围徽标下线，改只读说明「权限跟随签发者账号」——
  // 断言从"出现中文 scope 标签"换成"出现继承说明且不出现原始 scope 串"。
  it("有数据：渲染名称/前缀/权限继承说明/状态/从未使用", () => {
    const html = render(<PatListPanel />, { pats: [pat()] });
    expect(html).toContain("数据同步脚本");
    expect(html).toContain("gxpat_abcd1234");
    expect(html).toContain(PAT_SCOPE_INHERIT_TITLE);
    expect(html).toContain("有效");
    expect(html).toContain("从未使用");
    // 不再渲染权限范围：库里那份 scopes 既不展示中文标签也不出现原始串
    expect(html).not.toContain("读取数据表");
    expect(html).not.toContain("record:read");
    expect(html).not.toContain("canvas:read");
  });

  it("已吊销行：状态为「已吊销」且不提供吊销按钮，改显占位", () => {
    const html = render(<PatRow pat={pat({ revokedAt: "2026-09-19T00:00:00.000Z" })} onRevoke={() => undefined} />);
    expect(html).toContain("已吊销");
    expect(html).not.toContain(">吊销<");
  });

  it("有效行：提供吊销按钮；永不过期显「永不过期」", () => {
    const html = render(<PatRow pat={pat({ expiresAt: null })} onRevoke={() => undefined} />);
    expect(html).toContain(">吊销<");
    expect(html).toContain("永不过期");
  });
});

// 语义适配（P3）：六位 scope 勾选区已移除（能力按签发者账号实时计算，勾选不再改变任何能力）。
// 断言从"默认勾选哪几档"换成"没有任何 scope 勾选框 + 有效期默认 90 + 权限继承说明在位"。
describe("新建表单：无权限勾选区（C-2 六位 scope 下线）", () => {
  it("不存在任何权限范围勾选框；默认有效期为 90 天；权限改为继承说明", () => {
    const html = render(<CreatePatForm onCreate={() => undefined} />);
    const boxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(boxes.length).toBe(0);
    // 有效期 select 默认 90
    expect(html).toMatch(/<option[^>]*value="90"[^>]*selected/);
    // 权限口径只剩"跟随签发者账号"，不再出现六位标签
    expect(html).toContain(PAT_SCOPE_INHERIT_TITLE);
    expect(html).not.toContain("读取数据表");
    expect(html).not.toContain("写入画布");
  });
});

describe("接入方式块：端点地址按当前站点动态生成", () => {
  it("SSR 无 location 时退回同源相对路径，绝不写死 localhost/域名", () => {
    const html = render(<PatListPanel />, { pats: [] });
    expect(html).toContain("/mcp");
    expect(html).not.toContain("localhost");
    expect(html).not.toContain("http://");
    expect(html).toContain("Authorization");
    expect(html).toContain("Bearer");
  });

  it("源码层面：端点由 location.origin + withBase(\"/mcp\") 拼出（子路径部署不写死）", () => {
    const src = readFileSync(fileURLToPath(new URL("./PatListPanel.tsx", import.meta.url)), "utf8");
    expect(src).toContain("withBase(\"/mcp\")");
    expect(src).toContain("location.origin");
    expect(src).not.toMatch(/https?:\/\/(localhost|127\.0\.0\.1)/);
  });
});

describe("一次性明文弹窗（关闭即焚）", () => {
  const token = "gxpat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  it("token 存在：显示完整明文 + 仅显示一次强提示 + 复制按钮", () => {
    const html = render(<PatTokenModal token={token} name="脚本" onClose={() => undefined} />);
    expect(html).toContain(token);
    expect(html).toContain(TOKEN_ONCE_WARNING);
    expect(html).toContain("仅显示一次，关闭后不可找回");
    expect(html).toContain("复制令牌");
  });

  it("token 为 null（已关闭）：不渲染任何明文（焚毁呈现层保证）", () => {
    const html = render(<PatTokenModal token={null} name="脚本" onClose={() => undefined} />);
    expect(html).not.toContain(token);
    expect(html).not.toContain("gxpat_");
    expect(html.trim()).toBe("");
  });
});

describe("吊销 / 永不过期二次确认", () => {
  it("吊销确认弹窗：含强提示与确认按钮；pat=null 不渲染", () => {
    const open = render(<RevokeConfirmModal pat={pat()} busy={false} onClose={() => undefined} onConfirm={() => undefined} />);
    expect(open).toContain(REVOKE_WARNING);
    expect(open).toContain("确认吊销");
    const closed = render(<RevokeConfirmModal pat={null} busy={false} onClose={() => undefined} onConfirm={() => undefined} />);
    expect(closed.trim()).toBe("");
  });

  it("永不过期强警示：open 时渲染警示文案与「仍然签发」，关闭时不渲染", () => {
    const open = render(<NeverExpiryConfirmModal open busy={false} onClose={() => undefined} onConfirm={() => undefined} />);
    expect(open).toContain(NEVER_EXPIRY_WARNING);
    expect(open).toContain("仍然签发");
    const closed = render(<NeverExpiryConfirmModal open={false} busy={false} onClose={() => undefined} onConfirm={() => undefined} />);
    expect(closed.trim()).toBe("");
  });
});

describe("令牌明文不落 storage / URL（源码级回归守卫）", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  beforeEach(() => vi.clearAllMocks());

  it("PatListPanel/PatTokenModal 均无 localStorage/sessionStorage/URL 写入", () => {
    for (const f of ["./PatListPanel.tsx", "./PatTokenModal.tsx", "./pat-hooks.ts"]) {
      const src = read(f);
      expect(src).not.toContain("localStorage");
      expect(src).not.toContain("sessionStorage");
      expect(src).not.toContain("history.pushState");
      expect(src).not.toContain("history.replaceState");
    }
  });

  it("一次性明文只来自创建响应 state，前端不持久化 token 字段", () => {
    const src = read("./PatListPanel.tsx");
    // token 仅来自 create 成功回调的 state，onClose 置 null（焚毁）
    expect(src).toContain("setCreated(null)");
    expect(src).toContain("token: r.token");
  });
});
