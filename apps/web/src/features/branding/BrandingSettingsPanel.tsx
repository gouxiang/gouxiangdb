// 工作区设置「品牌外观」分区（#754）：管理员配置产品名 / 版权 / 登录页广告图。
// 视觉对齐 features/kb/UploadLimitsPanel 的单卡：头行（图标+标题 / 恢复默认文案+保存），
// 卡身 divide-y 三行。所有颜色走 gx-* token，图标用自建 SVG，无 emoji、零新依赖。
//
// 权限双保险：页面 SECTIONS ownerOnly 已把门（非 owner 不挂载、直访 URL 回落通用），
// 组件内再用 useIsWorkspaceOwner 自判——非 owner 或角色探针未回（isLoading）一律 return null，
// 避免门控信号缺失时闪现管理面板。
//
// 表单采用「draft 派生」而非 useEffect 回填：未编辑时值直接派生自 config（SSR 首帧即真值，
// 不先空一帧），开始编辑才落本地 draft；保存成功清 draft 回落 invalidate 后的最新服务端值。

import { useEffect, useRef, useState } from "react";
import { BRANDING_LIMITS } from "@gx/shared-types";
import { ApiError, withBase } from "../../api/client";
import { Button, Input, Textarea, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { useIsWorkspaceOwner } from "../contacts/contacts-hooks";
import { useBrandingAdmin, DEFAULT_HERO_URL } from "./useBranding";
import { DEFAULT_BRANDING, renderCopyright } from "./branding-text";
import {
  HERO_ACCEPTED_TYPES,
  buildBrandingPatch,
  validateBrandingInput,
  validateHeroFile,
} from "./branding-settings-logic";

/** 两步「恢复默认图」确认窗口：首次点变「确认恢复？」，3 秒内未再点自动还原。 */
const RESET_CONFIRM_MS = 3000;

/** 从 ApiError 取后端中文消息，其余错误给固定兜底。 */
function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return (err.body as { error?: string } | null)?.error ?? fallback;
  }
  return fallback;
}

/** 文本表单的本地草稿（用户开始编辑才出现；点「恢复默认文案」或保存成功后重置）。 */
interface TextDraft {
  productName: string;
  copyright: string;
}

