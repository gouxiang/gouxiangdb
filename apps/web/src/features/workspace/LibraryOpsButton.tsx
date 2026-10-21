// v6 S1：L2 面板头的库级操作「⋯」（重命名 / 设置）。
//
// 这两项操作原挂在 L1 库行行尾菜单（PrimaryNav 的 RowMoreMenu）。v6 把 L1 改成
// 恒 76px 图标轨后，行尾没有空间放菜单；而操作语义是「当前所在库」——正好由 L2
// 面板头承载，故迁到这里。
//
// 与 RowMoreMenu 的差别（刻意）：
//   - 常驻可见：不走 gx-row-more 的 hover 显隐（图标轨砖上没有行 hover 容器语义，
//     且头部「⋯」必须随时可点）；
//   - 28×28 圆角按钮，弹层复用 components/ui 的同一个 Popover + Menu + MenuItem
//     （fixed portal，祖先 overflow:auto 不会裁剪）；
//   - 不放「删除库」，也不放任何权限项（权限统一在工作区设置 → 权限管理）。
//
// 纯受控：重命名回调由壳层注入（需 QueryClient，多份 SSR 回归不带
// QueryClientProvider）；设置跳转用本组件内的 useNavigate（SSR 下只渲染不触发）。
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../../components/icons";
import { Menu, MenuItem, Popover } from "../../components/ui";
import type { SecondaryContainer } from "./SecondaryNav";

export function LibraryOpsButton({
  container,
  onRenameLibrary,
}: {
  container: SecondaryContainer;
  /** 不传（壳层没注入回调）时菜单里只有「设置」。 */
  onRenameLibrary?: (kind: "base" | "kb", id: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const isKb = container.kind === "kb";
  const settingsHref = isKb ? `/kb/${container.id}/settings` : `/base/${container.id}/settings`;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title="库操作"
        aria-label="库操作"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-gx-lg text-gx-text-tertiary transition-colors hover:bg-gx-row-hover hover:text-gx-text-primary"
      >
        <Icon name="moreVertical" size={15} />
      </button>
      {/* 与 RowMoreMenu 同口径：Popover 仅打开时挂载（closed 时它内部 useLayoutEffect
          不做事，SSR 下还会徒增一条 useLayoutEffect 警告）。 */}
      {open && (
        <Popover open onClose={() => setOpen(false)} align="right" width={168} fixed anchorEl={btnRef.current}>
          <Menu width={168}>
            {onRenameLibrary && (
              <MenuItem
                icon="edit"
                label="重命名"
                onClick={() => {
                  setOpen(false);
                  onRenameLibrary(container.kind, container.id, container.name);
                }}
              />
            )}
            <MenuItem
              icon="settings"
              label="设置"
              description={isKb ? "打开知识库设置" : "打开数据库设置"}
              onClick={() => {
                setOpen(false);
                navigate(settingsHref);
              }}
            />
          </Menu>
        </Popover>
      )}
    </>
  );
}
