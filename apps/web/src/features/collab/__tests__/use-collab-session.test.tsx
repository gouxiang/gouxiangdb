// 阶段 1 · hook 契约回归。
//
// 环境限制（如实记录）：本仓 vitest 跑的是 node 环境且**没有 jsdom**（既有的 React 单测
// 一律用 react-dom/server 的 renderToString），而 useEffect 在服务端渲染里不执行 →
// 本文件只能断言「渲染期不崩 + 初始返回形状正确」。连接建立 / 名单兜底 / 卸载断连这些
// 走 effect 的行为，其下层连接逻辑已由 collab-provider.test.ts 覆盖，
// effect 接线本身留到阶段 2（按 D6 UI 冻结，本阶段不允许把它接进页面）。
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { useCollabSession } from "../useCollabSession";

function Probe({ roomId }: { roomId: string | null }) {
  const session = useCollabSession(roomId);
  return `${session.status}|${session.entries.length}|${session.doc === null}`;
}

describe("useCollabSession", () => {
  it("roomId 为 null（未启用协同）时返回 idle 初态，不建立任何连接", () => {
    expect(renderToString(<Probe roomId={null} />)).toBe("idle|0|true");
  });

  it("给定 roomId 也能安全渲染：初态 idle、doc 尚未产出", () => {
    expect(renderToString(<Probe roomId="doc:abc" />)).toBe("idle|0|true");
  });
});
