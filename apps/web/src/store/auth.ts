// apps/web/src/store/auth.ts
// 鉴权状态管理（轻量 Zustand）+ localStorage 持久化

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { UserDTO } from "@gx/shared-types";

interface AuthState {
  token: string | null;
  user: UserDTO | null;
  setAuth: (token: string, user: UserDTO) => void;
  /** 局部更新 user 字段（个人中心保存后回调） */
  updateUser: (patch: Partial<UserDTO>) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setAuth: (token, user) => set({ token, user }),
      updateUser: (patch) =>
        set((s) => (s.user ? { user: { ...s.user, ...patch } } : s)),
      logout: () => set({ token: null, user: null }),
    }),
    { name: "gx-auth" },
  ),
);