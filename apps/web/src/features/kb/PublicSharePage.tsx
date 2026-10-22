// apps/web/src/features/kb/PublicSharePage.tsx
// 公开分享页（/s/:token、/s/:token/doc/:docId、/s/:token/t/:tableId）外壳：匿名可访问，
// 无需登录。按对象族 kind 分发到三个分支：
//   - 文档 / 画布（历史 kb_doc，后端 kind:"doc" 或缺省）→ PublicDocShare（保留可编辑能力）；
//   - 数据表（kind:"table"）→ PublicSharedTable 只读网格（直连表 token，支持分页）；
//   - 库 base（kind:"base"）→ PublicBaseShell 外壳落地页，点表卡片进 /s/:token/t/:tableId。
//
// 库作用域表路由（:tableId 存在）不再读分享根，直接按 base token + tableId 拉单表只读网格。
// 正文是否可编辑仍由文档分支各读取接口的真实 canEdit 决定（fail-closed），见 PublicDocShare。

import { useParams, useNavigate } from "react-router-dom";
import { Icon } from "../../components/icons";
import { Spinner } from "../../components/ui";
import { useProductName } from "../branding/useBranding";
import { usePublicShareAny } from "./kb-hooks";
import { isDocShare, isTableShare, isBaseShare } from "./public-share-model";
import { PublicDocShare } from "./PublicDocShare";
import { PublicSharedTable } from "./PublicSharedTable";
import { PublicBaseShell } from "./PublicBaseShell";

export default function PublicSharePage() {
  const { token, docId: routeDocId, tableId } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = usePublicShareAny(token);
  // 匿名页同样在 QueryClientProvider 内，品牌探针公开可读
  const productName = useProductName();

  // 库作用域单表：/s/:baseToken/t/:tableId —— 直接渲染只读网格（access=base）。
  if (tableId && token) {
    return (
      <PublicSharedTable
        access={{ kind: "base", baseToken: token, tableId }}
        onBack={() => navigate(`/s/${token}`)}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gx-bg">
        <Spinner size={22} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-gx-bg text-center">
        <Icon name="link" size={32} className="text-gx-text-hint" />
        <div className="text-gx-15 font-semibold text-gx-text-primary">分享链接已失效或被取消</div>
        <div className="text-gx-13 text-gx-text-tertiary">该链接可能已被分享者关闭，或内容已被删除。</div>
        <button
          type="button"
          onClick={() => navigate("/login")}
          className="mt-2 rounded-gx-lg bg-gx-accent px-4 py-2 text-gx-13 font-medium text-white hover:brightness-95"
        >
          返回{productName}
        </button>
      </div>
    );
  }

  // 数据表（直连表 token）：只读网格。
  if (isTableShare(data)) {
    return <PublicSharedTable access={{ kind: "token", tableToken: token! }} />;
  }

  // 库外壳：库信息 + 可点进去看的已分享表卡片。
  if (isBaseShare(data)) {
    return (
      <PublicBaseShell
        share={data}
        isLoading={false}
        isError={false}
        onOpenTable={(tid) => navigate(`/s/${token}/t/${tid}`)}
      />
    );
  }

  // 文档 / 画布（缺省族，兼容无 kind 的历史响应）。
  if (isDocShare(data)) {
    return <PublicDocShare token={token} data={data} routeDocId={routeDocId} />;
  }

  // 未知响应形态：fail-closed 按失效处理，不猜测渲染。
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-gx-bg text-center">
      <Icon name="link" size={32} className="text-gx-text-hint" />
      <div className="text-gx-15 font-semibold text-gx-text-primary">分享链接已失效或被取消</div>
      <button
        type="button"
        onClick={() => navigate("/login")}
        className="mt-2 rounded-gx-lg bg-gx-accent px-4 py-2 text-gx-13 font-medium text-white hover:brightness-95"
      >
        返回{productName}
      </button>
    </div>
  );
}
