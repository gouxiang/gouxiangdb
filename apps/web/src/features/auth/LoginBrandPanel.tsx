// 登录 / 强制改密页共用的品牌广告左栏（#753 双栏改版）。
//
// 版式纪律：
//   - 桌面（md≥768）：品牌蓝区，广告图满版 object-cover，顶部「定位小字 + 大产品名 +
//     一句话标语」与底部版权行以页面元素叠加（不烧死在图里，换名/换图互不影响）；
//   - 窄屏（<768）：整栏 hidden——单栏形态只保留右侧表单，不挤占手机宽度；
//   - 自定义上传图可能是浅底图：上下两道品牌色渐变保证白色文字在任何图上都可读；
//   - 颜色只用 gx-* 令牌（白字沿用全站 text-white 惯例，= #fff 豁免色）。

import { useHeroUrl, useProductName } from "../branding/useBranding";
import { Copyright } from "../branding/Copyright";

/**
 * @param slogan 产品一句话标语（具体卖点，非模板口号）。
 */
export function LoginBrandPanel({ slogan }: { slogan: string }) {
  const productName = useProductName();
  const heroUrl = useHeroUrl();

  return (
    <div
      data-testid="login-brand-panel"
      className="relative hidden overflow-hidden bg-gx-accent md:flex md:min-h-[560px] md:flex-col md:justify-between md:p-9"
    >
      {/* 广告图：后台配置了用上传图，否则内置 public/branding/login-hero.png */}
      <img
        src={heroUrl}
        alt=""
        aria-hidden="true"
        className="absolute inset-0 h-full w-full object-cover"
      />
      {/* 上下压暗、中部露出插画：保证顶/底白字在任意自定义图上可读 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-gx-accent/90 via-transparent to-gx-accent/90"
      />

      <div className="relative">
        <p className="text-gx-12 font-medium tracking-[0.08em] text-white/75">
          私有部署 · 数据自主
        </p>
        <h2 className="mt-3 text-gx-24 font-semibold leading-tight text-white">
          {productName}
        </h2>
        <p className="mt-2 max-w-[28ch] text-gx-13 leading-6 text-white/85">
          {slogan}
        </p>
      </div>

      {/* 后台未配置版权串时 Copyright 自身渲染 null，不留空行 */}
      <Copyright className="relative text-gx-11 leading-5 text-white/70" />
    </div>
  );
}
