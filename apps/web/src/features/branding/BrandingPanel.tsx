// 工作区设置「品牌外观」分区（#754）：仅超管/管理员可见（由 WorkspaceSettingsPage 的
// ownerOnly 分区门控保证，本组件默认已在授权态挂载，不再自判身份）。
//
// 能力：
//   - 产品名：PATCH 文本；后端约束 trim 后 1..30 非空，故「留空回退默认」在前端落地为
//     空串保存时写回 DEFAULT_BRANDING.productName（后端没有「清空产品名」语义）。
//   - 版权文案：0..120，空串=全站不显示；支持 {year} 占位，下附当前年份实时预览。
//   - 广告图：本地先拦类型（jpg/png/webp）与 5MB，再走 uploadHero multipart；
//     自定义态可一键「恢复默认图」（DELETE hero）。
// 所有 mutation 成功后 useBrandingAdmin 统一 invalidate QK.branding，登录页/顶栏/版权
// 下一轮渲染即时生效，无需刷新。

import { useRef, useState } from "react";
import { BRANDING_LIMITS } from "@gx/shared-types";
import { ApiError, withBase } from "../../api/client";
import { Button, Input, Textarea, toast } from "../../components/ui";
import { useBrandingAdmin, DEFAULT_HERO_URL } from "./useBranding";
import { DEFAULT_BRANDING, renderCopyright } from "./branding-text";
import {
  HERO_ACCEPTED_TYPES,
  buildBrandingPatch,
  validateBrandingText,
  validateHeroFile,
} from "./branding-panel-logic";

/** 从 ApiError 取后端中文消息，其余错误给固定兜底。 */
function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return (err.body as { error?: string } | null)?.error ?? fallback;
  }
  return fallback;
}

/** 文本表单的本地草稿（用户开始编辑才出现；保存成功后清空回到服务端值）。 */
interface TextDraft {
  productName: string;
  copyright: string;
}

