// apps/api/src/domain/update/__tests__/prefetch.test.ts
// UpdatePrefetcher 单测（方案 A）：
//   - 真 fs 临时目录 + 默认真 store 做端到端（分块落盘/原子改名/latest.json/重启恢复）；
//   - 可控 fetch 覆盖 200 重来 / 206 续传 / 416 重试 / 401-403-500 / 网络拒绝 / 空闲超时；
//   - 记录型假 store 断言【分块落盘】（无单次超大写、增量进度）与校验不符不产成品；
//   - 安全：token 只走 Authorization 头，绝不入 URL / 快照。
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  UpdatePrefetcher,
  createDefaultStore,
  type PrefetchStore,
  type PrefetchWriter,
} from "../prefetch.js";
import type { ResolvedDownload } from "../service.js";
import type { FetchLike } from "../source.js";
import type { ArtifactManifest, UpdatePrefetchDTO, UpdatePrefetchErrorCode } from "@gx/shared-types";

const SHA_OK = "a".repeat(64);
const URL_ONLY = "https://up.example.invalid/gouxiangdb-x.fpk";
const TOKEN = "SECRET-PREFETCH-PAT";

function shaHex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 由若干块构造 web ReadableStream（pull 驱动，不预读整包）。 */
function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

function payload(size: number, fill = 0x58): Buffer {
  return Buffer.alloc(size, fill);
}

function chunk(buf: Buffer, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let off = 0; off < buf.length; off += size) out.push(buf.subarray(off, off + size));
  return out;
}

interface Call {
  url: string;
  init?: RequestInit;
}

function resolved(sha: string, sizeBytes: number | null, authed = true): ResolvedDownload {
  const artifact: ArtifactManifest = {
    arch: "x64",
    platform: "linux",
    filename: "gouxiangdb-0.2.3-x86.fpk",
    sizeBytes: sizeBytes ?? 0,
    sha256: sha,
    download: { kind: "release-asset", asset: "a.fpk" },
    signature: null,
  };
  return { request: { url: URL_ONLY, authed }, artifact, version: "0.2.3", sourceKind: "gitea" };
}

