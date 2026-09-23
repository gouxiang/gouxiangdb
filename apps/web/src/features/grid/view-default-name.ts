// apps/web/src/features/grid/view-default-name.ts
// 新建视图弹窗的「类型 → 默认名」映射（纯数据 + 纯函数，单测可直接引用断言）。
//
// 缺陷背景：弹窗给名称框填默认值时写死了 `${VIEW_TYPE_LABEL.grid}视图`，于是选了「看板」
// 名字框里仍是「网格视图」，一路点下去就创建出一个名字说谎的视图。
//
// 映射按共享包的 VIEW_TYPE_LABEL 派生，不另造一套说法（标签改了这里自动跟上）；覆盖 UI 上
// 实际存在的全部六种类型（VIEW_TYPES）。纯函数把 await/React 都剥掉，测试不用渲染组件。

import { VIEW_TYPES, VIEW_TYPE_LABEL, type ViewType } from "@gx/shared-types";

/** 类型 → 新建视图时的默认名：「网格」→「网格视图」、「看板」→「看板视图」…… */
export const VIEW_TYPE_DEFAULT_NAME: Record<ViewType, string> = Object.fromEntries(
  VIEW_TYPES.map((t) => [t, `${VIEW_TYPE_LABEL[t]}视图`]),
) as Record<ViewType, string>;

/** 某个类型新建视图时该给的默认名。 */
export function defaultViewName(type: ViewType): string {
  return VIEW_TYPE_DEFAULT_NAME[type];
}

/**
 * 弹窗里切换类型时名称框该怎么走：
 *   - 当前名字还是某个类型的预设默认名（说明用户没手改过）→ 跟着类型换成新类型的默认名；
 *   - 用户已经改成自定义名 → 原样保留，不抢他的输入。
 *
 * 为什么不能无脑覆盖：用户先选「看板」再手动敲好名字，回头点一下类型按钮就把输入清掉，
 * 是比"名字不跟着变"更糟的丢数据。
 */
export function nextDefaultViewName(currentName: string, nextType: ViewType): string {
  const untouched = VIEW_TYPES.some((t) => currentName === VIEW_TYPE_DEFAULT_NAME[t]);
  return untouched ? VIEW_TYPE_DEFAULT_NAME[nextType] : currentName;
}
