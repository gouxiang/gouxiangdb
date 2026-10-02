// apps/web/src/features/attachments/attachment-policy.test.ts
// 附件策略纯函数 + 体积守卫（node 环境，无 jsdom / 无 testing-library，与项目范式一致）。
//
// 覆盖的是**决策**而不是渲染：白名单、体积、数量、预览分派、URL 形态、脏数据容错。
// 这些规则写死在组件里就只能靠手点验证（一次要准备 20MB 文件、畸形名、dataURL 存量数据），
// 抽成纯函数后全部变成值断言。
//
// 另有一条源码级守卫：Office 三个库合计约 1.5MB，一旦有人把它们改成静态 import，
// 主 chunk 立刻膨胀 —— 这条断言就是那个门槛的自动化形态。

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATTACHMENT_ALLOWED_EXTENSIONS,
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_REQUEST_BYTES,
  uploadCodeHint,
  attachmentFromLink,
  extOfName,
  formatBytes,
  isAllowedAttachmentName,
  isBlobUrl,
  isDataUrl,
  isAbsoluteUrl,
  isServerAttachmentId,
  canPreviewInline,
  previewKindLabel,
  previewMime,
  previewRejection,
  resolvePreviewKind,
  toAttachmentDtos,
  validateAttachmentFiles,
  type AttachmentCandidate,
} from "./policy";

const f = (name: string, size = 1024): AttachmentCandidate => ({ name, size });
const MB = 1024 * 1024;

// ---------------------------------------------------------------- 扩展名与白名单

