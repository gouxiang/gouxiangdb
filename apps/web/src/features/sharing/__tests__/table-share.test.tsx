// 分享档位两档（只读 / 可编辑）回归（node 环境，react-dom/server + 纯函数，无 jsdom、无新增依赖）。
//
// 锁的是 2026-09 分享权限改版的三条：
//   ①「可编辑」只有在分享人本人此刻有编辑权时可选，否则**置灰 + 说明原因**（不是隐藏、
//      也不是点了才报错）；
//   ② 分享人后来被降权时，链接自动回落只读（后端每次访问现算的 degraded），界面必须把
//      「已自动变为只读」说出来，档位显示一律用 effectiveMode 而不是创建时的 mode；
//   ③ 置灰不是防线：后端 POST 会再判一次，403 的原始文案原样 toast（不改写、不带
//      "API 403: " 前缀）。
//
// 渲染口径与同目录既有测试一致：能 SSR 的一律真渲染后断言 DOM；浮层（Modal / Popover 走
// createPortal）在 node 下渲染不出内容，那部分退到源码断言。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { ObjectShareLinkDTO } from "@gx/shared-types";
import { ApiError } from "../../../api/client";
import { toastSnapshot } from "../../../components/ui";
import { SHARE_MODE_HINT } from "../../../features/settings/role-permission/labels";
import { ShareModeField } from "../ShareModeField";
import { ShareLinkList } from "../ShareLinkList";
import { shareErrorMessage, submitTableShare } from "../share-hooks";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const noop = () => undefined;

/**
 * 取出含某段文案的按钮的**属性串**（开标签到第一个 ">" 为止）。
 * 只看属性、不看 class：Tailwind 的 `disabled:cursor-not-allowed` 里也有 disabled 字样，
 * 直接对整段做 includes("disabled") 会把「可点」误判成「禁用」。
 */
function attrsOf(html: string, label: string): string {
  const seg = html.split("<button").find((s) => s.includes(label));
  if (!seg) throw new Error(`未找到含「${label}」的按钮`);
  return seg.slice(0, seg.indexOf(">"));
}
const isDisabled = (html: string, label: string) => /\sdisabled(=|\s)/.test(attrsOf(html, label));

function link(over: Partial<ObjectShareLinkDTO>): ObjectShareLinkDTO {
  return {
    id: "link-1",
    token: "tok-1",
    objectType: "table",
    objectId: "tbl-1",
    baseId: "base-1",
    viewId: null,
    mode: "edit",
    effectiveMode: "edit",
    degraded: false,
    canEdit: true,
    createdBy: "u1",
    expiresAt: null,
    createdAt: "2026-09-20T10:00:00.000Z",
    url: "/s/tok-1",
    ...over,
  };
}

const DISABLED_REASON = "你本人对这张表没有编辑权，因此不能创建可编辑的分享链接";

describe("① 无编辑权时「可编辑」档位置灰并说明原因", () => {
  it("canGrantEdit=false：可编辑按钮 disabled，且下方给出原因", () => {
    const html = render(
      <ShareModeField value="view" onChange={noop} canGrantEdit={false} disabledReason={DISABLED_REASON} />,
    );
    expect(isDisabled(html, "可编辑")).toBe(true);
    expect(html).toContain(DISABLED_REASON);
    // 只读档位不受影响：它永远可选
    expect(isDisabled(html, "只读")).toBe(false);
  });

  it("canGrantEdit=true：可编辑按钮可点，不再给置灰原因", () => {
    const html = render(
      <ShareModeField value="view" onChange={noop} canGrantEdit disabledReason={DISABLED_REASON} />,
    );
    expect(isDisabled(html, "可编辑")).toBe(false);
    expect(html).not.toContain(DISABLED_REASON);
  });

  it("两档都在界面上（不可编辑时不隐藏这一档，只置灰）", () => {
    const html = render(<ShareModeField value="view" onChange={noop} canGrantEdit={false} />);
    expect(html).toContain("只读");
    expect(html).toContain("可编辑");
  });
});

describe("② degraded=true 时展示降级提示，档位按 effectiveMode 显示", () => {
  it("已降级链接：显示「已自动变为只读」提示，生效档位显示只读", () => {
    const html = render(
      <ShareLinkList
        links={[link({ mode: "edit", effectiveMode: "view", degraded: true, canEdit: false })]}
        onCopy={noop}
        onRevoke={noop}
      />,
    );
    expect(html).toContain("分享人已失去编辑权，此链接已自动变为只读");
    // 生效档位取 effectiveMode，不是创建时的 mode
    expect(html).toContain("生效：只读");
    expect(html).not.toContain("生效：可编辑");
  });

  it("未降级的可编辑链接：显示可编辑，不出现降级提示", () => {
    const html = render(
      <ShareLinkList links={[link({ mode: "edit", effectiveMode: "edit", degraded: false })]} onCopy={noop} onRevoke={noop} />,
    );
    expect(html).toContain("生效：可编辑");
    expect(html).not.toContain("已自动变为只读");
  });

  it("同一列表里两条 edit 链接，只有 degraded 那条带提示（档位是每条独立现算的）", () => {
    const html = render(
      <ShareLinkList
        links={[
          link({ id: "a", mode: "edit", effectiveMode: "edit", degraded: false }),
          link({ id: "b", token: "tok-2", url: "/s/tok-2", mode: "edit", effectiveMode: "view", degraded: true }),
        ]}
        onCopy={noop}
        onRevoke={noop}
      />,
    );
    const rows = html.split('border-b border-gx-separator').slice(1);
    expect(rows[0]).not.toContain("已自动变为只读");
    expect(rows[1]).toContain("已自动变为只读");
  });

  it("空列表走空态，不报错", () => {
    expect(render(<ShareLinkList links={[]} onCopy={noop} onRevoke={noop} />)).toContain("还没有分享链接");
  });
});

