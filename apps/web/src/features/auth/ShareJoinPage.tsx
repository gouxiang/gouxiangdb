// apps/web/src/features/auth/ShareJoinPage.tsx
// 通过分享链接加入 Base（路由 /join/:token）
// 进入即调用 Bases.joinByToken；成功跳转，失败提示去登录

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Bases, ApiError } from "../../api/client";
import { useAuthStore } from "../../store/auth";
import { Button, Spinner } from "../../components/ui";

interface JoinResult {
  baseId: string;
  role: string;
  alreadyMember: boolean;
}

export default function ShareJoinPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const loggedIn = useAuthStore((s) => !!s.token);

  const [state, setState] = useState<"loading" | "ok" | "err">("loading");
  const [result, setResult] = useState<JoinResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setState("err");
      setError("缺少邀请令牌");
      return;
    }
    let alive = true;
    Bases.joinByToken(token)
      .then((r) => {
        if (!alive) return;
        setResult({ baseId: r.baseId, role: r.role, alreadyMember: r.alreadyMember });
        setState("ok");
      })
      .catch((e) => {
        if (!alive) return;
        const msg = e instanceof ApiError ? e.message : "加入失败，链接可能已过期";
        setError(msg);
        setState("err");
      });
    return () => {
      alive = false;
    };
  }, [token]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gx-bg px-4">
      <div className="w-[360px] rounded-gx-xl bg-gx-surface p-6 text-center shadow-lg">
        {state === "loading" && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Spinner size={22} />
            <div className="text-gx-13 text-gx-text-tertiary">正在加入 Base…</div>
          </div>
        )}

        {state === "ok" && result && (
          <div className="flex flex-col items-center gap-4 py-2">
            <div className="text-gx-16 font-semibold text-gx-text-primary">已加入 Base</div>
            <div className="text-gx-13 text-gx-text-tertiary">
              {result.alreadyMember ? "你已是该 Base 的成员" : "欢迎加入，现在可以开始使用了"}
            </div>
            <Button variant="primary" block onClick={() => navigate(`/base/${result.baseId}`)}>
              进入 Base
            </Button>
          </div>
        )}

        {state === "err" && (
          <div className="flex flex-col items-center gap-4 py-2">
            <div className="text-gx-16 font-semibold text-gx-text-primary">无法加入</div>
            <div className="text-gx-13 text-gx-text-tertiary">{error || "链接无效或已过期"}</div>
            <Button
              variant="primary"
              block
              onClick={() => navigate(loggedIn ? "/" : "/login")}
            >
              {loggedIn ? "返回首页" : "去登录"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