export function BrandingPanel() {
  // enabled=true：面板只在 ownerOnly 分区通过后挂载；非 owner 根本不会进入本组件。
  const { configQuery, updateBranding, uploadHero, resetHero } =
    useBrandingAdmin({ enabled: true });
  const config = configQuery.data;

  // 为什么不用「useEffect 同步 config → state」：SSR/首帧不跑 effect，预置缓存下输入框
  // 会先空一帧；改为「未编辑时值直接派生自 config，编辑后才落到 draft」，首帧即真值，
  // 保存成功后清 draft 回到服务端最新值（invalidate 后的 refetch 数据）。
  const [draft, setDraft] = useState<TextDraft | null>(null);
  // 默认名在输入框里呈现为空 + placeholder 提示「留空使用默认」；自定义名才回填。
  const productName =
    draft?.productName ??
    (config && config.productName !== DEFAULT_BRANDING.productName
      ? config.productName
      : "");
  const copyright = draft?.copyright ?? config?.copyright ?? "";

  const fileRef = useRef<HTMLInputElement>(null);
  const [heroBusy, setHeroBusy] = useState<"upload" | "reset" | null>(null);

  // 自定义图地址过 withBase 兼容子路径；null（未配置）用内置默认图。
  const heroSrc = config?.heroUrl ? withBase(config.heroUrl) : DEFAULT_HERO_URL;
  const hasCustomHero = config?.heroUrl != null;

  // 脏检查：产品名以「输入框原文」对比（默认名在输入框里呈现为空 + placeholder 提示）。
  const savedNameIsCustom =
    (config?.productName ?? "") !== DEFAULT_BRANDING.productName;
  const savedNameInput = savedNameIsCustom ? (config?.productName ?? "") : "";
  const nameDirty = productName.trim() !== savedNameInput.trim();
  const copyrightDirty = copyright !== (config?.copyright ?? "");
  const textDirty = nameDirty || copyrightDirty;

  async function saveText() {
    const invalid = validateBrandingText(productName, copyright);
    if (invalid) {
      toast(invalid, "error");
      return;
    }
    try {
      await updateBranding.mutateAsync(
        buildBrandingPatch(productName, copyright),
      );
      // 清草稿：输入框回落到保存后的服务端值（invalidate 触发同键 refetch）。
      setDraft(null);
      toast("品牌信息已保存，全站已即时生效", "success");
    } catch (err) {
      toast(errorText(err, "保存失败"), "error");
    }
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
    setHeroBusy("upload");
    try {
      await uploadHero.mutateAsync(file);
      toast("广告图已更换，登录页已即时生效", "success");
    } catch (err) {
      toast(errorText(err, "上传失败"), "error");
    } finally {
      setHeroBusy(null);
    }
  }

  async function onResetHero() {
    setHeroBusy("reset");
    try {
      await resetHero.mutateAsync();
      toast("已恢复内置默认广告图", "success");
    } catch (err) {
      toast(errorText(err, "恢复失败"), "error");
    } finally {
      setHeroBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* 文本配置 */}
      <section className="rounded-gx-lg border border-gx-border p-4">
        <div className="text-gx-14 font-medium text-gx-text-primary">
          名称与版权
        </div>

        <div className="mt-3 flex flex-col gap-1.5">
          <label
            htmlFor="branding-product-name"
            className="text-gx-12 text-gx-text-tertiary"
          >
            产品名
          </label>
          <Input
            id="branding-product-name"
            value={productName}
            maxLength={BRANDING_LIMITS.productNameMax}
            placeholder={`留空则使用默认名称「${DEFAULT_BRANDING.productName}」`}
            onChange={(e) =>
              setDraft({ productName: e.target.value, copyright })
            }
          />
          <span className="text-gx-11 text-gx-text-hint">
            显示在登录页、浏览器标签标题与顶部导航，最多{" "}
            {BRANDING_LIMITS.productNameMax} 字符；留空恢复默认名称。
          </span>
        </div>

        <div className="mt-3 flex flex-col gap-1.5">
          <label
            htmlFor="branding-copyright"
            className="text-gx-12 text-gx-text-tertiary"
          >
            版权信息
          </label>
          <Textarea
            id="branding-copyright"
            rows={2}
            value={copyright}
            maxLength={BRANDING_LIMITS.copyrightMax}
            placeholder="留空则不显示版权行，例如：© {year} 构想科技"
            onChange={(e) =>
              setDraft({ productName, copyright: e.target.value })
            }
          />
          <div className="flex items-center justify-between text-gx-11 text-gx-text-hint">
            <span>
              支持 <code className="font-mono">{"{year}"}</code>{" "}
              自动替换为当前年份；留空不显示版权行。
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

        <div className="mt-4">
          <Button
            variant="primary"
            onClick={() => void saveText()}
            disabled={!textDirty}
            loading={updateBranding.isPending}
          >
            保存名称与版权
          </Button>
        </div>
      </section>

      {/* 广告图配置 */}
      <section className="rounded-gx-lg border border-gx-border p-4">
        <div className="text-gx-14 font-medium text-gx-text-primary">
          登录页广告图
        </div>
        <div className="mt-1 text-gx-12 text-gx-text-tertiary">
          显示在桌面登录页左栏，建议竖版图片；支持 JPG / PNG / WebP，不超过
          5MB。
        </div>

        <div className="mt-3 flex items-start gap-4">
          <div className="h-40 w-28 shrink-0 overflow-hidden rounded-gx-lg border border-gx-border bg-gx-control">
            <img
              src={heroSrc}
              alt="登录页广告图预览"
              className="h-full w-full object-cover"
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="text-gx-12 text-gx-text-secondary">
              当前：{hasCustomHero ? "已使用自定义广告图" : "内置默认广告图"}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                icon="upload"
                onClick={() => fileRef.current?.click()}
                loading={heroBusy === "upload"}
              >
                上传广告图
              </Button>
              <Button
                variant="ghost"
                icon="restore"
                onClick={() => void onResetHero()}
                disabled={!hasCustomHero}
                loading={heroBusy === "reset"}
                disabledReason="当前已是默认广告图"
              >
                恢复默认图
              </Button>
            </div>
            <span className="text-gx-11 text-gx-text-hint">
              更换后登录页左栏立即更新；旧图会被服务端自动清理。
            </span>
          </div>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept={[...HERO_ACCEPTED_TYPES].join(",")}
          className="hidden"
          onChange={(e) => void onPickFile(e)}
        />
      </section>
    </div>
  );
}
