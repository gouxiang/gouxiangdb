// apps/api/src/domain/update/prefetch.ts
// UpdatePrefetcher：更新包【后台预缓存】下载器（方案 A，真机 P0-2 的代码解）。
//
// 背景：飞牛 CGI 反代对单次请求硬限 ~30s 且整包缓冲，公网慢时浏览器在面板内直连下载
// 63MB 必 502。改为 owner 触发后端在【后台】分块把包预拉到 NAS 本地磁盘，拉完校验后
// 原子落地；浏览器随后凭原下载票命中本地成品秒取（download 路由本地优先，见 #724）。
//
// 铁律（与全机制一致，逐条落地）：
//   - 零第三方依赖：仅 node:crypto / node:fs / node:path；
//   - 分块落盘（256KiB），严禁 arrayBuffer()/整包进内存（小内存 NAS 防拖垮）；
//   - token 只走 Authorization 头（authed 时），绝不入 URL / 日志 / 状态快照 / 抛出信息；
//   - 上游错误体绝不透传：只收敛为稳定 PREFETCH_* 错误码；
//   - 内容寻址：成品 <sha>.fpk、断点 <sha>.part；sha 先过 64 位小写 hex 白名单再拼路径
//     （杜绝路径穿越）；target filename 只存元信息，绝不参与落盘路径；
//   - 断点续传：带 Range 复用 .part（206 追加 / 200 重来 / 416 重来一次）；
//   - 完成后流式 sha256 校验（不整包入内存），不符则删 .part 不产成品；
//   - 单飞：同一时刻只跑一个后台任务；成品只保留最新一个；
//   - 空闲超时（非总时长）：watchdog 在每个数据块后重置；超时保留 .part 可续传。
//
// 依赖方向：只依赖 @gx/shared-types 与 node 内置；config/fetch/clock/store 全部注入，
// 不 import ../../config.js / Hono / db。

import { createHash, type Hash } from "node:crypto";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import type { UpdatePrefetchDTO, UpdatePrefetchErrorCode } from "@gx/shared-types";
import type { ResolvedDownload } from "./service.js";
import type { FetchLike } from "./source.js";

/** 分块落盘块大小：256 KiB（与下载代理 pump 同量级，控内存上限）。 */
const CHUNK_BYTES = 256 * 1024;
/** sha 内容寻址键：严格 64 位小写十六进制（sha256 hex）。 */
const SHA_RE = /^[0-9a-f]{64}$/;
/** 成品/元信息文件名。 */
const partName = (sha: string): string => `${sha}.part`;
const readyName = (sha: string): string => `${sha}.fpk`;
const LATEST_FILE = "latest.json";

/** 就绪成品的最小元信息（单文件 latest.json，重启后恢复 ready 快照用）。 */
export interface PrefetchLatestMeta {
  sha256: string;
  version: string;
  filename: string;
  sizeBytes: number | null;
  updatedAt: string;
}

/** 顺序写句柄门面（append=true 续传追加，否则截断重写）。 */
export interface PrefetchWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/**
 * 存储窄门面：把所有真实文件系统操作隔在一处，核心下载编排不直接碰 fs，
 * 便于在单测里注入 ENOSPC / rename 失败 / 校验不符等故障。生产用 createDefaultStore。
 */
export interface PrefetchStore {
  /** 幂等建缓存目录。 */
  mkdir(): Promise<void>;
  /** .part 已存在时返回其字节数（续传起点）；不存在返回 null。 */
  partSize(sha: string): Promise<number | null>;
  /** 打开 .part 顺序写句柄。 */
  openPartWriter(sha: string, append: boolean): Promise<PrefetchWriter>;
  /** 流式计算 .part 的 sha256（分块，不整包入内存），返回 hex。 */
  hashPart(sha: string): Promise<string>;
  /** .part 原子改名为 <sha>.fpk（同文件系统 rename 原子）。 */
  commitPart(sha: string): Promise<void>;
  /** 删除 .part（校验不符 / 重来前清理）。不存在视为成功。 */
  removePart(sha: string): Promise<void>;
  /** 删除除 keepSha 成品/断点及其它残留外的所有 *.fpk / *.part（成品只留最新一个）。 */
  pruneExcept(keepSha: string): Promise<void>;
  readyExists(sha: string): Promise<boolean>;
  /** 成品绝对路径（供 download 路由流式秒取）；不承诺存在，调用方先 readyExists。 */
  readyPath(sha: string): string;
  readLatest(): Promise<PrefetchLatestMeta | null>;
  /** 原子写 latest.json（临时文件 + rename）。 */
  writeLatest(meta: PrefetchLatestMeta): Promise<void>;
}

