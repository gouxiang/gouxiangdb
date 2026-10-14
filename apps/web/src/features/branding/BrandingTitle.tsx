// 浏览器标题动态化（0.2.4-rc）：无 UI 组件，挂在 Routes 之外（App.tsx），
// 产品名一变化（含探针从默认占位更新为后台自定义值）即同步 document.title。
//
// index.html 里的静态 <title>构想工作台</title> 保留：首屏 / JS 失败 / 探针未完成时
// 它仍是兜底文案；挂载后由本组件覆盖为当前产品名（产品名即标题，不加后缀）。

import { useEffect } from "react";
import { useProductName } from "./useBranding";

export function BrandingTitle() {
  const productName = useProductName();
  useEffect(() => {
    document.title = productName;
  }, [productName]);
  return null;
}
