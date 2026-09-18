// apps/web/src/features/kb/UploadLimitsPanel.tsx
// 「上传限制」设置卡片：为图片/视频/音频/PDF/附件五类配置单文件大小上限与允许的扩展名。
// 系统预填默认格式，用户以补充为主；保存到 localStorage（跨知识库全局生效）。
// 颜色全走 gx-* token，图标用自建 SVG，无 emoji。

import { useState } from "react";
import { Icon } from "../../components/icons";
import { toast } from "../../components/ui";
import {
  loadUploadLimits,
  saveUploadLimits,
  resetUploadLimits,
  DEFAULT_UPLOAD_LIMITS,
  UPLOAD_KIND_LABEL,
  type UploadKind,
  type UploadLimits,
} from "./upload-limits";

const KIND_ORDER: UploadKind[] = ["image", "video", "audio", "pdf", "file"];
const KIND_ICON: Record<UploadKind, Parameters<typeof Icon>[0]["name"]> = {
  image: "image",
  video: "video",
  audio: "audio",
  pdf: "file",
  file: "paperclip",
};

export function UploadLimitsPanel() {
  const [limits, setLimits] = useState<UploadLimits>(() => loadUploadLimits());
  const [savedTick, setSavedTick] = useState(false);

  function setMaxMb(kind: UploadKind, raw: string) {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    setLimits((prev) => ({
      ...prev,
      [kind]: { ...prev[kind], maxMb: Math.min(200, Math.max(1, Math.round(v))) },
    }));
    setSavedTick(false);
  }

  function setExts(kind: UploadKind, raw: string) {
    const exts = raw
      .split(/[,，\s]+/)
      .map((e) => e.trim().toLowerCase().replace(/^\./, ""))
      .filter(Boolean);
    setLimits((prev) => ({ ...prev, [kind]: { ...prev[kind], extensions: Array.from(new Set(exts)) } }));
    setSavedTick(false);
  }

  function save() {
    saveUploadLimits(limits);
    setSavedTick(true);
    toast("已保存上传限制", "success");
  }

  function restoreDefaults() {
    const d = resetUploadLimits();
    setLimits(d);
    setSavedTick(false);
    toast("已恢复系统默认限制", "success");
  }

  return (
    <div className="rounded-gx-lg border border-gx-border bg-gx-surface">
      <div className="flex items-center justify-between border-b border-gx-separator px-4 py-3">
        <div className="flex items-center gap-2 text-gx-13 font-medium text-gx-text-primary">
          <Icon name="paperclip" size={16} className="text-gx-accent" />
          上传限制
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={restoreDefaults}
            className="rounded-gx-lg px-2.5 py-1 text-gx-12 text-gx-text-tertiary hover:bg-gx-bg"
          >
            恢复默认
          </button>
          <button
            type="button"
            onClick={save}
            className="inline-flex h-7 items-center gap-1 rounded-gx-lg bg-gx-accent px-3 text-gx-12 font-medium text-white hover:brightness-95"
          >
            <Icon name="check" size={13} />
            保存{savedTick ? "（已保存）" : ""}
          </button>
        </div>
      </div>

      <div className="divide-y divide-gx-separator">
        {KIND_ORDER.map((kind) => {
          const cfg = limits[kind];
          const def = DEFAULT_UPLOAD_LIMITS[kind];
          return (
            <div key={kind} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
              <div className="flex w-32 shrink-0 items-center gap-2">
                <Icon name={KIND_ICON[kind]} size={15} className="text-gx-text-secondary" />
                <span className="text-gx-13 text-gx-text-primary">{UPLOAD_KIND_LABEL[kind]}</span>
              </div>
              <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
                <label className="flex items-center gap-1.5 text-gx-12 text-gx-text-tertiary">
                  大小上限
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={cfg.maxMb}
                    onChange={(e) => setMaxMb(kind, e.target.value)}
                    className="w-16 rounded-gx-sm border border-gx-border bg-gx-surface px-2 py-1 text-gx-13 text-gx-text-primary focus:border-gx-accent focus:outline-none"
                  />
                  MB
                </label>
                <label className="flex flex-1 items-center gap-1.5 text-gx-12 text-gx-text-tertiary">
                  允许格式
                  <input
                    type="text"
                    value={cfg.extensions.map((e) => "." + e).join(" ")}
                    onChange={(e) => setExts(kind, e.target.value)}
                    placeholder={def.extensions.map((e) => "." + e).join(" ")}
                    className="min-w-0 flex-1 rounded-gx-sm border border-gx-border bg-gx-surface px-2 py-1 font-mono text-gx-12 text-gx-text-primary focus:border-gx-accent focus:outline-none"
                  />
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <p className="border-t border-gx-separator px-4 py-2.5 text-gx-11 text-gx-text-hint">
        系统已预填默认可上传格式，你可以补充新的扩展名（用空格或逗号分隔）。限制对文档编辑器内的图片、视频、音频、PDF 与附件上传生效，保存在本机浏览器、跨全部知识库应用。
      </p>
    </div>
  );
}