describe("③ 后端 403 的原始文案原样 toast（置灰不是防线）", () => {
  it("建「可编辑」被后端拒：toast 出 body.error 原文，不带 API 状态码前缀", async () => {
    const raw = "只有本人对该数据表有编辑权时才能创建可编辑分享";
    const ok = await submitTableShare({
      tableId: "tbl-1",
      mode: "edit",
      create: () => Promise.reject(new ApiError(403, { error: raw, code: "FORBIDDEN" })),
    });
    expect(ok).toBe(false);
    const snapped = toastSnapshot();
    expect(snapped.some((t) => t.kind === "error" && t.message === raw)).toBe(true);
    // 「API 403: …」这种带前缀的拼装文案不允许出现——那是给日志的，不是给用户的
    expect(snapped.some((t) => t.message.includes("API 403"))).toBe(false);
  });

  it("两级「允许分享」开关没开时同样原样透出（不替换成前端措辞）", async () => {
    const raw = "该数据表未开启分享（需库级与表级「允许分享」开关都打开）";
    await submitTableShare({
      tableId: "tbl-1",
      mode: "view",
      create: () => Promise.reject(new ApiError(403, { error: raw })),
    });
    expect(toastSnapshot().some((t) => t.message === raw)).toBe(true);
  });

  it("shareErrorMessage 只取后端可读文案，取不到才用兜底", () => {
    expect(shareErrorMessage(new ApiError(403, { error: "无权访问该数据表" }), "兜底")).toBe("无权访问该数据表");
    expect(shareErrorMessage(new Error("网络断了"), "兜底")).toBe("网络断了");
    expect(shareErrorMessage(new ApiError(500, {}), "兜底")).toBe("兜底");
    expect(shareErrorMessage(null, "兜底")).toBe("兜底");
  });
});

describe("④ 入口接线（浮层无法 SSR，退源码断言）", () => {
  it("数据表视图「更多」菜单里有「分享」，外壳挂载 TableShareModal", () => {
    const toolbar = read("../../../features/grid/GridToolbar.tsx");
    expect(toolbar).toContain('label="分享"');
    expect(toolbar).toContain("onShare");

    const shell = read("../../../features/views/ViewShell.tsx");
    expect(shell).toContain("<TableShareModal");
    // 能否开「可编辑」由后端 GET /share 现算的 canGrantEdit 决定：ViewShell 不再传权限位。
    // 库级 canEditData 是聚合信号（本库任一表可写即为真），拿它置灰会偏松。
    expect(shell).not.toContain("canEditSelf");
    const modal = read("../../../features/sharing/TableShareModal.tsx");
    expect(modal).toContain("canGrantEdit");
  });

  it("文档分享弹窗恢复两档：不再写「一律只读」，且说清作用范围与降级", () => {
    const modal = read("../../../features/kb/ShareModal.tsx");
    expect(modal).toContain("<ShareModeField");
    expect(modal).not.toContain("分享链接一律只读");
    expect(modal).toContain("ShareDegradedNote");
    // 正文匿名编辑已开放：文案必须说清「可编辑」作用于正文 + 嵌入的数据表、
    // 是链接级能力（不改系统内角色权限）、且分享人降权后会自动回落只读。
    expect(modal).toContain("自动回落为只读");
    expect(modal).not.toContain("正文仍不可改");
  });

  it("过期的「外发一律只读」文案已下线（labels 常量改名并两处引用同步）", () => {
    const labels = read("../../../features/settings/role-permission/labels.ts");
    expect(labels).toContain("SHARE_MODE_HINT");
    expect(labels).not.toContain("SHARE_READONLY_HINT");
    // 文案本身必须说清两档与动态降级，而不是"外发恒只读"
    expect(SHARE_MODE_HINT).toContain("可编辑");
    expect(SHARE_MODE_HINT).toContain("自动回落只读");
    expect(SHARE_MODE_HINT).not.toContain("恒为只读");
    for (const f of [
      "../../../features/settings/ShareLinksPanel.tsx",
      "../../../features/settings/role-permission/ShareToggleBlock.tsx",
    ]) {
      expect(read(f)).toContain("SHARE_MODE_HINT");
      expect(read(f)).not.toContain("SHARE_READONLY_HINT");
    }
  });
});
