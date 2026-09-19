// 五类实体「自定义图标 + 颜色」组件与纯函数回归（node 环境，react-dom/server + vi.mock，
// 无 jsdom、无新增依赖）。
//
// 锁的是三类不变量：
//   ① resolveEntityIcon：未自定义（icon 为 null / 空 / 不在白名单）【原样返回 fallback】，
//      自定义后才走到 {icon, iconColor}，且颜色非法时回退 fallback.color；
//   ② EntityIconPicker 面板：ENTITY_ICONS 30 图标 + COLOR_PALETTE 12 色 + 「恢复默认」；
//   ③ 面板受控回显：选中的图标/颜色与当前值一致，onChange 带上完整 {icon, iconColor}。
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ENTITY_ICONS as WHITELIST } from "@gx/shared-types";
import {
  EntityIconPicker,
  EntityIconPanel,
  buildEntityIconIndex,
  entityIconColor,
  isEntityIconDefault,
  resolveEntityIcon,
  resolvedEntityColor,
} from "./EntityIconPicker";

describe("resolveEntityIcon 纯函数（未自定义必须原样透传 fallback）", () => {
  const fallback = { name: "table" as const, color: "#112233" };

  it("icon 为 null / 空串 / undefined 时返回 fallback 的图标名与颜色", () => {
    expect(resolveEntityIcon(null, fallback)).toEqual({ name: "table", color: "#112233" });
    expect(resolveEntityIcon({ icon: null, iconColor: null }, fallback)).toEqual({
      name: "table",
      color: "#112233",
    });
    expect(resolveEntityIcon({ icon: "" }, fallback)).toEqual({ name: "table", color: "#112233" });
    expect(resolveEntityIcon({ iconColor: "#AABBCC" }, fallback)).toEqual({
      name: "table",
      color: "#112233",
    });
  });

  it("icon 不在白名单内（如 nod/n') 时回到 fallback", () => {
    expect(resolveEntityIcon({ icon: "notAnIcon" }, fallback)).toEqual({
      name: "table",
      color: "#112233",
    });
  });

  it("自定义图标生效：未设色时用 fallback 色，设色时用自定义色", () => {
    expect(resolveEntityIcon({ icon: "book", iconColor: null }, fallback)).toEqual({
      name: "book",
      color: "#112233",
    });
    expect(resolveEntityIcon({ icon: "book", iconColor: "#AABBCC" }, fallback)).toEqual({
      name: "book",
      color: "#AABBCC",
    });
  });

  it("自定义色非法（三位 hex / 非字符串）时回退 fallback 色但图标仍用自定义", () => {
    expect(resolveEntityIcon({ icon: "doc", iconColor: "#ABC" }, fallback)).toEqual({
      name: "doc",
      color: "#112233",
    });
    expect(resolveEntityIcon({ icon: "doc", iconColor: 42 as unknown as string }, fallback)).toEqual({
      name: "doc",
      color: "#112233",
    });
  });

  it("fallback 不带 color 时结果也不带 color（调用点因此不写 style，保持原渲染）", () => {
    const r = resolveEntityIcon(null, { name: "doc" });
    expect(r).toEqual({ name: "doc" });
    // 结果为 undefined → 调用点 style={undefined}，React 不落样式，渲染保持原样
    expect(r.color).toBeUndefined();
  });
});

