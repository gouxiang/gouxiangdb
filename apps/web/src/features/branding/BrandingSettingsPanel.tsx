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
import { BRANDING_LIMITS, normalizeServerBaseUrl } from "@gx/shared-types";
import { ApiError, withBase } from "../../api/client";
import { Button, Input, Switch, Textarea, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { copyText } from "../../lib/clipboard";
import { useIsWorkspaceOwner } from "../contacts/contacts-hooks";
import { useBrandingAdmin, DEFAULT_HERO_URL } from "./useBranding";
import { DEFAULT_BRANDING, deriveAutoServerBaseUrl, renderCopyright } from "./branding-text";
import {
  HERO_ACCEPTED_TYPES,
  buildBrandingPatch,
  validateBrandingInput,
  validateHeroFile,
} from "./branding-settings-logic";
import { useActiveSession } from "../../node/activeSession";
import { readActiveRemoteOrigin, resolveBrandingAutoOrigin } from "../../node/activeNodeUrl";

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
  serverBaseUrl: string;
}

export function BrandingSettingsPanel() {
  // 双保险：非 owner / 探针未回都不渲染（fail-closed，不闪现管理面板）。
  const { isOwner, isLoading } = useIsWorkspaceOwner();
  const { configQuery, updateBranding, uploadHero, resetHero, setSignupOpen } =
    useBrandingAdmin({ enabled: isOwner });
  const config = configQuery.data;

  const [draft, setDraft] = useState<TextDraft | null>(null);
  // 产品名无论是否等于默认名都直接回填显示（不再把默认名呈现为「留空=默认」）。
  const productName = draft?.productName ?? config?.productName ?? "";
  const copyright = draft?.copyright ?? config?.copyright ?? "";
  // 对外访问网址：未编辑时回显已保存值（空=未设置）。
  const serverBaseUrl = draft?.serverBaseUrl ?? config?.serverBaseUrl ?? "";

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
  // 网址按「规范化后」比较，避免仅尾斜杠/补协议差异导致保存按钮常亮。
  const urlDirty =
    normalizeServerBaseUrl(serverBaseUrl) !== normalizeServerBaseUrl(config?.serverBaseUrl ?? "");
  const textDirty = nameDirty || copyrightDirty || urlDirty;

  async function saveText() {
    const invalid = validateBrandingInput(productName, copyright, serverBaseUrl);
    if (invalid) {
      toast(invalid, "error");
      return;
    }
    try {
      await updateBranding.mutateAsync(
        buildBrandingPatch(productName, copyright, serverBaseUrl),
      );
      setDraft(null); // 回落 invalidate refetch 后的最新服务端值
      toast("品牌设置已保存", "success");
    } catch (err) {
      toast(errorText(err, "保存失败，请重试"), "error");
    }
  }

  // 「恢复默认文案」：只回填草稿（默认名 + 空版权 + 空网址），不发请求；仍由用户点保存提交。
  function restoreDefaultText() {
    setDraft({ productName: DEFAULT_BRANDING.productName, copyright: "", serverBaseUrl: "" });
  }

  // 一键复制「服务端网址」：未手动固定时复制自动识别出的当前地址（多地址环境下内网 IP 登录时
  // 需要把外网可用网址发给外部协作者）。剪贴板失败给手动复制提示。
  const savedServerBaseUrl = config?.serverBaseUrl ?? "";
  // 当前默认值（自动识别）。门控关（浏览器/fnOS）＝页面来源 origin，与历史行为一致；
  // 桌面壳里页面同源在 127.0.0.1 随机口，origin 不能对外，故按「活动节点」取正确地址：
  //   - 连远端：该远端节点的真实 origin（如 http://192.168.31.15:3001）；
  //   - 连本机：回环口不对外，自动地址留空（待本机局域网地址探测接入），不再显示 127.0.0.1。
  const session = useActiveSession();
  const browserOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const autoOrigin = resolveBrandingAutoOrigin({
    enabled: session.enabled,
    kind: session.kind,
    browserOrigin,
    routedRemoteOrigin: session.kind === "remote" ? readActiveRemoteOrigin() : "",
  });
  const autoServerBaseUrl = deriveAutoServerBaseUrl(autoOrigin, import.meta.env.BASE_URL as string);
  // 输入框下方实色展示的「当前生效地址」：已固定显示固定值；未固定显示自动识别值（可能为空）。
  const effectiveServerBaseUrl = savedServerBaseUrl || autoServerBaseUrl;
  async function copyServerBaseUrl() {
    if (!effectiveServerBaseUrl) return;
    const ok = await copyText(effectiveServerBaseUrl);
    toast(ok ? `已复制：${effectiveServerBaseUrl}` : "复制失败，请手动选中复制", ok ? "success" : "error");
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

  // 访客自主注册开关：切换即时保存（独立 mutation，不进文本 draft/textDirty），
  // 成功后 invalidate branding，登录页 bootstrap-status 下一轮即反映新有效态。
  async function toggleSignupOpen(next: boolean) {
    try {
      await setSignupOpen.mutateAsync(next);
      toast("设置已保存", "success");
    } catch (err) {
      toast(errorText(err, "保存失败，请重试"), "error");
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
              setDraft({ productName: e.target.value, copyright, serverBaseUrl })
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
              setDraft({ productName, copyright: e.target.value, serverBaseUrl })
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

        {/* c2. 服务端网址（多地址环境：内网 IP 与反代域名并存时手填外网可用地址；留空显示并使用自动识别的当前地址） */}
        <div className="flex flex-col gap-1.5 px-4 py-3">
          <div className="flex items-center gap-1.5">
            <label
              htmlFor="branding-server-base-url"
              className="text-gx-13 text-gx-text-primary"
            >
              服务端网址
            </label>
            <span className="inline-flex items-center text-gx-text-hint">
              <Icon name="globe" size={13} />
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Input
              id="branding-server-base-url"
              value={serverBaseUrl}
              maxLength={BRANDING_LIMITS.serverBaseUrlMax}
              placeholder={
                autoServerBaseUrl
                  ? `未修改，当前默认：${autoServerBaseUrl}`
                  : "留空=自动；例如 https://gouxiang.example.com"
              }
              onChange={(e) =>
                setDraft({ productName, copyright, serverBaseUrl: e.target.value })
              }
            />
            <Button
              variant="ghost"
              size="sm"
              icon="copy"
              className="shrink-0 px-2"
              disabled={!effectiveServerBaseUrl}
              title={effectiveServerBaseUrl ? "复制当前生效网址" : "暂无可复制的网址"}
              onClick={() => void copyServerBaseUrl()}
            >
              复制
            </Button>
          </div>
          {/* 当前生效地址实色展示：未手动固定时也能直接看到连接地址（戴总 0.2.5-beta 要求）。 */}
          {effectiveServerBaseUrl && (
            <div className="flex items-center gap-1.5 text-gx-11 text-gx-text-secondary">
              <Icon name="link" size={12} className="shrink-0 text-gx-text-faint" />
              <span className="min-w-0 truncate font-mono" title={effectiveServerBaseUrl}>
                {savedServerBaseUrl ? "固定网址：" : "当前默认（自动识别）："}
                {effectiveServerBaseUrl}
              </span>
            </div>
          )}
          <span className="text-gx-11 text-gx-text-hint">
            留空则按当前访问地址自动识别；当服务器同时有内网 IP 和反代域名、在内网用 IP 登录却需要把外网网址发给他人时，在此填写对外可访问的固定网址（可含端口/子路径）。仅用于展示与复制正确网址，不改监听、不做跳转。
          </span>
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

        {/* d. 访客自主注册开关（即时保存，独立于文本「保存」按钮） */}
        <div className="flex items-start justify-between gap-4 px-4 py-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-gx-13 text-gx-text-primary">
              允许访客自主注册
            </span>
            <span className="text-gx-11 text-gx-text-hint">
              开启后，未登录访客可在登录页自行注册账号（默认普通成员，由管理员分配权限）；关闭则只能由管理员邀请建号。系统首次初始化创建超管不受此开关影响。
            </span>
          </div>
          <Switch
            checked={config?.signupOpen === true}
            onChange={(v) => void toggleSignupOpen(v)}
            disabled={setSignupOpen.isPending}
            title={setSignupOpen.isPending ? "保存中…" : undefined}
          />
        </div>
      </div>
    </div>
  );
}
