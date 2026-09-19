// M6-FE 新建令牌表单：名称 + 有效期下拉（30/90/365/永不过期，默认 90，C-3）。
//
// P3 变更：**移除权限范围勾选区**。令牌现在只做「认证 + 有效期」，能干什么一律按签发者账号
// 实时计算（与 Web 端 X-GX-Token 会话同口径）——再让用户在表单里勾六位 scope，等于给了一个
// 不生效的控件（点了不改变任何实际能力），属于典型假开关。
// 「永不过期」的强警示二次确认由父组件在 onSubmit 前完成（本组件只产出 chooseExpiry 结果）。
// 纯展示 + 本地受控状态，无副作用；SSR 可断言默认有效期与「无勾选区」。
import { useState } from "react";
import { Button, Input, Select } from "../../components/ui";
import type { CreatePatInput } from "../../api/client";
import {
  PAT_DEFAULT_EXPIRY_VALUE,
  PAT_EXPIRY_OPTIONS,
  PAT_SCOPE_INHERIT_HINT,
  PAT_SCOPE_INHERIT_TITLE,
  canSubmitCreate,
  parseExpiryValue,
} from "./pat-labels";

export function CreatePatForm({
  onCreate,
  busy = false,
}: {
  onCreate: (input: CreatePatInput) => void;
  busy?: boolean;
}) {
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<string>(PAT_DEFAULT_EXPIRY_VALUE);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (!canSubmitCreate(name)) {
      const trimmed = name.trim();
      setError(
        trimmed.length === 0
          ? "请填写令牌名称"
          : "令牌名称不超过 60 个字符",
      );
      return;
    }
    setError(null);
    // 不再提交 scopes：能力跟随签发者账号（后端缺省写全集，判定不看它）。
    onCreate({ name: name.trim(), expiresInDays: parseExpiryValue(expiry) });
  }

  return (
    <form
      className="flex flex-col gap-4 rounded-gx-lg border border-gx-separator p-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1">
          <span className="text-gx-12 text-gx-text-tertiary">名称</span>
          <Input
            value={name}
            maxLength={60}
            placeholder="例如：数据同步脚本"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <span className="text-gx-11 text-gx-text-hint">用于在列表中辨识，最多 60 个字符。</span>
      </div>

      <div className="flex flex-col gap-1">
        <label className="flex flex-col gap-1">
          <span className="text-gx-12 text-gx-text-tertiary">有效期</span>
          <Select
            value={expiry}
            options={PAT_EXPIRY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(e) => setExpiry(e.target.value)}
            className="w-40"
          />
        </label>
        <span className="text-gx-11 text-gx-text-hint">
          到期后令牌自动失效；想提前失效请直接吊销。
        </span>
      </div>

      <div className="flex flex-col gap-1 rounded-gx-lg bg-gx-bg px-3 py-2">
        <span className="text-gx-12 text-gx-text-secondary">{PAT_SCOPE_INHERIT_TITLE}</span>
        <span className="text-gx-11 text-gx-text-hint">{PAT_SCOPE_INHERIT_HINT}</span>
      </div>

      {error && <span className="text-gx-12 text-gx-danger">{error}</span>}

      <div className="flex justify-end">
        <Button type="submit" variant="primary" size="sm" loading={busy}>
          签发令牌
        </Button>
      </div>
    </form>
  );
}