export function BrandingSettingsPanel() {
  // 双保险：非 owner / 探针未回都不渲染（fail-closed，不闪现管理面板）。
  const { isOwner, isLoading } = useIsWorkspaceOwner();
  const { configQuery, updateBranding, uploadHero, resetHero } =
    useBrandingAdmin({ enabled: isOwner });
  const config = configQuery.data;

  const [draft, setDraft] = useState<TextDraft | null>(null);
  // 产品名无论是否等于默认名都直接回填显示（不再把默认名呈现为「留空=默认」）。
  const productName = draft?.productName ?? config?.productName ?? "";
  const copyright = draft?.copyright ?? config?.copyright ?? "";

  const fileRef = useRef<HTMLInputElement>(null);
  // 两步恢复确认：confirming 为确认态；timerRef 存自动还原句柄。
  const [confirmingReset, setConfirmingReset] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载时清掉待执行的自动还原，避免对已卸载组件 setState。
  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  function clearResetTimer() {
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
  }

  // 自定义图地址过 withBase 兼容子路径；null（未配置）用内置默认图。
  const heroSrc = config?.heroUrl ? withBase(config.heroUrl) : DEFAULT_HERO_URL;
  const hasCustomHero = config?.heroUrl != null;

  const nameDirty = productName.trim() !== (config?.productName ?? "").trim();
  const copyrightDirty = copyright !== (config?.copyright ?? "");
  const textDirty = nameDirty || copyrightDirty;

  async function saveText() {
    const invalid = validateBrandingInput(productName, copyright);
    if (invalid) {
      toast(invalid, "error");
      return;
    }
    try {
      await updateBranding.mutateAsync(
        buildBrandingPatch(productName, copyright),
      );
      setDraft(null); // 回落 invalidate refetch 后的最新服务端值
      toast("品牌设置已保存", "success");
    } catch (err) {
      toast(errorText(err, "保存失败，请重试"), "error");
    }
  }

  // 「恢复默认文案」：只回填草稿（默认名 + 空版权），不发请求；仍由用户点保存提交。
  function restoreDefaultText() {
    setDraft({ productName: DEFAULT_BRANDING.productName, copyright: "" });
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许重选同一文件
    if (!file) return;
    const invalid = validateHeroFile(file);
    if (invalid) {
      toast(invalid, "error");
      return;
    }
    try {
      await uploadHero.mutateAsync(file);
      toast("广告图已更新", "success");
    } catch (err) {
      toast(errorText(err, "上传失败，请重试"), "error");
    }
  }

  // 两步确认：首次点进入确认态并启动 3s 自动还原；再点才真删；失焦/超时自动还原。
  function armResetConfirm() {
    clearResetTimer();
    setConfirmingReset(true);
    resetTimer.current = setTimeout(
      () => setConfirmingReset(false),
      RESET_CONFIRM_MS,
    );
  }

  async function confirmResetHero() {
    clearResetTimer();
    setConfirmingReset(false);
    try {
      await resetHero.mutateAsync();
      toast("已恢复默认广告图", "success");
    } catch (err) {
      toast(errorText(err, "恢复失败，请重试"), "error");
    }
  }

  if (!isOwner || isLoading) return null;

  return (
    <div className="rounded-gx-lg border border-gx-border bg-gx-surface">
      {/* 头行 */}
      <div className="flex items-center justify-between border-b border-gx-separator px-4 py-3">
        <div className="flex items-center gap-2 text-gx-13 font-medium text-gx-text-primary">
          <Icon name="palette" size={16} className="text-gx-accent" />
          品牌外观
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={restoreDefaultText}
            className="rounded-gx-lg px-2.5 py-1 text-gx-12 text-gx-text-tertiary transition-colors duration-[120ms] hover:bg-gx-bg"
          >
            恢复默认文案
          </button>
          <button
            type="button"
            onClick={() => void saveText()}
            disabled={!textDirty}
            title={!textDirty ? "没有未保存的改动" : undefined}
            className="inline-flex h-7 items-center gap-1 rounded-gx-lg bg-gx-accent px-3 text-gx-12 font-medium text-white transition-[filter] duration-[120ms] hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
          >
            <Icon name="check" size={13} />
            保存
          </button>
        </div>
      </div>

      <div className="divide-y divide-gx-separator">
        {/* a. 产品显示名称 */}
        <div className="flex flex-col gap-1.5 px-4 py-3">
          <label
            htmlFor="branding-product-name"
            className="text-gx-13 text-gx-text-primary"
          >
            产品显示名称
          </label>
          <Input
            id="branding-product-name"
            value={productName}
            maxLength={BRANDING_LIMITS.productNameMax}
            placeholder="请输入产品显示名称"
            onChange={(e) =>
              setDraft({ productName: e.target.value, copyright })
            }
          />
          <div className="flex items-center justify-between text-gx-11 text-gx-text-hint">
            <span>
              显示在登录页、浏览器标题与全站顶部。留空无法保存；恢复默认请点右侧按钮
            </span>
            <span>
              {productName.length}/{BRANDING_LIMITS.productNameMax}
            </span>
          </div>
        </div>

        {/* b. 版权信息 */}
        <div className="flex flex-col gap-1.5 px-4 py-3">
          <label
            htmlFor="branding-copyright"
            className="text-gx-13 text-gx-text-primary"
          >
            版权信息
          </label>
          <Textarea
            id="branding-copyright"
            rows={2}
            value={copyright}
            maxLength={BRANDING_LIMITS.copyrightMax}
            placeholder="留空则不展示，例如：© {year} 构想科技"
            onChange={(e) =>
              setDraft({ productName, copyright: e.target.value })
            }
          />
          <div className="flex items-center justify-between text-gx-11 text-gx-text-hint">
            <span>
              显示在登录页左下；留空则不展示。支持{" "}
              <code className="font-mono">{"{year}"}</code> 自动替换为当前年份
            </span>
            <span>
              {copyright.length}/{BRANDING_LIMITS.copyrightMax}
            </span>
          </div>
          {copyright.trim() && (
            <div className="rounded-gx-sm bg-gx-control px-2.5 py-1.5 text-gx-12 text-gx-text-secondary">
              预览：{renderCopyright(copyright)}
            </div>
          )}
        </div>

        {/* c. 登录页广告图 */}
        <div className="flex items-start gap-4 px-4 py-3">
          <div className="h-[120px] w-[160px] shrink-0 overflow-hidden rounded-gx-lg border border-gx-border bg-gx-control">
            <img
              src={heroSrc}
              alt="登录页广告图预览"
              className="h-full w-full object-cover"
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <label className="inline-flex h-8 w-fit cursor-pointer items-center gap-1.5 rounded-gx-lg border border-gx-border bg-gx-control px-3 text-gx-13 text-gx-text-secondary transition-colors duration-[120ms] hover:bg-gx-row-hover">
              <Icon name="upload" size={15} />
              上传图片
              <input
                ref={fileRef}
                type="file"
                accept={[...HERO_ACCEPTED_TYPES].join(",")}
                className="hidden"
                onChange={(e) => void onPickFile(e)}
              />
            </label>
            {hasCustomHero && (
              <Button
                variant={confirmingReset ? "danger" : "ghost"}
                size="sm"
                icon={confirmingReset ? undefined : "restore"}
                className="w-fit px-1"
                onBlur={() => setConfirmingReset(false)}
                loading={resetHero.isPending}
                onClick={() =>
                  confirmingReset ? void confirmResetHero() : armResetConfirm()
                }
              >
                {confirmingReset ? "确认恢复？" : "恢复默认图"}
              </Button>
            )}
            <span className="text-gx-11 text-gx-text-hint">
              支持 PNG/JPG/WebP，不超过 5MB；建议竖版 2:3，画面避免文字
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
