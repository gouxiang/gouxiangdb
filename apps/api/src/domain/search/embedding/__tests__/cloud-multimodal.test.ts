// cloud 多模态向量化测试（#563）：本地 node:http mock，不打真外网。
// 覆盖：端点拼 /embeddings/multimodal；逐 item 请求并回向量；失败 item 给零长不阻断；
// CloudProvider.embedMultimodal 端到端；请求体含图片在前文本在后。

import { describe, expect, it } from "vitest";
import http from "node:http";
import type { MultimodalEmbedItem } from "@gx/shared-types";
import { embedMultimodalBatch } from "../cloud-multimodal.js";
import { createCloudProvider } from "../cloud.js";

interface MockServer { url: string; close: () => void; bodies: unknown[]; paths: string[]; }

function startServer(
  handler: (req: http.IncomingMessage, body: unknown, res: http.ServerResponse) => void,
): Promise<MockServer> {
  return new Promise((resolve) => {
    const bodies: unknown[] = [];
    const paths: string[] = [];
    const srv = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        bodies.push(body);
        paths.push(req.url ?? "");
        handler(req, body, res);
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => srv.close(), bodies, paths });
    });
  });
}

const items: MultimodalEmbedItem[] = [
  { text: "任务A", images: ["data:image/png;base64,AA"] },
  { text: "任务B", images: [] },
  { text: "任务C", images: [] },
];

describe("embedMultimodalBatch", () => {
  it("逐 item 请求，回等长向量，端点为 /embeddings/multimodal", async () => {
    const srv = await startServer((_req, _b, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { embedding: [0.1, 0.2, 0.3] } }));
    });
    const out = await embedMultimodalBatch(items, {
      endpoint: `${srv.url}/embeddings/multimodal`,
      apiKey: "k", model: "m", timeoutMs: 3000, fetchImpl: fetch,
    }, 2);
    expect(out).toHaveLength(3);
    for (const v of out) expect(v).toHaveLength(3);
    expect(srv.paths.every((p) => p.startsWith("/embeddings/multimodal"))).toBe(true);
    srv.close();
  });

  it("失败 item 给零长向量，不阻断其它", async () => {
    let n = 0;
    const srv = await startServer((_req, _b, res) => {
      n += 1;
      if (n === 2) { res.statusCode = 500; res.end("err"); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { embedding: [1, 2] } }));
    });
    const out = await embedMultimodalBatch(items, {
      endpoint: `${srv.url}/embeddings/multimodal`,
      apiKey: "k", model: "m", timeoutMs: 3000, fetchImpl: fetch,
    }, 1);
    expect(out[0]).toHaveLength(2);
    expect(out[1]).toHaveLength(0);
    expect(out[2]).toHaveLength(2);
    srv.close();
  });

  it("请求体图片在前、文本在后", async () => {
    const srv = await startServer((_req, _b, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { embedding: [1] } }));
    });
    await embedMultimodalBatch([items[0]!], {
      endpoint: `${srv.url}/embeddings/multimodal`,
      apiKey: "k", model: "doubao-embedding-vision", timeoutMs: 3000, fetchImpl: fetch,
    }, 1);
    const body = srv.bodies[0] as { model: string; input: Array<{ type: string }> };
    expect(body.model).toBe("doubao-embedding-vision");
    expect(body.input[0]!.type).toBe("image_url");
    expect(body.input[1]!.type).toBe("text");
    srv.close();
  });
});

describe("CloudProvider.embedMultimodal 端到端", () => {
  it("走多模态端点回向量", async () => {
    const srv = await startServer((_req, _b, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { embedding: [0.5, 0.5] } }));
    });
    const p = createCloudProvider({
      baseURL: srv.url, apiKey: "k", model: "m", batchSize: 64, timeoutMs: 3000,
    }, { concurrency: 1, retryBaseMs: 0 });
    const out = await p.embedMultimodal!(items);
    expect(out).toHaveLength(3);
    srv.close();
  });
});
