// apps/api/scripts/bench/m5-spec.ts
// M5/S13 机器画像采集（真机压测前置）：CPU/内存/磁盘类型(Node/OS/vec0)。输出 JSON + 人读摘要。
//
// 便携性铁律：每步都 try/catch —— 采集失败（macOS 无 lsblk/sys-block、容器无 /sys）只让该字段为空，
// 绝不因画像采集失败而中断压测。磁盘类型尽力而为：先 /sys/block/*/queue/rotational（Linux 权威），
// 再 df -T 的 fstype（nfs/cifs 直接判网络盘），最后输出设备名供人判读。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { describeVecPlatform } from "../../src/domain/search/vecLoader.js";
import { openSearchStore } from "../../src/domain/search/searchStore.js";

export interface FsEntry {
  target: string; source: string; fstype: string | null; sizeBytes: number | null; availBytes: number | null;
}
export interface BlockEntry { name: string; sizeBytes: number | null; rotational: boolean | null; type: string | null }
export interface MachineSpec {
  host: string;
  platform: string;
  arch: string;
  kernelRelease: string;
  cpuModel: string;
  cpuCount: number;
  memTotalBytes: number;
  memFreeBytes: number;
  nodeVersion: string;
  pnpmVersion: string | null;
  gitVersion: string | null;
  libc: { glibc: string | null; hint: "glibc" | "musl" | "unknown" };
  filesystems: FsEntry[];
  blockDevices: BlockEntry[];
  diskHint: "ssd" | "hdd" | "mixed" | "network" | "unknown";
  vec: { triplet: string; supported: boolean; available: boolean; version: string | null; path: string | null; error: string | null };
}

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** 解析 `df -T`（Linux，含 fstype）。行：Filesystem Type 1K-blocks Used Available Use% Mounted on */
export function parseDfT(stdout: string): FsEntry[] {
  const out: FsEntry[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 7) continue;
    const [source, fstype, blocks, , avail, , ...mountParts] = cols;
    const kb = (s?: string): number | null => (s && /^\d+$/.test(s) ? Number(s) * 1024 : null);
    out.push({ source: source!, fstype: fstype!, sizeBytes: kb(blocks), availBytes: kb(avail), target: mountParts.join(" ") });
  }
  return out;
}

/** 解析 `df -kP`（POSIX，无 fstype；macOS 回退）。 */
export function parseDfP(stdout: string): FsEntry[] {
  const out: FsEntry[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const [source, blocks, , avail, , ...mountParts] = cols;
    const kb = (s?: string): number | null => (s && /^\d+$/.test(s) ? Number(s) * 1024 : null);
    out.push({ source: source!, fstype: null, sizeBytes: kb(blocks), availBytes: kb(avail), target: mountParts.join(" ") });
  }
  return out;
}

/** 解析 lsblk -b -d -o NAME,SIZE,ROTA,TYPE（Linux）。 */
export function parseLsblk(stdout: string): BlockEntry[] {
  const out: BlockEntry[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const [name, size, rota, type] = cols;
    out.push({
      name: name!, type: type ?? null,
      sizeBytes: size && /^\d+$/.test(size) ? Number(size) : null,
      rotational: rota === "0" ? false : rota === "1" ? true : null,
    });
  }
  return out;
}

/** 由 df 源设备名（/dev/sda1、/dev/nvme0n1p2）推 /sys/block 基名。 */
export function baseDeviceName(source: string): string | null {
  const m = /^\/dev\/(.+)$/.exec(source);
  if (!m) return null;
  const dev = m[1]!;
  if (dev.startsWith("nvme")) return dev.split("p")[0] ?? dev;
  if (dev.startsWith("mmcblk")) return dev.split("p")[0] ?? dev;
  return dev.replace(/\d+$/, "");
}

function readRotational(source: string): boolean | null {
  const base = baseDeviceName(source);
  if (!base) return null;
  const p = `/sys/block/${base}/queue/rotational`;
  try {
    if (!fs.existsSync(p)) return null;
    const v = fs.readFileSync(p, "utf8").trim();
    return v === "0" ? false : v === "1" ? true : null;
  } catch {
    return null;
  }
}

