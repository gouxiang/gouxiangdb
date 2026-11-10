// 工作流引擎未启用时的「如何启用」自助指引卡（纯展示、无 hooks、无 IO，可 SSR 直测）。
//
// 为什么需要它：工作流引擎由服务端环境变量 GX_WORKFLOW_ENGINE 总门控制，出厂默认 off，
// 界面既不能代改环境也不能代重启。这里把可执行步骤与可手动选中的配置片段直接给出，
// 让管理员能自助完成开启。刻意不做复制按钮、不引 useState——保证无 hooks 护栏通过，
// node 环境 renderToStaticMarkup 可直接渲染（范本见 features/search/SearchEnableGuide，
// 那一份带复制交互，本卡片只保留静态骨架）。
import { Icon } from "../../components/icons";

const ENABLE_SNIPPET = "GX_WORKFLOW_ENGINE=on";

export function WorkflowDisabledState() {
  return (
    <section
      data-gx-workflow-disabled="true"
      className="rounded-gx-lg border border-gx-separator bg-gx-bg p-4"
    >
      <h3 className="flex items-center gap-1.5 text-gx-14 font-semibold text-gx-text-primary">
        <Icon name="workflow" size={14} className="text-gx-text-hint" />
        工作流引擎未启用
      </h3>

      <p className="mt-2 text-gx-12 text-gx-text-secondary">
        工作流引擎出厂默认关闭，当前实例尚未开启。界面无法代为修改环境变量或重启服务，需要在服务端调整配置后重启才能生效。
      </p>

      <ol className="mt-3 flex flex-col gap-1.5 text-gx-12 text-gx-text-secondary">
        <li className="flex gap-2">
          <span className="shrink-0 font-medium text-gx-text-tertiary">1.</span>
          <span>在服务端环境变量配置中加入下面这一行（片段可手动选中后复制）：</span>
        </li>
      </ol>

      <pre className="mt-2 overflow-x-auto rounded-gx-lg border border-gx-separator bg-gx-surface p-3 font-mono text-gx-11 leading-relaxed text-gx-text-primary">
        {ENABLE_SNIPPET}
      </pre>

      <div className="mt-3 flex flex-col gap-1 text-gx-12 text-gx-text-secondary">
        <span className="flex gap-2">
          <span className="shrink-0 font-medium text-gx-text-tertiary">2.</span>
          <span>保存配置后重启服务，工作流入口即可正常使用。</span>
        </span>
      </div>
    </section>
  );
}