describe("扩展名解析与白名单（与后端 EXT_MIME 同口径）", () => {
  it("常规文件名取小写扩展名，大写与混合大小写一并归一", () => {
    expect(extOfName("报告.PDF")).toBe("pdf");
    expect(extOfName("a.b.xlsx")).toBe("xlsx");
    expect(extOfName("archive.tar.gz")).toBe("gz");
  });

  it("无扩展名 / 隐藏文件 / 末尾孤立点都不算扩展名", () => {
    for (const n of ["README", ".gitignore", "file.", "", "dir/file"]) {
      expect(extOfName(n)).toBe("");
    }
  });

  it("Windows 风格路径取 basename 的扩展名", () => {
    expect(extOfName("C:\\Users\\me\\预算.xlsx")).toBe("xlsx");
  });

  it("白名单内的扩展名放行，白名单外 / 无扩展名一律拒绝", () => {
    for (const ext of ATTACHMENT_ALLOWED_EXTENSIONS) {
      expect(isAllowedAttachmentName(`文件.${ext}`)).toBe(true);
      expect(isAllowedAttachmentName(`文件.${ext.toUpperCase()}`)).toBe(true);
    }
    for (const n of ["木马.exe", "脚本.sh", "数据.json", "无扩展名", ""]) {
      expect(isAllowedAttachmentName(n)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- 上传前校验

describe("上传前预校验：给出具体中文原因，不是笼统的「上传失败」", () => {
  it("全部合规：原样放行、零错误", () => {
    const r = validateAttachmentFiles([f("a.pdf"), f("b.xlsx", 3 * MB)]);
    expect(r.accepted).toHaveLength(2);
    expect(r.errors).toEqual([]);
  });

  it("格式不符：报「不支持的文件格式：xxx」，且不进入 accepted", () => {
    const r = validateAttachmentFiles([f("报表.pdf"), f("病毒.exe")]);
    expect(r.accepted.map((x) => x.name)).toEqual(["报表.pdf"]);
    expect(r.errors).toEqual(["不支持的文件格式：病毒.exe"]);
  });

  it("体积超限：报「文件 xxx 超过 20MB 上限」", () => {
    const r = validateAttachmentFiles([f("录像.mp4", ATTACHMENT_MAX_FILE_BYTES + 1)]);
    expect(r.accepted).toHaveLength(0);
    expect(r.errors[0]).toBe("文件 录像.mp4 超过 20MB 上限");
  });

  it("刚好等于上限的文件放行（边界：> 才拒绝）", () => {
    expect(validateAttachmentFiles([f("边界.pdf", ATTACHMENT_MAX_FILE_BYTES)]).accepted).toHaveLength(1);
  });

  it("数量超限：先按剩余名额截断，再报「最多 20 个」，已合规的文件仍然保留", () => {
    const many = Array.from({ length: 25 }, (_, i) => f(`f${i}.png`));
    const r = validateAttachmentFiles(many, 18);
    expect(r.accepted).toHaveLength(2);
    expect(r.errors).toEqual([`单个字段最多 ${ATTACHMENT_MAX_FILES} 个附件，多余的已跳过`]);
  });

  it("已经满额（已有 20 个）时再加任何文件都被拒，但不报格式错误", () => {
    const r = validateAttachmentFiles([f("新.png")], ATTACHMENT_MAX_FILES);
    expect(r.accepted).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("最多");
  });

  it("格式与体积问题同时命中：逐条各自报自己的原因，不互相吞掉", () => {
    const r = validateAttachmentFiles([f("坏.exe"), f("大.pdf", 99 * MB), f("好.png")]);
    expect(r.errors).toEqual([
      "不支持的文件格式：坏.exe",
      "文件 大.pdf 超过 20MB 上限",
    ]);
    expect(r.accepted.map((x) => x.name)).toEqual(["好.png"]);
  });

  it("上限可按调用方传入（兼容通道 2MB 走同一套逻辑）", () => {
    const r = validateAttachmentFiles([f("中.pdf", 5 * MB)], 0, ATTACHMENT_MAX_FILES, 2 * MB);
    expect(r.accepted).toHaveLength(0);
    expect(r.errors[0]).toBe("文件 中.pdf 超过 2MB 上限");
  });
});

// ------------------------------------------------- 两个上限旋钮（后端 ade1bd8 起分离）

describe("单文件上限 vs 整包上限：两个独立旋钮，不能互相越界", () => {
  it("守卫：单文件上限恒 ≤ 整包上限（后端 config.ts 启动时也校验同一条）", () => {
    expect(ATTACHMENT_MAX_FILE_BYTES).toBeLessThanOrEqual(ATTACHMENT_MAX_REQUEST_BYTES);
  });

  it("默认值与后端对齐：单文件 20MB、整包 40MB", () => {
    expect(ATTACHMENT_MAX_FILE_BYTES).toBe(20 * MB);
    expect(ATTACHMENT_MAX_REQUEST_BYTES).toBe(40 * MB);
  });

  it("为什么前端不用按整包分批：逐文件发请求时，单包 = 单文件 + 边界开销，够不着整包档", () => {
    // 一个满格单文件 + 1KB 边界开销，仍远小于整包档：413 在这条路径上不可能触发。
    const singleRequestBytes = ATTACHMENT_MAX_FILE_BYTES + 1024;
    expect(singleRequestBytes).toBeLessThan(ATTACHMENT_MAX_REQUEST_BYTES);
    // 反过来说：预校验只卡单文件就足够了，多文件不会叠加到同一个请求里。
    const many = Array.from({ length: 50 }, (_, i) => f(`图${i}.png`, 2 * MB));
    expect(validateAttachmentFiles(many, 0, 50, ATTACHMENT_MAX_FILE_BYTES).accepted).toHaveLength(50);
  });
});

describe("中间件机器码只补动作提示，不覆盖服务端文案", () => {
  it("PAYLOAD_TOO_LARGE 给出下一步该干嘛", () => {
    expect(uploadCodeHint("PAYLOAD_TOO_LARGE")).toContain("压缩");
  });

  it("未收录的码 / 脏值一律返回 null，交给调用方原样用服务端文案", () => {
    for (const c of [undefined, null, "", "  ", "NOT_A_CODE", 413, {}]) {
      expect(uploadCodeHint(c)).toBeNull();
    }
  });

  it("大小写带空格也能命中（中间件未来改写法不至于静默失效）", () => {
    expect(uploadCodeHint(" payload_too_large ")).toBeNull(); // 不做宽松匹配，改了就应有人来看
    expect(uploadCodeHint("PAYLOAD_TOO_LARGE")).not.toBeNull();
  });
});

// ---------------------------------------------------------------- 展示格式化

describe("体积展示", () => {
  it("1024 进制、保留一位小数并去掉尾随 .0", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(-1)).toBe("0B");
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(1024)).toBe("1KB");
    expect(formatBytes(1536)).toBe("1.5KB");
    expect(formatBytes(20 * MB)).toBe("20MB");
  });

  it("非数字 / NaN 不抛错，归零", () => {
    expect(formatBytes(Number.NaN)).toBe("0B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0B");
  });
});

// ---------------------------------------------------------------- 预览分派

describe("预览通道分派", () => {
  it("图片 / PDF / Office / 表格 / 文本 / 音视频各自落到正确通道", () => {
    expect(resolvePreviewKind("a.JPG")).toBe("image");
    expect(resolvePreviewKind("a.png")).toBe("image");
    expect(resolvePreviewKind("a.svg")).toBe("image");
    expect(resolvePreviewKind("a.pdf")).toBe("pdf");
    expect(resolvePreviewKind("a.docx")).toBe("docx");
    expect(resolvePreviewKind("a.xlsx")).toBe("spreadsheet");
    expect(resolvePreviewKind("a.xls")).toBe("spreadsheet");
    expect(resolvePreviewKind("a.csv")).toBe("csv");
    expect(resolvePreviewKind("a.txt")).toBe("text");
    expect(resolvePreviewKind("a.pptx")).toBe("pptx");
    expect(resolvePreviewKind("a.mp4")).toBe("video");
    expect(resolvePreviewKind("a.mp3")).toBe("audio");
  });

  it("老二进制格式（doc/ppt）与压缩包不给在线预览，走下载降级", () => {
    for (const n of ["旧文档.doc", "旧演示.ppt", "打包.zip", "打包.rar"]) {
      expect(resolvePreviewKind(n)).toBe("none");
      expect(canPreviewInline(resolvePreviewKind(n))).toBe(false);
    }
  });

  it("白名单外的扩展名一律 none（不拿 mime 冒险放行）", () => {
    expect(resolvePreviewKind("伪装.pdf.exe")).toBe("none");
    expect(resolvePreviewKind("payload.html", "text/html")).toBe("none");
  });

  it("扩展名缺失时退回 mime 判定；mime 也不认识则 none", () => {
    expect(resolvePreviewKind("无扩展名", "application/pdf")).toBe("pdf");
    expect(resolvePreviewKind("无扩展名", "image/png")).toBe("image");
    expect(resolvePreviewKind("无扩展名", "application/octet-stream")).toBe("none");
    expect(resolvePreviewKind("无扩展名")).toBe("none");
  });

  it("存量 base64 附件（mime 常是 octet-stream）仍能按文件名分派", () => {
    expect(resolvePreviewKind("合同.pdf", "application/octet-stream")).toBe("pdf");
    expect(resolvePreviewKind("照片.jpg", "application/octet-stream")).toBe("image");
  });

  it("每个通道都有中文名（降级面板要显示）", () => {
    for (const k of ["image", "pdf", "docx", "spreadsheet", "csv", "text", "pptx", "video", "audio", "none"] as const) {
      expect(previewKindLabel(k).length).toBeGreaterThan(0);
    }
  });
});

describe("预览前置守卫", () => {
  it("合规可预览的文件返回 null", () => {
    expect(previewRejection({ name: "a.pdf", size: 1024 })).toBeNull();
    expect(previewRejection({ name: "a.xlsx", size: 5 * MB })).toBeNull();
  });

  it("格式不符 / 体积超限 / 通道不支持各自给出面向用户的中文原因", () => {
    expect(previewRejection({ name: "x.exe" })).toBe("不支持的文件格式：x.exe");
    expect(previewRejection({ name: "大.pdf", size: 50 * MB })).toContain("请下载后打开");
    expect(previewRejection({ name: "旧.doc", size: 1024 })).toContain("暂不支持在线预览");
  });

  it("体积未知（存量 dataURL 的 size 常为 0）时不因缺元数据拒绝服务", () => {
    expect(previewRejection({ name: "老附件.pdf", size: 0 })).toBeNull();
    expect(previewRejection({ name: "老附件.pdf" })).toBeNull();
  });
});

describe("blob MIME 推导", () => {
  it("mime 有效时原样使用（含参数一并剥离）", () => {
    expect(previewMime("a.pdf", "application/pdf; charset=binary")).toBe("application/pdf");
  });

  it("mime 缺失或是 octet-stream 时按扩展名补回", () => {
    expect(previewMime("a.pdf", "application/octet-stream")).toBe("application/pdf");
    expect(previewMime("a.PNG", "")).toBe("image/png");
    expect(previewMime("a.csv")).toBe("text/csv;charset=utf-8");
  });
});

// ---------------------------------------------------------------- URL 形态

describe("URL 形态判定（决定要不要加鉴权头、能不能调 DELETE）", () => {
  it("data URL（存量 base64 附件）与 blob URL 都不发请求", () => {
    expect(isDataUrl("data:application/pdf;base64,AAAA")).toBe(true);
    expect(isDataUrl("/api/attachments/1/content")).toBe(false);
    expect(isBlobUrl("blob:http://host/uuid")).toBe(true);
  });

  it("绝对 URL 原样透传，相对路径交给 withBase 补部署前缀", () => {
    expect(isAbsoluteUrl("https://x/y.pdf")).toBe(true);
    expect(isAbsoluteUrl("//host/y.pdf")).toBe(true);
    expect(isAbsoluteUrl("/api/attachments/1/content")).toBe(false);
  });

  it("只有服务端附件 id 才调 DELETE；dataURL 形态的假 id 必须跳过", () => {
    expect(isServerAttachmentId("att_01")).toBe(true);
    expect(isServerAttachmentId("")).toBe(false);
    expect(isServerAttachmentId("data:image/png;base64,AAA")).toBe(false);
  });
});

// ---------------------------------------------------------------- 脏数据容错

describe("单元格值 → AttachmentDTO[]（脏数据不抛错）", () => {
  it("非数组 / null / 原始值都得到空列表", () => {
    for (const v of [null, undefined, "x", 42, {}]) {
      expect(toAttachmentDtos(v)).toEqual([]);
    }
  });

  it("字段缺失时补兜底值，且补出来的 key 稳定不重复", () => {
    const r = toAttachmentDtos([{}, { url: "data:a,b" }, null, "junk"]);
    expect(r).toHaveLength(4);
    expect(r[0]!.name).toBe("附件");
    expect(r[0]!.url).toBe("");
    expect(r[0]!.size).toBe(0);
    expect(new Set(r.map((x) => x.id)).size).toBe(4);
  });

  it("正常值原样透传（形状不改，AttachmentDTO 契约不变）", () => {
    const dto = { id: "a1", name: "合同.pdf", size: 2048, mime: "application/pdf", url: "/api/attachments/a1/content" };
    expect(toAttachmentDtos([dto])[0]).toEqual(dto);
  });

  it("只读展示项 → 预览所需 DTO：url/name 透传，缺失的 size/mime 归零", () => {
    expect(attachmentFromLink({ url: "/api/attachments/a1/content", name: "合同.pdf" })).toEqual({
      id: "/api/attachments/a1/content",
      name: "合同.pdf",
      size: 0,
      mime: "",
      url: "/api/attachments/a1/content",
    });
  });
});

// ---------------------------------------------------------------- 体积守卫（源码级）

describe("体积守卫：Office 三件套只允许动态 import", () => {
  const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const OFFICE_LIBS = ["docx-preview", "@keep-lts/xlsx", "@file-viewer/pptx"];

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(abs);
    }
    return out;
  };

  const allFiles = walk(srcRoot);
  const renderersPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "renderers.ts");

  it("renderers.ts 里三个库都出现在 import(...) 中", () => {
    const src = readFileSync(renderersPath, "utf8");
    for (const lib of OFFICE_LIBS) {
      expect(src).toContain(`import("${lib}")`);
    }
  });

  it("除 renderers.ts 外，源码里不得出现这三个库的静态 import", () => {
    const offenders: string[] = [];
    for (const file of allFiles) {
      if (file === renderersPath) continue;
      const src = readFileSync(file, "utf8");
      for (const lib of OFFICE_LIBS) {
        // 静态 import 的形态：`from "lib"` / `import "lib"`；import("lib") 是动态，不算。
        if (new RegExp(`(from\\s+"${lib}"|import\\s+"${lib}")`).test(src)) offenders.push(`${file} → ${lib}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
