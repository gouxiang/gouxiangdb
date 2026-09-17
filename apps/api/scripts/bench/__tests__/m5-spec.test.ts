// M5/S13 机器画像解析测试（纯函数：df/lsblk/rotational 判定，跨平台回退）。

import { describe, expect, it } from "vitest";
import { baseDeviceName, inferDiskHint, parseDfP, parseDfT, parseLsblk } from "../m5-spec.js";

const DF_T = [
  "Filesystem     Type  1K-blocks      Used Available Use% Mounted on",
  "/dev/sda1      ext4  104806400  20000000  79480640  21% /",
  "tmpfs          tmpfs   4062360         0   4062360   0% /run/user",
  "//nas/share    cifs 2000000000  5000000 1995000000   1% /mnt/nas",
].join("\n");

describe("parseDfT / parseDfP", () => {
  it("df -T：解析源、fstype、块数(×1024)、挂载点", () => {
    const rows = parseDfT(DF_T);
    expect(rows[0]).toMatchObject({ source: "/dev/sda1", fstype: "ext4", sizeBytes: 104806400 * 1024, target: "/" });
    expect(rows[2]!.fstype).toBe("cifs");
  });

  it("df -kP（macOS 回退）：无 fstype，解析块数与挂载点", () => {
    const out = [
      "Filesystem  1024-blocks      Used Available Capacity Mounted on",
      "/dev/disk3s1s1  971350180  30000000 600000000    11% /",
    ].join("\n");
    const rows = parseDfP(out);
    expect(rows[0]).toMatchObject({ source: "/dev/disk3s1s1", fstype: null, target: "/" });
    expect(rows[0]!.sizeBytes).toBe(971350180 * 1024);
  });
});

describe("parseLsblk / baseDeviceName", () => {
  it("解析 NAME/SIZE/ROTA/TYPE 且 rotational 映射 0/1", () => {
    const out = [
      "NAME  SIZE ROTA TYPE",
      "sda   107374182400 1 disk",
      "nvme0n1 512110190592 0 disk",
    ].join("\n");
    const rows = parseLsblk(out);
    expect(rows[0]).toMatchObject({ name: "sda", rotational: true, type: "disk" });
    expect(rows[1]).toMatchObject({ name: "nvme0n1", rotational: false });
  });

  it("baseDeviceName：分区 -> 基设备（sda1->sda、nvme0n1p2->nvme0n1）", () => {
    expect(baseDeviceName("/dev/sda1")).toBe("sda");
    expect(baseDeviceName("/dev/nvme0n1p2")).toBe("nvme0n1");
    expect(baseDeviceName("//nas/share")).toBeNull();
  });
});

describe("inferDiskHint", () => {
  it("fstype 为网络盘 -> network（优先于 rotational）", () => {
    expect(inferDiskHint(parseDfT(DF_T), parseLsblk("NAME SIZE ROTA TYPE\nsda 1 0 disk"))).toBe("network");
  });
  it("全 SSD -> ssd；全 HDD -> hdd；混合 -> mixed", () => {
    const fs = parseDfP("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1 1 1 1% /");
    expect(inferDiskHint(fs, parseLsblk("NAME SIZE ROTA TYPE\nsda 1 0 disk"))).toBe("ssd");
    expect(inferDiskHint(fs, parseLsblk("NAME SIZE ROTA TYPE\nsda 1 1 disk"))).toBe("hdd");
    expect(inferDiskHint(fs, parseLsblk("NAME SIZE ROTA TYPE\nsda 1 1 disk\nnvme0n1 1 0 disk"))).toBe("mixed");
  });
  it("无 lsblk 时用 nvme/mmcblk 记号兜底为 ssd", () => {
    const fs = parseDfP("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/nvme0n1p2 1 1 1 1% /");
    expect(inferDiskHint(fs, [])).toBe("ssd");
  });
  it("完全无线索 -> unknown", () => {
    expect(inferDiskHint([], [])).toBe("unknown");
  });
});