/** 磁盘类型判定：网络盘优先（fstype nfs/cifs/...）；否则由 rotational 推断。 */
export function inferDiskHint(fsEntries: FsEntry[], blocks: BlockEntry[]): MachineSpec["diskHint"] {
  const networkFs = new Set(["nfs", "nfs4", "cifs", "smbfs", "smb3", "fuse.sshfs", "9p", "ceph", "glusterfs"]);
  if (fsEntries.some((f) => f.fstype && networkFs.has(f.fstype))) return "network";
  const rota = blocks.map((b) => b.rotational).filter((r): r is boolean => r !== null);
  if (rota.length > 0) {
    const anyHdd = rota.some((r) => r === true);
    const anySsd = rota.some((r) => r === false);
    if (anyHdd && anySsd) return "mixed";
    return anyHdd ? "hdd" : "ssd";
  }
  // 无 lsblk/rotational：用 df 源设备名的 nvme 记号兜底。
  if (fsEntries.some((f) => /nvme|mmcblk/.test(f.source))) return "ssd";
  return "unknown";
}

function detectLibc(): MachineSpec["libc"] {
  let glibc: string | null = null;
  try {
    const rep = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
    glibc = rep?.header?.glibcVersionRuntime ?? null;
  } catch { /* ignore */ }
  if (glibc) return { glibc, hint: "glibc" };
  const musl = fs.existsSync("/etc/alpine-release") || (() => {
    const ldd = tryExec("ldd --version 2>&1");
    return ldd !== null && /musl/i.test(ldd);
  })();
  return { glibc: null, hint: musl ? "musl" : "unknown" };
}

function collectFilesystems(): FsEntry[] {
  const dfT = tryExec("df -T");
  if (dfT) {
    const parsed = parseDfT(dfT);
    if (parsed.length > 0) return parsed;
  }
  const dfP = tryExec("df -kP");
  return dfP ? parseDfP(dfP) : [];
}

function probeVec(): MachineSpec["vec"] {
  const platformInfo = describeVecPlatform();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m5-spec-"));
  const dbPath = path.join(dir, "probe/search.db");
  const base: MachineSpec["vec"] = {
    triplet: platformInfo.triplet, supported: platformInfo.supported,
    available: false, version: null, path: null, error: null,
  };
  let store: ReturnType<typeof openSearchStore> | null = null;
  try {
    store = openSearchStore({ filePath: dbPath, appDir: process.cwd(), tryLoadVec: true });
    base.available = store.vecAvailable;
    base.version = store.vecVersion;
    base.path = store.vecPath;
    base.error = store.vecError;
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err);
  } finally {
    try { store?.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return base;
}

/** 采集完整机器画像（失败字段留空，绝不抛）。 */
export function collectMachineSpec(): MachineSpec {
  const cpus = os.cpus();
  const filesystems = collectFilesystems();
  const lsblk = tryExec("lsblk -b -d -o NAME,SIZE,ROTA,TYPE");
  const blockDevices = lsblk ? parseLsblk(lsblk) : [];
  return {
    host: (() => { try { return os.hostname(); } catch { return "unknown"; } })(),
    platform: process.platform,
    arch: process.arch,
    kernelRelease: os.release(),
    cpuModel: cpus[0]?.model?.trim() ?? "unknown",
    cpuCount: cpus.length,
    memTotalBytes: os.totalmem(),
    memFreeBytes: os.freemem(),
    nodeVersion: process.version,
    pnpmVersion: tryExec("pnpm --version"),
    gitVersion: tryExec("git --version"),
    libc: detectLibc(),
    filesystems,
    blockDevices,
    diskHint: inferDiskHint(filesystems, blockDevices),
    vec: probeVec(),
  };
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** 人读摘要（Markdown 片段）。 */
export function formatSpecSummary(s: MachineSpec): string {
  const fsLines = s.filesystems
    .filter((f) => ["/", "/var", "/tmp", "/home", "/data"].some((t) => f.target.startsWith(t)) || f.target === "/")
    .slice(0, 6)
    .map((f) => `  - ${f.target}: ${f.fstype ?? "?"} ${f.source} (avail ${f.availBytes !== null ? mib(f.availBytes) : "?"})`)
    .join("\n");
  return [
    `- host: ${s.host} (${s.platform}/${s.arch}, kernel ${s.kernelRelease}, libc ${s.libc.hint}${s.libc.glibc ? " " + s.libc.glibc : ""})`,
    `- cpu: ${s.cpuModel} ×${s.cpuCount}`,
    `- mem: total ${mib(s.memTotalBytes)}, free ${mib(s.memFreeBytes)}`,
    `- disk: ${s.diskHint}`,
    fsLines,
    `- node ${s.nodeVersion}, pnpm ${s.pnpmVersion ?? "?"}, git ${s.gitVersion ?? "?"}`,
    `- sqlite-vec: ${s.vec.available ? `OK v${s.vec.version ?? "?"}` : "UNAVAILABLE"} (${s.vec.triplet}, supported=${s.vec.supported}${s.vec.error ? `, err=${s.vec.error}` : ""})`,
  ].filter(Boolean).join("\n");
}
