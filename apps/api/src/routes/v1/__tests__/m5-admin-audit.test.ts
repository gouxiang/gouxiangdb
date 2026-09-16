// M5/S9 admin 管理面审计留痕（脱敏）：真 createApp + role_owner，触发 config 变更/key 轮换/
// 清除/reindex，断言 audit.logl 落对应事件且全文不含明文 key（M5-implementation-plan §9）。
// 独立夹具（setupOrgHarness），与六端点形状测试隔离；每个测试文件独立 worker，env 互不串。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setupOrgHarness, json, type OrgHarness } from "../org/__tests__/orgHarness.js";

const PREV_M5 = process.env.GX_M5_SEARCH;
let h: OrgHarness;

beforeAll(async () => {
  process.env.GX_M5_SEARCH = "on";
  h = await setupOrgHarness();
  await h.createUser("aud-owner");
  await h.grantSystemRole("aud-owner", "owner");
}, 120000);

afterAll(async () => {
  if (PREV_M5 === undefined) delete process.env.GX_M5_SEARCH;
  else process.env.GX_M5_SEARCH = PREV_M5;
  await h.cleanup();
});

describe("M5/S9 审计事件落盘且脱敏", () => {
  it("config/key/rotate/clear/reindex 五事件齐全，审计体不含明文 key", async () => {
    const headers = { "Content-Type": "application/json", ...(await h.auth("aud-owner")) };
    const patch = await h.app.request("/api/v1/admin/embedding/config", {
      method: "PATCH", headers,
      body: JSON.stringify({ baseURL: "https://embed.example/v1", model: "m-audit" }),
    });
    expect(patch.status).toBe(200);

    const rotate = await h.app.request("/api/v1/admin/embedding/api-key/rotate", {
      method: "POST", headers, body: JSON.stringify({ apiKey: "audit-secret-plaintext-5555" }),
    });
    expect(rotate.status).toBe(200);
    expect((await json<{ maskedLast4: string }>(rotate)).maskedLast4).toBe("5555");

    const clear = await h.app.request("/api/v1/admin/embedding/api-key", {
      method: "DELETE", headers,
    });
    expect(clear.status).toBe(204);

    const reindex = await h.app.request("/api/v1/admin/reindex", {
      method: "POST", headers, body: JSON.stringify({}),
    });
    expect(reindex.status).toBe(202);
    const mod = await import("../../../domain/search/reindex.js");
    await mod.currentReindex?.();

    const auditFile = path.join(h.tmpDir, ".audit", "audit.logl");
    const lines = fs.existsSync(auditFile)
      ? fs.readFileSync(auditFile, "utf8").split("\n").filter(Boolean)
      : [];
    const events = lines.map((l) => JSON.parse(l).event as string);
    for (const e of [
      "embedding_config_changed",
      "embedding_api_key_rotated",
      "embedding_api_key_cleared",
      "search_reindex_started",
    ]) {
      expect(events, `缺事件 ${e}`).toContain(e);
    }
    const blob = lines.join("\n");
    expect(blob).not.toContain("audit-secret-plaintext-5555");
    expect(blob).not.toMatch(/apiKey"\s*:\s*"[^*[]/);
  });
});
