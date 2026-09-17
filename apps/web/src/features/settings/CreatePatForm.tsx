// M6-FE 新建令牌表单：名称 + scope 六勾选（默认仅只读三档，canvas:write 默认不勾，C-2）
//                + 有效期下拉（30/90/365/永不过期，默认 90，C-3）。
// 「永不过期」的强警示二次确认由父组件在 onSubmit 前完成（本组件只产出 chooseExpiry 结果）。
// 纯展示 + 本地受控状态，无副作用；SSR 可断言默认勾选与默认有效期。
import { useState } from "react";
import { Button, Checkbox, Input, Select } from "../../components/ui";
import type { CreatePatInput, PatScope } from "../../api/client";
import {
  PAT_DEFAULT_EXPIRY_VALUE,
  PAT_EXPIRY_OPTIONS,
  PAT_SCOPE_GROUPS,
  PAT_SCOPE_META,
  canSubmitCreate,
  orderScopes,
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
  const [scopes, setScopes] = useState<PatScope[]>([
    "record:read",
    "doc:read",
    "canvas:read",
  ]);
  const [expiry, setExpiry] = useState<string>(PAT_DEFAULT_EXPIRY_VALUE);
  const [error, setError] = useState<string | null>(null);

  function toggle(scope: PatScope, on: boolean) {
    setScopes((prev) => (on ? orderScopes([...prev, scope]) : prev.filter((s) => s !== scope)));
  }

  function submit() {
    if (!canSubmitCreate(name, scopes)) {
      const trimmed = name.trim();
      setError(
        trimmed.length === 0
          ? "请填写令牌名称"
          : trimmed.length > 60
            ? "令牌名称不超过 60 个字符"
            : "请至少选择一个权限范围",
      );
      return;
    }
    setError(null);
    onCreate({
      name: name.trim(),
      scopes: orderScopes(scopes),
      expiresInDays: parseExpiryValue(expiry),
    });
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

      <div className="flex flex-col gap-2">
        <span className="text-gx-12 text-gx-text-tertiary">权限范围</span>
        <div className="flex flex-col gap-3">
          {PAT_SCOPE_GROUPS.map((group) => (
            <div key={group} className="flex flex-col gap-1.5">
              <span className="text-gx-11 font-medium uppercase tracking-wide text-gx-text-hint">
                {group}
              </span>
              <div className="flex flex-wrap gap-x-6 gap-y-1.5">
                {PAT_SCOPE_META.filter((m) => m.group === group).map((m) => (
                  <Checkbox
                    key={m.value}
                    checked={scopes.includes(m.value)}
                    label={m.label}
                    onChange={(v) => toggle(m.value, v)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <span className="text-gx-11 text-gx-text-hint">
          默认仅授予只读权限；写权限请按需开启，遵循最小权限原则。
        </span>
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
