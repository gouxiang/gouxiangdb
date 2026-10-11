// apps/api/src/domain/update/installGuide.ts
// 人工安装指引文案的唯一装配处（DESIGN §7.2，逐字中文文案锁定）。
//
// 纪律：
//   - 文案集中在本文件维护，策略（strategies/*.ts）只调用本文件的装配函数，禁止在各处散写；
//   - 只输出纯文本步骤（前端按 ol 渲染），禁嵌 HTML；
//   - filename 来自 manifest 白名单字段，不经用户输入拼接；filename=null（below-min 等
//     artifact 缺席场景）时用通用占位，绝不输出 undefined。

import type { InstallGuideKind, ManualInstallGuideDTO } from "@gx/shared-types";

/** fnos-upload 升级前提示（备份/数据保留口径 + 失败处置，两段）。 */
const FNOS_PRE_UPGRADE_NOTE = [
  "升级前请注意：飞牛在安装升级包前会自动对当前数据做一次在线备份（备份失败会中止升级）；"
    + "您的数据库与上传文件保存在共享存储中，升级应用不会删除它们。",
  "若安装过程中平台提示失败，请不要重复强制安装，携带本页面显示的当前版本与架构信息联系支持。",
].join("\n\n");

function fnosSteps(version: string, filename: string): string[] {
  return [
    `点击上方按钮，将 ${filename} 下载到本机；`,
    "打开飞牛 fnOS 的「应用中心」；",
    "选择「手动安装 / 上传安装包」（不同 fnOS 版本文案可能略有差异）；",
    "选中刚下载的 .fpk 文件并确认安装，平台将自动完成升级"
      + "（包含数据库迁移，期间服务会短暂重启）；",
    `安装完成后重新打开构想工作台，在本页面确认版本号已变为 ${version}。`,
  ];
}

/**
 * 装配飞牛 fpk 手动上传安装指引。
 * @param version 目标发布版本（步骤 5 提示的版本号）。
 * @param filename 目标 artifact 文件名；null 时用通用占位（below-min：artifact 缺席）。
 */
export function renderFnosUploadGuide(
  version: string,
  filename: string | null,
): ManualInstallGuideDTO {
  const name = filename ?? "升级包（.fpk）";
  return {
    kind: "fnos-upload" satisfies InstallGuideKind,
    steps: fnosSteps(version, name),
    preUpgradeNote: FNOS_PRE_UPGRADE_NOTE,
  };
}