export interface PrefetcherDeps {
  /** 预缓存目录（config.update.prefetchDir，已由 config.ts 兜底）。 */
  dir: string;
  /** 拉取空闲超时 ms（config.update.prefetchIdleTimeoutMs）。 */
  idleTimeoutMs: number;
  /** 更新源只读凭证；仅在 ArtifactRequest.authed 时注入 Authorization 头。 */
  token: string;
  /** 注入桩 fetch（测试用）；默认全局 fetch。 */
  fetch?: FetchLike;
  now?: () => Date;
  /** 注入存储门面（测试注入故障用）；默认真 fs。 */
  store?: PrefetchStore;
}

/** start() 的同步裁决结果（后台任务异步跑，状态走 snapshot）。 */
export type PrefetchStartResult =
  | { kind: "started"; sha256: string }
  | { kind: "running"; sha256: string }
  | { kind: "ready"; sha256: string }
  | { kind: "busy"; sha256: string };

interface Job {
  sha: string;
  version: string;
  filename: string;
  sizeBytes: number | null;
  received: number;
}

/** 把上游 HTTP 状态收敛为预缓存错误码（401/403→AUTH，其余非 2xx/206→UNREACHABLE）。 */
function mapHttpStatus(status: number): UpdatePrefetchErrorCode {
  return status === 401 || status === 403 ? "PREFETCH_AUTH" : "PREFETCH_UNREACHABLE";
}

function isIoDiskError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOSPC" || code === "EACCES" || code === "EROFS" || code === "EDQUOT";
}

export class UpdatePrefetcher {
  private readonly dir: string;
  private readonly idleTimeoutMs: number;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly store: PrefetchStore;

  private state: UpdatePrefetchDTO["state"] = "idle";
  private sha: string | null = null;
  private version: string | null = null;
  private filename: string | null = null;
  private sizeBytes: number | null = null;
  private receivedBytes = 0;
  private errorCode: UpdatePrefetchErrorCode | null = null;
  private updatedAt: string | null = null;
  private job: Job | null = null;
  private booted = false;

  constructor(deps: PrefetcherDeps) {
    this.dir = deps.dir;
    this.idleTimeoutMs = deps.idleTimeoutMs;
    this.token = deps.token;
    this.fetchImpl = deps.fetch ?? (globalThis.fetch as FetchLike);
    this.now = deps.now ?? (() => new Date());
    this.store = deps.store ?? createDefaultStore(deps.dir);
  }

  /**
   * 触发一次后台预取（同步返回裁决，真正下载在后台异步跑）。
   * 同一 sha 正在跑→running；已就绪→ready；另有任务在跑→busy。
   */
  start(resolved: ResolvedDownload): PrefetchStartResult {
    const sha = resolved.artifact.sha256?.trim().toLowerCase();
    if (!sha || !SHA_RE.test(sha)) {
      // 清单 sha 非法属发布事故：不作为可下载目标（download 票同口径也拦）。
      throw Object.assign(new Error("bad artifact sha"), { code: "PREFETCH_BAD_STATE" });
    }
    if (this.job) {
      return this.job.sha === sha
        ? { kind: "running", sha256: sha }
        : { kind: "busy", sha256: this.job.sha };
    }
    if (this.state === "ready" && this.sha === sha) {
      return { kind: "ready", sha256: sha };
    }

    const job: Job = {
      sha,
      version: resolved.version,
      filename: resolved.artifact.filename,
      sizeBytes: Number.isFinite(resolved.artifact.sizeBytes) ? resolved.artifact.sizeBytes : null,
      received: 0,
    };
    this.job = job;
    this.transition("running", {
      sha,
      version: job.version,
      filename: job.filename,
      sizeBytes: job.sizeBytes,
      received: 0,
      error: null,
    });
    // 后台 detached：错误收敛进状态快照，绝不冒出未处理 rejection。
    void this.run(resolved, job).catch((err) => {
      this.failWith(err, job);
    });
    return { kind: "started", sha256: sha };
  }

