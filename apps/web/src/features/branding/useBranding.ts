// 品牌外观 TanStack Query hooks（0.2.4-rc）。
//
// 缓存纪律（全站即时生效的关键）：
//   匿名读（useBranding）与管理员读（useBrandingAdmin）共用同一个缓存键 QK.branding，
//   管理员的改名/上传/恢复成功后统一 invalidate 该键，登录页/顶栏/公开分享页等所有
//   匿名读组件下一轮渲染即拿到新配置，不需要刷新页面。
//
// 公开探针（GET /api/auth/branding）后端 fail-closed 永返默认 DTO、永不 401：
//   - retry: 0：探针失败不该重试拖慢登录页首屏；
//   - placeholderData: DEFAULT_BRANDING：data 在任何时刻都有完整形状，消费方无需判空；
//   - staleTime 60s：与后端 60s 服务端缓存对齐。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Branding, withBase } from "../../api/client";
import { QK } from "../../api/hooks";
import type { BrandingConfigDTO, BrandingUpdateInput } from "@gx/shared-types";
import { DEFAULT_BRANDING, renderCopyright } from "./branding-text";

/**
 * 内置默认登录广告图（apps/web/public/branding/login-hero.png）。
 * public 资源直接按 Vite BASE_URL 拼（根部署 "/branding/login-hero.png"，
 * 子路径 "/app/gouxiangdb/branding/login-hero.png"），与 favicon 的 %BASE_URL%
 * 用法同源，不过 withBase——BASE_URL 本身就是子路径前缀。
 */
const DEFAULT_HERO_URL = `${import.meta.env.BASE_URL}branding/login-hero.png`;

/** 匿名读品牌配置；data 永为完整 DTO（失败/加载中为 DEFAULT_BRANDING）。 */
export function useBranding() {
  return useQuery({
    queryKey: QK.branding,
    queryFn: () => Branding.publicConfig(),
    staleTime: 60_000,
    retry: 0,
    placeholderData: DEFAULT_BRANDING,
  });
}

/** 取品牌配置，data 永不为空（类型与运行时双兜底：placeholderData + ?? DEFAULT_BRANDING）。 */
function useBrandingData(): BrandingConfigDTO {
  return useBranding().data ?? DEFAULT_BRANDING;
}

/** 当前产品名（永不为空：后端回退默认名，前端再以 DEFAULT_BRANDING 兜底）。 */
export function useProductName(): string {
  return useBrandingData().productName;
}

/** 渲染后的版权串；空串表示不展示版权行。 */
export function useCopyright(): string {
  return renderCopyright(useBrandingData().copyright);
}

/** 登录广告图地址：自定义图过 withBase 兼容子路径；null 用内置默认图。 */
export function useHeroUrl(): string {
  const heroUrl = useBrandingData().heroUrl;
  return heroUrl ? withBase(heroUrl) : DEFAULT_HERO_URL;
}

/**
 * 管理员品牌配置读写（设置页「品牌外观」分区用，#754）。
 *
 * @param enabled 调用方按「是否超管/管理员」门控；非管理员不发起管理员请求
 *                （后端虽也会 403，但前端 fail-closed 不暴露探针）。
 */
export function useBrandingAdmin({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();

  // 与公开读共用 QK.branding：同一份缓存，管理员页看到的就是全站正在展示的配置。
  const configQuery = useQuery({
    queryKey: QK.branding,
    queryFn: () => Branding.adminConfig(),
    enabled,
    staleTime: 60_000,
    retry: 0,
    placeholderData: DEFAULT_BRANDING,
  });

  const invalidateBranding = () =>
    queryClient.invalidateQueries({ queryKey: QK.branding });

  const updateBranding = useMutation({
    mutationFn: (data: BrandingUpdateInput) => Branding.update(data),
    onSuccess: invalidateBranding,
  });
  const uploadHero = useMutation({
    mutationFn: (file: File) => Branding.uploadHero(file),
    onSuccess: invalidateBranding,
  });
  const resetHero = useMutation({
    mutationFn: () => Branding.resetHero(),
    onSuccess: invalidateBranding,
  });

  return { configQuery, updateBranding, uploadHero, resetHero };
}

/** 默认图地址导出给非 hook 场景（测试/后续 #753 登录页改版）复用，避免拼法散落。 */
export { DEFAULT_HERO_URL };

/** 类型再导出，消费方不必再翻 shared-types 找形状。 */
export type { BrandingConfigDTO, BrandingUpdateInput };
