// v6 S3 顶栏面包屑：由当前路由 + 已就绪的实体名派生面包屑段（底板 .crumb，shared.css 192-195）。
//
// 与 route-container 同一纪律：
//   - 纯函数，不碰 react-router / react-query，SSR 单测可直接值断言；
//   - 名字未就绪不硬凑：库首页返回 []（顶栏左段整段不渲染，避免先闪出 id/错名再跳正名，
//     与 deriveScopeContainer「列表未就绪先不渲染」同口径）；
//   - 子资源（表 / 文档）标题缺失有文案兜底（"数据表" / "文档" / "画布"），
//     第二段不阻塞渲染——第一段库名是整条链的锚点，它缺失时整链才不输出；
//   - 任何分支都不得输出 undefined / 空串段。

export interface CrumbSeg {
  label: string;
  /** 有值则该段渲染为可点链接（回库首页）；末段永不带 to。 */
  to?: string;
}

export interface DeriveCrumbInput {
  pathname: string;
  /** 当前 base 库名（列表未就绪时为 null/undefined）。 */
  baseName?: string | null;
  /** 当前 kb 库名（列表未就绪时为 null/undefined）。 */
  kbName?: string | null;
  /** 当前表名（表/视图路由用；未就绪时以 "数据表" 兜底）。 */
  tableName?: string | null;
  /** 当前文档/画布标题（未就绪时按类型兜底）。 */
  docTitle?: string | null;
}

/** 工作区级固定页（R-N：不依赖任何库上下文，名单与 nav-footer 文案一致）。 */
const WORKSPACE_FIXED: Readonly<Record<string, string>> = {
  contacts: "通讯录",
  authz: "权限管理",
  settings: "工作区设置",
};

/** 去掉尾斜杠后按 "/" 切段（pathname 以 / 开头，首元素恒为 ""）。 */
function segments(pathname: string): string[] {
  const p = pathname.replace(/\/+$/, "");
  return p === "" ? [""] : p.split("/");
}

function nonEmpty(s: string | null | undefined): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

export function deriveCrumb(input: DeriveCrumbInput): CrumbSeg[] {
  const seg = segments(input.pathname);
  // seg: ["", "workspace", "contacts"] / ["", "base", ":id", "table", ":tid", ...]
  const root = seg[1];

  // —— 工作区级固定页 ——
  if (root === "workspace") {
    const label = WORKSPACE_FIXED[seg[2] ?? ""];
    // 设置分区子页（/workspace/settings/general…）不追加第二段，整条就是「工作区设置」。
    return label ? [{ label }] : [];
  }
  if (root === "help") {
    return [{ label: "帮助中心" }];
  }

  // —— 智能数据库 ——
  if (root === "base") {
    const id = seg[2];
    if (!id) return [];
    const name = nonEmpty(input.baseName) ? input.baseName : null;
    const sub = seg[3];
    // 库首页：名字未就绪整体不渲染（防错名闪跳）。
    if (!sub) return name ? [{ label: name }] : [];
    // 以下子页第一段都是「库名 → 回库」；库名未就绪同样整链不输出。
    if (!name) return [];
    const home = `/base/${id}`;
    switch (sub) {
      case "settings":
        return [{ label: name, to: home }, { label: "库设置" }];
      case "trash":
        return [{ label: name, to: home }, { label: "回收站" }];
      case "erd":
        return [{ label: name, to: home }, { label: "数据库关系图" }];
      case "table": {
        // /base/:id/table/:tid（含 /view/:vid 等更深子路由，视图不另起第三段）。
        if (!seg[4]) return [];
        return [
          { label: name, to: home },
          { label: nonEmpty(input.tableName) ? input.tableName : "数据表" },
        ];
      }
      default:
        // 未识别的 base 子路由：只兜底库名一段，不编造二段。
        return [{ label: name }];
    }
  }

  // —— 知识库 ——
  if (root === "kb") {
    const id = seg[2];
    if (!id) return [];
    const name = nonEmpty(input.kbName) ? input.kbName : null;
    const sub = seg[3];
    if (!sub) return name ? [{ label: name }] : [];
    if (!name) return [];
    const home = `/kb/${id}`;
    switch (sub) {
      case "settings":
        return [{ label: name, to: home }, { label: "知识库设置" }];
      case "trash":
        return [{ label: name, to: home }, { label: "回收站" }];
      case "doc":
      case "canvas": {
        if (!seg[4]) return [];
        const fallback = sub === "canvas" ? "画布" : "文档";
        return [
          { label: name, to: home },
          { label: nonEmpty(input.docTitle) ? input.docTitle : fallback },
        ];
      }
      default:
        return [{ label: name }];
    }
  }

  return [];
}