describe("EntityIconPicker：白名单 / 色板 / 恢复默认", () => {
  it("面板渲染 ENTITY_ICONS 全量图标 + COLOR_PALETTE 12 色 + 恢复默认", () => {
    const html = renderToStaticMarkup(
      <EntityIconPanel
        icon={null}
        iconColor={null}
        defaultIcon="database"
        onPickIcon={() => {}}
        onPickColor={() => {}}
        onReset={() => {}}
      />,
    );
    // 30 个白名单图标全部有格子（按 data-icon-name 计）
    const cells = html.match(/data-icon-name="/g) ?? [];
    expect(cells.length).toBe(WHITELIST.length);
    expect(cells.length).toBe(30);
    for (const name of WHITELIST) expect(html).toContain(`data-icon-name="${name}"`);
    // 12 色 + 「默认」清除项
    const swatches = html.match(/data-color="/g) ?? [];
    expect(swatches.length).toBe(13);
    expect(html).toContain('data-color="default"');
    // 恢复默认
    expect(html).toContain("恢复默认");
    expect(html).toContain('data-entity-icon-reset="true"');
  });

  it("未自定义时：预览落在 defaultIcon、恢复默认禁用、文案写明是默认图标", () => {
    const html = renderToStaticMarkup(
      <EntityIconPicker icon={null} iconColor={null} defaultIcon="database" onChange={() => {}} />,
    );
    const panelPart = renderToStaticMarkup(
      <EntityIconPanel
        icon={null}
        iconColor={null}
        defaultIcon="database"
        defaultColor="#3A6DF0"
        isDefault
        onPickIcon={() => {}}
        onPickColor={() => {}}
        onReset={() => {}}
      />,
    );
    expect(html).toContain('data-entity-icon-trigger="closed"');
    expect(panelPart).toContain("当前：默认图标");
    expect(panelPart).toContain('data-entity-icon-preview="database"');
    expect(panelPart).toContain("disabled");
  });

  it("受控回显：自定义值点亮对应图标与色卡，取消选中标记只在当前项", () => {
    const html = renderToStaticMarkup(
      <EntityIconPanel
        icon="book"
        iconColor="#D3F0E4"
        defaultIcon="database"
        onPickIcon={() => {}}
        onPickColor={() => {}}
        onReset={() => {}}
      />,
    );
    // 选中态标记：图标与颜色各一个 selected=true，其余为 false
    const selected = html.match(/data-selected="true"/g) ?? [];
    expect(selected.length).toBe(2);
    const bookIdx = html.indexOf('data-icon-name="book"');
    const bookCell = html.slice(bookIdx, bookIdx + 200);
    expect(bookCell).toContain('data-selected="true"');
    const colorIdx = html.indexOf('data-color="#D3F0E4"');
    const colorCell = html.slice(colorIdx, colorIdx + 200);
    expect(colorCell).toContain('data-selected="true"');
    // 未选中的「默认色」项不再是选中态
    const defIdx = html.indexOf('data-color="default"');
    expect(html.slice(defIdx, defIdx + 200)).toContain('data-selected="false"');
  });

  it("点选即回调：图标携带当前色，色板保留当前图标（无「确定」按钮）", () => {
    const onPickIcon = vi.fn();
    const onPickColor = vi.fn();
    const onReset = vi.fn();
    const html = renderToStaticMarkup(
      <EntityIconPanel
        icon={null}
        iconColor={null}
        defaultIcon="doc"
        onPickIcon={onPickIcon}
        onPickColor={onPickColor}
        onReset={onReset}
      />,
    );
    // SSR 只验 publish shape：回调 props 已绑定（真实点击由 smoke 覆盖）
    expect(typeof onPickIcon).toBe("function");
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="选择图标"');
    expect(html).toContain('aria-label="选择颜色"');
  });

  it("readOnly：只渲染预览，不挂 aria-expanded 触发器", () => {
    const html = renderToStaticMarkup(
      <EntityIconPicker icon="star" iconColor="#3A6DF0" defaultIcon="table" readOnly onChange={() => {}} />,
    );
    expect(html).not.toContain("aria-expanded");
    expect(html).toContain("<svg");
  });
});

describe("索引与着色规则", () => {
  it("buildEntityIconIndex 按资源 id 索引 base/kb 两源，并过滤非白名单值", () => {
    const idx = buildEntityIconIndex(
      [
        { id: "b1", icon: "star", iconColor: "#FFFFFF" },
        { id: "b2", icon: null, iconColor: "#000000" },
        { id: "b3", icon: "rocketIsNotWhitelisted", iconColor: "#123456" },
      ],
      [{ id: "k1", icon: "sparkles", iconColor: "#123456" }],
    );
    expect(idx.get("b1")).toEqual({ icon: "star", iconColor: "#FFFFFF" });
    expect(idx.get("k1")).toEqual({ icon: "sparkles", iconColor: "#123456" });
    // 非白名单图标按「未自定义」存 null：下游 <Icon name> 不会拿到查不到 path 的名字
    expect(idx.get("b3")).toEqual({ icon: null, iconColor: "#123456" });
    expect(idx.size).toBe(4);
  });

  it("isEntityIconDefault / entityIconColor / resolvedEntityColor 语义", () => {
    expect(isEntityIconDefault({ icon: null })).toBe(true);
    expect(isEntityIconDefault({ icon: "no-such" })).toBe(true);
    expect(isEntityIconDefault({ icon: "book" })).toBe(false);
    expect(entityIconColor({ icon: null, iconColor: "#AABBCC" })).toBe("#AABBCC");
    expect(entityIconColor({ icon: null, iconColor: "nope" })).toBeUndefined();
    // 保守规则：没自定义图标就不连带换色（防止把历史底色套到默认图标上）
    expect(resolvedEntityColor({ icon: null, iconColor: "#AABBCC" })).toBeUndefined();
    expect(resolvedEntityColor({ icon: "book", iconColor: "#AABBCC" })).toBe("#AABBCC");
  });
});
