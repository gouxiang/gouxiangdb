// 手动安装指引：按后端下发的 guide.kind 渲染有序步骤 + 升级前提示（DESIGN §7.2）。
//
// 纪律：
//   - steps / preUpgradeNote 是后端 installGuide.ts 的逐字中文，前端原样渲染，不自行改写；
//   - 纯文本步骤，按 <ol> 展示，绝不 dangerouslySetInnerHTML；
//   - 折叠面板默认收起（下载之后用户才需要看），由父组件控制展开态，便于测试与无 JS 环境稳定。
import { useState } from "react";
import type { ManualInstallGuideDTO } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { UPDATE_COPY } from "./update-copy";

const KIND_LABEL: Record<ManualInstallGuideDTO["kind"], string> = {
  "fnos-upload": "飞牛 fnOS 手动上传安装",
  "bash-deploy": "服务器命令行部署",
  "desktop-installer": "桌面客户端安装",
};

export function UpdateInstallGuide({ guide, defaultOpen = false }: { guide: ManualInstallGuideDTO; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-gx-lg border border-gx-border bg-gx-control">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-gx-13 font-medium text-gx-text-primary hover:bg-gx-row-hover rounded-gx-lg"
      >
        <Icon name="history" size={14} className="shrink-0 text-gx-text-tertiary" />
        <span className="min-w-0 flex-1 truncate">
          {UPDATE_COPY.guideTitle}（{KIND_LABEL[guide.kind]}）
        </span>
        <Icon
          name={open ? "chevronUp" : "chevronDown"}
          size={14}
          className="shrink-0 text-gx-text-tertiary"
        />
      </button>
      {open && (
        <div className="border-t border-gx-separator px-3 py-3">
          <p className="text-gx-12 font-medium text-gx-text-secondary">{UPDATE_COPY.preUpgradeTitle}</p>
          <p className="mt-1 whitespace-pre-line text-gx-12 leading-5 text-gx-text-tertiary">
            {guide.preUpgradeNote}
          </p>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-gx-12 leading-5 text-gx-text-secondary">
            {guide.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
