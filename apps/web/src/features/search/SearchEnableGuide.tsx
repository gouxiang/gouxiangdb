// 检索子面未启用时的「如何启用」自助指引块（纯展示 + 复制，无 IO）。
//
// 为什么需要它：检索子面由服务端环境变量 GX_M5_SEARCH 总门控制，出厂默认 off，界面既不能
// 代改环境也不能代重启。此前未启用时仍渲染整套配置表单，用户点了只弹一句"未启用"，等于
// 把人卡死；现在改为把可执行步骤与可复制片段直接给出，让管理员能自助完成开启。
import { useState } from "react";
import { Button, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { SEARCH_ENABLE_GUIDE as G } from "./search-admin-copy";
import { COPY_FAIL_HINT_TEXT, copyText } from "../../lib/clipboard";

export function SearchEnableGuide({ compact = false }: { compact?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    // 非安全上下文（局域网 HTTP）无 navigator.clipboard，走三级降级；失败时 pre 块本身可选中。
    if (await copyText(G.snippet)) {
      setCopied(true);
      toast(G.copyOk, "success");
    } else {
      toast(COPY_FAIL_HINT_TEXT, "error");
    }
  }

  return (
    <section className="rounded-gx-lg border border-gx-separator bg-gx-bg p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-gx-14 font-semibold text-gx-text-primary">
          <Icon name="help" size={14} className="text-gx-text-hint" />
          {G.title}
        </h3>
        <Button variant="ghost" size="sm" icon="copy" onClick={copy}>
          {copied ? "已复制" : "复制配置片段"}
        </Button>
      </div>

      <p className="mt-2 text-gx-12 text-gx-text-secondary">{G.intro}</p>

      {!compact && (
        <ol className="mt-3 flex flex-col gap-1.5 text-gx-12 text-gx-text-secondary">
          <li className="flex gap-2">
            <span className="shrink-0 font-medium text-gx-text-tertiary">1.</span>
            <span>
              打开应用的环境变量配置文件，位置通常是：
              <ul className="mt-1 flex flex-col gap-0.5 text-gx-11 text-gx-text-hint">
                {G.where.map((w) => (
                  <li key={w} className="font-mono">
                    {w}
                  </li>
                ))}
              </ul>
            </span>
          </li>
          <li className="flex gap-2">
            <span className="shrink-0 font-medium text-gx-text-tertiary">2.</span>
            <span>加入下列配置（片段可直接点右上角复制）：</span>
          </li>
        </ol>
      )}

      <pre className="mt-2 overflow-x-auto rounded-gx-lg border border-gx-separator bg-gx-surface p-3 font-mono text-gx-11 leading-relaxed text-gx-text-primary">
        {G.snippet}
      </pre>

      <div className="mt-3 flex flex-col gap-1 text-gx-12 text-gx-text-secondary">
        <span className="flex gap-2">
          <span className="shrink-0 font-medium text-gx-text-tertiary">{compact ? "·" : "3."}</span>
          <span>{G.finish}</span>
        </span>
        <span className="flex gap-2 text-gx-11 text-gx-text-hint">
          <span className="shrink-0">·</span>
          <span>{G.reassure}</span>
        </span>
      </div>
    </section>
  );
}
