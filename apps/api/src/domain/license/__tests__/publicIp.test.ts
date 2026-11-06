/**
 * 公网出口 IP 探测：成功回显 / 非 200 / 超时中止 / 网络错 / 形状错 全部安全回落 null，永不抛错。
 * 全程注入假 fetch，零真实出网。
 */
import { describe, it, expect, vi } from "vitest";
import { resolvePublicIp, PUBLIC_IP_TIMEOUT_MS } from "../publicIp.js";

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response;
}

describe("resolvePublicIp", () => {
  it("默认超时 3000ms", () => {
    expect(PUBLIC_IP_TIMEOUT_MS).toBe(3000);
  });

  it("200 {ip}（容忍额外字段）返回 IPv4；URL 拼接去尾斜杠且带超时 signal", async () => {
    const fetchImpl = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse(200, { ip: "183.252.182.132", via: "edge", t: 1 }),
    );
    const ip = await resolvePublicIp("https://lic.example/", { fetchImpl });
    expect(ip).toBe("183.252.182.132");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://lic.example/v1/my-ip");
    expect(init?.method).toBe("GET");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("非 200 返回 null", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { error: "boom" }));
    expect(await resolvePublicIp("https://lic.example", { fetchImpl })).toBeNull();
  });

  it("超时/AbortError reject → null，不抛错", async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    const fetchImpl = vi.fn(async () => {
      throw err;
    });
    expect(await resolvePublicIp("https://lic.example", { fetchImpl })).toBeNull();
  });

  it("网络错误 reject → null", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await resolvePublicIp("https://lic.example", { fetchImpl })).toBeNull();
  });

  it("形状错/非法 ip 返回 null", async () => {
    const bodies: unknown[] = [null, {}, { ip: 123 }, { ip: "not-an-ip" }, { ip: "999.1.1.1" }, { address: "1.2.3.4" }];
    for (const body of bodies) {
      const fetchImpl = vi.fn(async () => jsonResponse(200, body));
      expect(await resolvePublicIp("https://lic.example", { fetchImpl })).toBeNull();
    }
  });

  it("body 非 JSON（res.json 抛错）→ null", async () => {
    const res = {
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => res);
    expect(await resolvePublicIp("https://lic.example", { fetchImpl })).toBeNull();
  });

  it("自定义 timeoutMs 透传（signal 存在即可，不真实等待）", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ip: "1.2.3.4" }));
    expect(await resolvePublicIp("https://lic.example", { timeoutMs: 1, fetchImpl })).toBe("1.2.3.4");
  });
});