  /** 当前预缓存快照（不含 url/token/上游体）。 */
  snapshot(): UpdatePrefetchDTO {
    return {
      state: this.state,
      sha256: this.sha,
      version: this.version,
      filename: this.filename,
      sizeBytes: this.sizeBytes,
      receivedBytes: this.receivedBytes,
      errorCode: this.errorCode,
      updatedAt: this.updatedAt,
    };
  }

  /** 成品是否已就绪（download 路由本地命中判定）。 */
  async isReady(sha: string): Promise<boolean> {
    const norm = sha?.trim().toLowerCase();
    if (!norm || !SHA_RE.test(norm)) return false;
    if (this.state === "ready" && this.sha === norm) return true;
    return this.store.readyExists(norm);
  }

  /** 成品绝对路径（仅在 isReady 为真后调用）。 */
  readyPath(sha: string): string {
    return this.store.readyPath(sha.trim().toLowerCase());
  }

  /**
   * 构造后一次性地从磁盘恢复 ready 快照（latest.json 指向的成品仍在）。
   * 路由装配期 await 一次；失败一律降级 idle，绝不让缓存状态影响启动。
   */
  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    try {
      const meta = await this.store.readLatest();
      if (meta && SHA_RE.test(meta.sha256) && await this.store.readyExists(meta.sha256)) {
        this.transition("ready", {
          sha: meta.sha256,
          version: meta.version,
          filename: meta.filename,
          sizeBytes: meta.sizeBytes,
          received: meta.sizeBytes ?? 0,
          error: null,
        });
      }
    } catch {
      // 缓存目录不可读等：静默降级 idle（首次 start 会再 mkdir 自愈）。
    }
  }

  // -- 核心下载编排 ----------------------------------------------------------

  private async run(resolved: ResolvedDownload, job: Job): Promise<void> {
    // 若 start 返回后 job 已被切换（理论上单飞不会），不做事。
    if (this.job !== job) return;
    await this.store.mkdir();

    const existing = await this.store.partSize(job.sha);
    const resumeFrom = existing ?? 0;
    job.received = resumeFrom;
    this.patchProgress(job, resumeFrom);

    const headers: Record<string, string> = {};
    if (resolved.request.authed) headers.Authorization = `token ${this.token}`;
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

    // 空闲 watchdog：每收到一块重置；仅在“久无数据”时 abort（非总时长上限）。
    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), this.idleTimeoutMs);
    };
    let res: Response;
    try {
      arm();
      res = await this.fetchImpl(resolved.request.url, {
        headers,
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      // 连接/等首字节阶段：abort→超时；其余网络错→不可达（细节不透传）。
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw this.prefetchError("PREFETCH_TIMEOUT", "idle timeout while connecting");
      }
      throw this.prefetchError("PREFETCH_UNREACHABLE", "network error before response");
    }

    const status = res.status;
    // 200：服务器忽略 Range → 从头重来；206：续传追加；其余收敛。416 一次重来。
    let append = resumeFrom > 0;
    if (status === 200) {
      append = false;
      job.received = 0;
      this.patchProgress(job, 0);
    } else if (status === 206) {
      append = true;
    } else if (status === 416 && resumeFrom > 0) {
      if (timer) clearTimeout(timer);
      // 区间无效：删断点、不带 Range 重试一次。
      await this.safeRemovePart(job.sha);
      const retry = await this.fetchWithRetry(resolved, job);
      res = retry.res;
      append = false;
    } else {
      if (timer) clearTimeout(timer);
      throw this.prefetchError(mapHttpStatus(status), `upstream status ${status}`);
    }

    if (!res.body) {
      if (timer) clearTimeout(timer);
      // 2xx/206 却无 body：源异常，按不可达收敛，保留 .part 可续传。
      throw this.prefetchError("PREFETCH_UNREACHABLE", "empty upstream body");
    }

    let writer: PrefetchWriter;
    try {
      writer = await this.store.openPartWriter(job.sha, append);
    } catch (err) {
      if (timer) clearTimeout(timer);
      throw this.prefetchError(isIoDiskError(err) ? "PREFETCH_DISK" : "PREFETCH_BAD_STATE", "open writer");
    }

    let streamError: Error | null = null;
    try {
      const reader = res.body.getReader();
      arm();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          await writer.write(value);
          job.received += value.byteLength;
          this.patchProgress(job, job.received);
        }
        arm();
      }
    } catch (err) {
      if (timer) clearTimeout(timer);
      // 读流途中 abort（watchdog）→空闲超时保留 .part；其它网络中断→不可达，同样保留断点。
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        streamError = this.prefetchError("PREFETCH_TIMEOUT", "idle timeout mid-stream");
      } else {
        streamError = this.prefetchError("PREFETCH_UNREACHABLE", "stream interrupted");
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    // 先关句柄：读流已失败则关闭尽力而为后抛原网络错误；读流成功但关闭失败→磁盘错中断。
    try {
      await writer.close();
    } catch (err) {
      if (streamError) throw streamError;
      throw this.prefetchError(isIoDiskError(err) ? "PREFETCH_DISK" : "PREFETCH_BAD_STATE", "close writer");
    }
    if (streamError) throw streamError;

    // 声明大小核对（若清单提供 sizeBytes）。
    if (job.sizeBytes !== null && job.received !== job.sizeBytes) {
      await this.safeRemovePart(job.sha);
      throw this.prefetchError("PREFETCH_CHECKSUM", "size mismatch");
    }

    // 流式校验 sha256（不整包入内存）。
    let digest: string;
    try {
      digest = await this.store.hashPart(job.sha);
    } catch (err) {
      throw this.prefetchError(isIoDiskError(err) ? "PREFETCH_DISK" : "PREFETCH_BAD_STATE", "hash read");
    }
    if (digest !== job.sha) {
      await this.safeRemovePart(job.sha);
      throw this.prefetchError("PREFETCH_CHECKSUM", "sha256 mismatch");
    }

    // 原子落地 + 只留最新成品 + 记 latest.json。
    try {
      await this.store.commitPart(job.sha);
      await this.store.pruneExcept(job.sha);
      await this.store.writeLatest({
        sha256: job.sha,
        version: job.version,
        filename: job.filename,
        sizeBytes: job.sizeBytes,
        updatedAt: this.now().toISOString(),
      });
    } catch (err) {
      throw this.prefetchError(isIoDiskError(err) ? "PREFETCH_DISK" : "PREFETCH_BAD_STATE", "commit");
    }

    this.job = null;
    this.transition("ready", {
      sha: job.sha,
      version: job.version,
      filename: job.filename,
      sizeBytes: job.sizeBytes,
      received: job.sizeBytes ?? job.received,
      error: null,
    });
  }

  /** 416 后不带 Range 重取一次（仍带 watchdog）。 */
  private async fetchWithRetry(
    resolved: ResolvedDownload,
    job: Job,
  ): Promise<{ res: Response }> {
    const headers: Record<string, string> = {};
    if (resolved.request.authed) headers.Authorization = `token ${this.token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.idleTimeoutMs);
    job.received = 0;
    this.patchProgress(job, 0);
    let res: Response;
    try {
      res = await this.fetchImpl(resolved.request.url, { headers, signal: controller.signal, redirect: "follow" });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw this.prefetchError("PREFETCH_TIMEOUT", "idle timeout on retry");
      }
      throw this.prefetchError("PREFETCH_UNREACHABLE", "network error on retry");
    }
    clearTimeout(timer);
    if (res.status !== 200) {
      throw this.prefetchError(mapHttpStatus(res.status), `retry status ${res.status}`);
    }
    return { res };
  }

  /** 收敛后台任务异常为稳定状态（detail 仅服务端 console，绝不进快照）。 */
  private failWith(err: unknown, job: Job): void {
    if (this.job === job) this.job = null;
    const code: UpdatePrefetchErrorCode =
      err && typeof err === "object" && "prefetchCode" in err
        ? (err as { prefetchCode: UpdatePrefetchErrorCode }).prefetchCode
        : "PREFETCH_UNREACHABLE";
    this.transition("failed", {
      sha: job.sha,
      version: job.version,
      filename: job.filename,
      sizeBytes: job.sizeBytes,
      received: job.received,
      error: code,
    });
    // 服务端排障细节（不含 token/url）：错误码 + 名称。
    console.warn(`[update-prefetch] ${code} (${(err as Error)?.name ?? "Error"})`);
  }

  private prefetchError(code: UpdatePrefetchErrorCode, detail: string): Error & { prefetchCode: string } {
    // detail 只用于服务端日志侧，不进 DTO；错误对象带稳定码供 failWith 收敛。
    const err = new Error(detail) as Error & { prefetchCode: UpdatePrefetchErrorCode };
    err.prefetchCode = code;
    return err;
  }

  private async safeRemovePart(sha: string): Promise<void> {
    try {
      await this.store.removePart(sha);
    } catch {
      // 清理失败不掩盖主错误；下轮续传会按实际大小再核。
    }
  }

  private patchProgress(job: Job, received: number): void {
    if (this.job !== job) return;
    this.receivedBytes = received;
    this.updatedAt = this.now().toISOString();
  }

  private transition(
    state: UpdatePrefetchDTO["state"],
    p: {
      sha: string;
      version: string;
      filename: string;
      sizeBytes: number | null;
      received: number;
      error: UpdatePrefetchErrorCode | null;
    },
  ): void {
    this.state = state;
    this.sha = p.sha;
    this.version = p.version;
    this.filename = p.filename;
    this.sizeBytes = p.sizeBytes;
    this.receivedBytes = p.received;
    this.errorCode = p.error;
    this.updatedAt = this.now().toISOString();
  }
}

// ---------------------------------------------------------------------------
// 默认真 fs 存储门面（node:fs/promises + 流式 hash；全部 path 用 path.join 且
// 文件名仅取已过白名单的 sha，杜绝穿越）。
// ---------------------------------------------------------------------------

export function createDefaultStore(dir: string): PrefetchStore {
  const partPath = (sha: string): string => path.join(dir, partName(sha));
  const readyPath = (sha: string): string => path.join(dir, readyName(sha));

  return {
    async mkdir() {
      await fs.mkdir(dir, { recursive: true });
    },

    async partSize(sha) {
      try {
        const st = await fs.stat(partPath(sha));
        return st.size;
      } catch {
        return null;
      }
    },

    async openPartWriter(sha, append) {
      const handle = await fs.open(partPath(sha), append ? "a" : "w");
      return {
        async write(chunk) {
          // writeFileHandle 写 Buffer；逐块 await 保证背压、不缓存整包。
          await handle.write(chunk);
        },
        async close() {
          await handle.close();
        },
      };
    },

    hashPart(sha) {
      return new Promise<string>((resolve, reject) => {
        const hash: Hash = createHash("sha256");
        const stream = createReadStream(partPath(sha), { highWaterMark: CHUNK_BYTES });
        stream.on("error", reject);
        stream.on("data", (c) => hash.update(c));
        stream.on("end", () => resolve(hash.digest("hex")));
      });
    },

    async commitPart(sha) {
      // 同目录 rename 原子；若旧成品存在先移除（内容寻址不同 sha）。
      await fs.rename(partPath(sha), readyPath(sha));
    },

    async removePart(sha) {
      await fs.rm(partPath(sha), { force: true });
    },

    async pruneExcept(keepSha) {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        return;
      }
      await Promise.all(
        names
          .filter((n) => /^[0-9a-f]{64}\.(fpk|part)$/.test(n) && !n.startsWith(keepSha))
          .map((n) => fs.rm(path.join(dir, n), { force: true })),
      );
    },

    async readyExists(sha) {
      try {
        await fs.access(readyPath(sha));
        return true;
      } catch {
        return false;
      }
    },

    readyPath(sha) {
      return readyPath(sha);
    },

    async readLatest() {
      try {
        const raw = await fs.readFile(path.join(dir, LATEST_FILE), "utf8");
        const meta = JSON.parse(raw) as PrefetchLatestMeta;
        if (!meta || typeof meta.sha256 !== "string" || typeof meta.version !== "string") return null;
        return {
          sha256: meta.sha256,
          version: meta.version,
          filename: typeof meta.filename === "string" ? meta.filename : "",
          sizeBytes: typeof meta.sizeBytes === "number" ? meta.sizeBytes : null,
          updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : "",
        };
      } catch {
        return null;
      }
    },

    async writeLatest(meta) {
      const tmp = path.join(dir, `${LATEST_FILE}.tmp`);
      await fs.writeFile(tmp, JSON.stringify(meta), "utf8");
      await fs.rename(tmp, path.join(dir, LATEST_FILE));
    },
  };
}
