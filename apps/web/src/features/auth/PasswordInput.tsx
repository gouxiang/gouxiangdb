// 密码输入框：在通用 Input 右侧内嵌「显隐密码」切换（#753）。
//
// 为什么自建而不给 Input 加通用后缀槽：登录/改密两页是当前仅有的两个消费点，
// 通用槽位会扩大 ui.tsx 的 API 面；等第三个使用场景出现再上提。
//
// 可访问性：按钮带 aria-label 与 aria-pressed；图标 aria-hidden，纯装饰。

import { useState, type InputHTMLAttributes } from "react";
import { Input } from "../../components/ui";
import { Icon } from "../../components/icons";

export type PasswordInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type"
>;

export function PasswordInput(props: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        // 给右侧眼睛按钮留出内边距，输入内容不被遮挡
        className="pr-9"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "隐藏密码" : "显示密码"}
        aria-pressed={visible}
        className="absolute inset-y-0 right-1 flex w-7 items-center justify-center rounded-gx-sm text-gx-text-hint transition-colors duration-[120ms] hover:text-gx-text-secondary focus-visible:text-gx-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gx-accent/50"
      >
        <Icon name={visible ? "eyeOff" : "eye"} size={16} />
      </button>
    </div>
  );
}
