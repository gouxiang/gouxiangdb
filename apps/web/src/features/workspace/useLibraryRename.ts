// L1 行尾「…」菜单里「重命名」的实现（壳层专用）。
//
// 为什么是 hook 而不是 hook 里的 mutation：
//   · 现有的 useUpdateKb 要先把 kbId 传进去，而 L1 的行是运行时才知道改哪一个，
//     无法在壳层为每个库预先建一条 mutation；
//   · PrimaryNav 内不能 useQuery / useMutation（多份 SSR 回归不带 QueryClientProvider），
//     所以实现放在壳层这侧的 hook 里，再以回调 prop 注入。
// 走 client 方法 + 手动失效列表缓存：库的改名接口在 Bases.update，知识库在 KbApi.update，
// 两者都是 PATCH { name }，失败抛错由调用方（重命名弹窗）统一 toast。

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { QK } from "../../api/hooks";
import { Bases, KbApi } from "../../api/client";
import { toast } from "../../components/ui";

export type LibraryRename = (kind: "base" | "kb", id: string, name: string) => Promise<void>;

export function useLibraryRename(): LibraryRename {
  const qc = useQueryClient();
  return useCallback<LibraryRename>(
    async (kind, id, name) => {
      if (kind === "base") {
        await Bases.update(id, { name });
        await qc.invalidateQueries({ queryKey: QK.bases });
      } else {
        await KbApi.update(id, { name });
        // kb-hooks 的 QK 前缀就是 ["kb"]：一次失效覆盖 list 与该库详情
        await qc.invalidateQueries({ queryKey: ["kb"] });
      }
      toast("已重命名", "success");
    },
    [qc],
  );
}