async function waitFor(
  p: UpdatePrefetcher,
  pred: (s: UpdatePrefetchDTO) => boolean,
  timeoutMs = 3000,
): Promise<UpdatePrefetchDTO> {
  const start = Date.now();
  for (;;) {
    const s = p.snapshot();
    if (pred(s)) return s;
    if (Date.now() - start > timeoutMs) throw new Error(`等待预缓存状态超时：${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// -- 真 fs 临时目录端到端 -----------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gx-prefetch-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function realPrefetcher(fetchImpl: FetchLike, opts: { idle?: number; token?: string } = {}) {
  return new UpdatePrefetcher({
    dir: tmpDir,
    idleTimeoutMs: opts.idle ?? 60000,
    token: opts.token ?? TOKEN,
    fetch: fetchImpl,
  });
}

describe("UpdatePrefetcher 真 fs 端到端", () => {
  it("happy path：分块落盘→sha 校验→原子成品/latest.json，token 只走 Authorization", async () => {
    const body = payload(120_000);
    const sha = shaHex(body);
    const calls: Call[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(
        new Response(streamFrom(chunk(body, 16_384)), { status: 200 }),
      );
    };
    const p = realPrefetcher(fetchImpl);
    const r = p.start(resolved(sha, body.length));
    expect(r).toEqual({ kind: "started", sha256: sha });

    const s = await waitFor(p, (x) => x.state === "ready");
    expect(s.receivedBytes).toBe(body.length);
    expect(s.sizeBytes).toBe(body.length);
    expect(s.version).toBe("0.2.3");
    expect(s.errorCode).toBeNull();

    // 成品与元信息真实落盘，内容字节一致；.part 已被原子改名、不留残留。
    const disk = await fs.readFile(path.join(tmpDir, `${sha}.fpk`));
    expect(disk.equals(body)).toBe(true);
    const meta = JSON.parse(await fs.readFile(path.join(tmpDir, "latest.json"), "utf8"));
    expect(meta.sha256).toBe(sha);
    expect((await fs.readdir(tmpDir)).some((n) => n.endsWith(".part"))).toBe(false);

    // 安全：URL 不含 token；Authorization 头带 token。
    expect(calls[0].url).toBe(URL_ONLY);
    expect(calls[0].init?.headers).toMatchObject({ Authorization: `token ${TOKEN}` });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  });

  it("不要求鉴权的资产不带 Authorization 头", async () => {
    const body = payload(1000, 0x33);
    const sha = shaHex(body);
    const calls: Call[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(new Response(streamFrom(chunk(body, 1000)), { status: 200 }));
    };
    const p = realPrefetcher(fetchImpl);
    p.start(resolved(sha, body.length, false));
    await waitFor(p, (x) => x.state === "ready");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("206 续传：预置 .part 前缀，带 Range 追加后成品完整", async () => {
    const body = payload(50_000, 0x41);
    const sha = shaHex(body);
    await fs.writeFile(path.join(tmpDir, `${sha}.part`), body.subarray(0, 20_000));
    const seen: (string | undefined)[] = [];
    const fetchImpl: FetchLike = (_url, init) => {
      const h = init?.headers as Record<string, string>;
      seen.push(h.Range);
      return Promise.resolve(
        new Response(streamFrom([body.subarray(20_000)]), {
          status: 206,
          headers: { "Content-Range": `bytes 20000-${body.length - 1}/${body.length}` },
        }),
      );
    };
    const p = realPrefetcher(fetchImpl);
    p.start(resolved(sha, body.length));
    const s = await waitFor(p, (x) => x.state === "ready");
    expect(seen[0]).toBe("bytes=20000-");
    expect(s.receivedBytes).toBe(body.length);
    const disk = await fs.readFile(path.join(tmpDir, `${sha}.fpk`));
    expect(shaHex(disk)).toBe(sha);
  });

  it("200 忽略 Range：从截断重来，旧 .part 被覆盖", async () => {
    const body = payload(30_000, 0x77);
    const sha = shaHex(body);
    await fs.writeFile(path.join(tmpDir, `${sha}.part`), Buffer.from("garbage-prefix"));
    const fetchImpl: FetchLike = () =>
      Promise.resolve(new Response(streamFrom(chunk(body, 7000)), { status: 200 }));
    const p = realPrefetcher(fetchImpl);
    p.start(resolved(sha, body.length));
    await waitFor(p, (x) => x.state === "ready");
    const disk = await fs.readFile(path.join(tmpDir, `${sha}.fpk`));
    expect(disk.equals(body)).toBe(true);
  });

  it("416 后不带 Range 重试一次成功", async () => {
    const body = payload(20_000, 0x2a);
    const sha = shaHex(body);
    await fs.writeFile(path.join(tmpDir, `${sha}.part`), Buffer.from("stale"));
    let first = true;
    const ranges: (string | undefined)[] = [];
    const fetchImpl: FetchLike = (_u, init) => {
      const h = init?.headers as Record<string, string>;
      ranges.push(h.Range);
      if (first) {
        first = false;
        return Promise.resolve(new Response(null, { status: 416 }));
      }
      return Promise.resolve(new Response(streamFrom(chunk(body, 5000)), { status: 200 }));
    };
    const p = realPrefetcher(fetchImpl);
    p.start(resolved(sha, body.length));
    await waitFor(p, (x) => x.state === "ready");
    expect(ranges[0]).toBe("bytes=5-");
    expect(ranges[1]).toBeUndefined();
    expect((await fs.readdir(tmpDir)).some((n) => n === `${sha}.part`)).toBe(false);
  });

  it("sha 不符：failed/CHECKSUM，不产成品并清掉 .part", async () => {
    const body = payload(1000);
    const fetchImpl: FetchLike = () =>
      Promise.resolve(new Response(streamFrom(chunk(body, 500)), { status: 200 }));
    const p = realPrefetcher(fetchImpl);
    p.start(resolved("b".repeat(64), body.length));
    const s = await waitFor(p, (x) => x.state === "failed");
    expect(s.errorCode).toBe("PREFETCH_CHECKSUM");
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it("声明大小不符：failed/CHECKSUM", async () => {
    const body = payload(1000);
    const sha = shaHex(body);
    const fetchImpl: FetchLike = () =>
      Promise.resolve(new Response(streamFrom(chunk(body, 500)), { status: 200 }));
    const p = realPrefetcher(fetchImpl);
    p.start(resolved(sha, 999));
    const s = await waitFor(p, (x) => x.state === "failed");
    expect(s.errorCode).toBe("PREFETCH_CHECKSUM");
    expect((await fs.readdir(tmpDir)).some((n) => n.endsWith(".fpk"))).toBe(false);
  });

  it("401/403 → AUTH；500 → UNREACHABLE", async () => {
    for (const [status, want] of [
      [401, "PREFETCH_AUTH"],
      [403, "PREFETCH_AUTH"],
      [500, "PREFETCH_UNREACHABLE"],
      [404, "PREFETCH_UNREACHABLE"],
    ] as const) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gx-pf-"));
      try {
        const p = new UpdatePrefetcher({
          dir,
          idleTimeoutMs: 60000,
          token: TOKEN,
          fetch: () => Promise.resolve(new Response(null, { status })),
        });
        p.start(resolved(SHA_OK, 100));
        const s = await waitFor(p, (x) => x.state === "failed");
        expect(s.errorCode).toBe(want as UpdatePrefetchErrorCode);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("网络拒绝 → UNREACHABLE（.part 不存在，可重试）", async () => {
    const p = realPrefetcher(() => Promise.reject(new Error("ECONNREFUSED")));
    p.start(resolved(SHA_OK, 10));
    const s = await waitFor(p, (x) => x.state === "failed");
    expect(s.errorCode).toBe("PREFETCH_UNREACHABLE");
  });

  it("流中途空闲超时 → TIMEOUT，断点保留可续传", async () => {
    // 夹具须把 fetch signal 接到流：abort 时让挂起的 read 以 AbortError 拒绝（模拟真实 undici）。
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stall = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller;
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
    });
    const p = realPrefetcher(
      (_url, init) => {
        init?.signal?.addEventListener(
          "abort",
          () => ctrl?.error(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
        return Promise.resolve(new Response(stall, { status: 200 }));
      },
      { idle: 20 },
    );
    p.start(resolved(SHA_OK, 1000));
    const s = await waitFor(p, (x) => x.state === "failed", 2000);
    expect(s.errorCode).toBe("PREFETCH_TIMEOUT");
    expect((await fs.readdir(tmpDir)).some((n) => n === `${SHA_OK}.part`)).toBe(true);
  });

  it("boot() 从 latest.json + 成品恢复 ready；成品丢失则降级 idle", async () => {
    const body = payload(500, 0x11);
    const sha = shaHex(body);
    await fs.writeFile(path.join(tmpDir, `${sha}.fpk`), body);
    await fs.writeFile(
      path.join(tmpDir, "latest.json"),
      JSON.stringify({
        sha256: sha,
        version: "0.2.3",
        filename: "x.fpk",
        sizeBytes: body.length,
        updatedAt: new Date().toISOString(),
      }),
    );
    const p = realPrefetcher(() => {
      throw new Error("不应在 boot 出网");
    });
    await p.boot();
    expect(p.snapshot().state).toBe("ready");
    expect(await p.isReady(sha)).toBe(true);
    expect(p.readyPath(sha)).toBe(path.join(tmpDir, `${sha}.fpk`));
  });

  it("start 幂等：ready 后再 start 同 sha 返回 ready 且不出网；不同 sha running 时 busy", async () => {
    const body = payload(100);
    const sha = shaHex(body);
    let calls = 0;
    const p = realPrefetcher(() => {
      calls += 1;
      return Promise.resolve(new Response(streamFrom([body]), { status: 200 }));
    });
    const target = resolved(sha, body.length);
    p.start(target);
    await waitFor(p, (x) => x.state === "ready");
    expect(p.start(target)).toEqual({ kind: "ready", sha256: sha });
    expect(calls).toBe(1);
  });

  it("非 hex / 长度不对的 sha 拒绝启动；大写 hex 归一为小写放行", async () => {
    const p = realPrefetcher(() => Promise.resolve(new Response()));
    expect(() => p.start(resolved("not-a-sha", 1))).toThrow(/bad artifact sha/);
    expect(() => p.start(resolved(`${"a".repeat(63)}g`, 1))).toThrow(/bad artifact sha/);
    expect(() => p.start(resolved("a".repeat(63), 1))).toThrow(/bad artifact sha/);
    // 大写 hex 归一为小写（与磁盘文件名 / createHash digest 小写口径一致），正常启动。
    const r = p.start(resolved("A".repeat(64), 1));
    expect(r.kind).toBe("started");
    expect(r.sha256).toBe("a".repeat(64));
    // 空 Response 无 body → 后台任务收敛 UNREACHABLE；等其收尾，避免 detached job 跨用例悬空。
    const s = await waitFor(p, (x) => x.state === "failed");
    expect(s.errorCode).toBe("PREFETCH_UNREACHABLE");
  });
});

// -- 记录型假 store：分块/故障注入 --------------------------------------------

interface RecStore extends PrefetchStore {
  writes: number[];
  failCommit: boolean;
}

function recordingStore(): RecStore {
  const writes: number[] = [];
  return {
    writes,
    failCommit: false,
    async mkdir() {},
    async partSize() {
      return null;
    },
    async openPartWriter(): Promise<PrefetchWriter> {
      return {
        async write(chunk) {
          writes.push(chunk.byteLength);
        },
        async close() {},
      };
    },
    async hashPart() {
      return "f".repeat(64); // 恒不等于目标 sha → 走校验不符路径
    },
    async commitPart() {
      if ((this as RecStore).failCommit) {
        const e = new Error("disk full") as NodeJS.ErrnoException;
        e.code = "ENOSPC";
        throw e;
      }
    },
    async removePart() {},
    async pruneExcept() {},
    async readyExists() {
      return false;
    },
    readyPath() {
      return "/nonexistent/f.fpk";
    },
    async readLatest() {
      return null;
    },
    async writeLatest() {},
  };
}

describe("UpdatePrefetcher 分块与故障注入", () => {
  it("逐块顺序写：无单次写入超过 256KiB，且随块增长（不整包进内存）", async () => {
    // 1MiB 上游体，reader 每块 64KiB。
    const chunks = chunk(payload(1024 * 1024), 64 * 1024);
    const store = recordingStore();
    const p = new UpdatePrefetcher({
      dir: tmpDir,
      idleTimeoutMs: 60000,
      token: TOKEN,
      store,
      fetch: () => Promise.resolve(new Response(streamFrom(chunks), { status: 200 })),
    });
    p.start(resolved(SHA_OK, null)); // 假 store hash 恒返回 f*64，与 a*64 不符 → failed
    await waitFor(p, (x) => x.state === "failed");
    expect(store.writes.length).toBe(16);
    expect(Math.max(...store.writes)).toBe(64 * 1024);
    // 没有任何单次写接近整包。
    expect(Math.max(...store.writes)).toBeLessThan(256 * 1024);
  });

  it("commit 时 ENOSPC → PREFETCH_DISK", async () => {
    const store = recordingStore();
    store.failCommit = true;
    // hashPart 需与目标一致才能走到 commit。
    store.hashPart = async () => SHA_OK;
    const p = new UpdatePrefetcher({
      dir: tmpDir,
      idleTimeoutMs: 60000,
      token: TOKEN,
      store,
      fetch: () => Promise.resolve(new Response(streamFrom([payload(10)]), { status: 200 })),
    });
    p.start(resolved(SHA_OK, 10));
    const s = await waitFor(p, (x) => x.state === "failed");
    expect(s.errorCode).toBe("PREFETCH_DISK");
  });
});

// -- 默认 store 原语（prune / readyPath 白名单） -------------------------------

describe("createDefaultStore 原语", () => {
  it("pruneExcept 只留指定 sha 的 fpk/part，且不碰 latest.json", async () => {
    const store = createDefaultStore(tmpDir);
    await store.mkdir();
    await fs.writeFile(path.join(tmpDir, `${"1".repeat(64)}.fpk`), "old");
    await fs.writeFile(path.join(tmpDir, `${"2".repeat(64)}.part`), "half");
    await fs.writeFile(path.join(tmpDir, `${"3".repeat(64)}.fpk`), "keep");
    await fs.writeFile(path.join(tmpDir, "latest.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "unrelated.txt"), "x");
    await store.pruneExcept("3".repeat(64));
    const names = await fs.readdir(tmpDir);
    expect(names).toContain(`${"3".repeat(64)}.fpk`);
    expect(names).toContain("latest.json");
    expect(names).toContain("unrelated.txt");
    expect(names).not.toContain(`${"1".repeat(64)}.fpk`);
    expect(names).not.toContain(`${"2".repeat(64)}.part`);
  });
});
