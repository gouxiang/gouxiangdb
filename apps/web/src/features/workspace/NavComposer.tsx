// M3 导航编排器容器。
//
// S8：真实只读管理视图——全量菜单树（含 soft_dangling/broken 悬挂项标灰），
// 让设置中心「导航编排」成为真实入口而非占位；本文件不引任何写操作。
// S9 在本组件叠加 N2 增删改排/多处添加/别名、N4 group 分组、N6 move 影响预览、
// 二级三分区（全部/未收纳/已收纳）与 HTML5 拖拽。
//
// 规则（openapi state 三态，前端写死）：
//   alive 正常；soft_dangling 实体软删（shortcut 保留待恢复，标灰）；
//   broken 节点物理消失（标灰可清理，S9 提供删除）。
import { useMemo } from "react";
import { useNavMenu } from "./nav-hooks";
import { useNavNodeIndex } from "./nav-hooks";
import { buildMenuTree, type MenuTreeNode } from "./lib/menu-tree";
import { navNodeHref } from "./lib/nav-links";
import { Icon, type IconName } from "../../components/icons";
import { Spinner } from "../../components/ui";

const STATE_LABEL: Record<string, string> = {
  alive: "正常",
  soft_dangling: "源已软删",
  broken: "已失效",
};

function ComposerRow({ node, depth }: { node: MenuTreeNode; depth: number }) {
  const { index } = useNavNodeIndex();
  const summary = node.item.node;
  const state = summary?.state ?? "broken";
  const dangling = state !== "alive";
  const icon: IconName = (node.item.iconName as IconName | null)
    ?? (node.item.type === "container" ? "group" : "link");
  const href =
    node.item.nodeId && index.byId.has(node.item.nodeId)
      ? navNodeHref(index, index.byId.get(node.item.nodeId)!)
      : null;

  return (
    <div>
      <div
        className="flex items-center gap-2 rounded-gx-sm py-1.5 pr-2"
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        <Icon name="grip" size={13} className="shrink-0 text-gx-text-hint" />
        <Icon
          name={icon}
          size={14}
          className={`shrink-0 ${dangling ? "text-gx-text-hint" : "text-gx-text-tertiary"}`}
        />
        <span className={`flex-1 truncate text-gx-13 ${dangling ? "text-gx-text-hint line-through" : "text-gx-text-primary"}`}>
          {node.item.label ?? summary?.name ?? "未命名"}
        </span>
        {node.item.label && summary?.name && node.item.label !== summary.name && (
          <span className="shrink-0 text-gx-11 text-gx-text-hint">→ {summary.name}</span>
        )}
        {dangling && (
          <span className="shrink-0 rounded-gx-pill bg-gx-warning-bg px-1.5 py-0.5 text-gx-11 text-gx-warning">
            {STATE_LABEL[state]}
          </span>
        )}
        {href && !dangling && (
          <span className="shrink-0 text-gx-11 text-gx-text-hint">已挂载</span>
        )}
      </div>
      {node.children.map((c) => (
        <ComposerRow key={c.item.id} node={c} depth={depth + 1} />
      ))}
    </div>
  );
}

export function NavComposer() {
  const { menu, isLoading, isError } = useNavMenu();
  const tree = useMemo(() => buildMenuTree(menu?.items ?? []), [menu?.items]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-gx-18 font-semibold text-gx-text-primary">导航编排</h2>
          <p className="mt-0.5 text-gx-12 text-gx-text-tertiary">
            菜单引用层：容器与快捷项可多处挂载；软删源自动标灰，恢复后自动还原。
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-gx-lg border border-gx-separator bg-gx-surface p-2">
        {isLoading ? (
          <div className="flex h-32 items-center justify-center"><Spinner size={18} /></div>
        ) : isError ? (
          <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">菜单加载失败，刷新重试</div>
        ) : tree.length === 0 ? (
          <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">菜单为空</div>
        ) : (
          tree.map((n) => <ComposerRow key={n.item.id} node={n} depth={0} />)
        )}
      </div>
    </div>
  );
}
