// M3/S9 新建分组（nav_nodes kind=group）。group 是权威资源树节点，删除/移动走 N4/N6。
// 创建后本模态返回新 group id，由调用方在菜单层把它作为 shortcut 挂到目标容器，
// 使分组在一级导航可见（两结构桥接，与菜单容器是不同概念）。
import { useState } from "react";
import { Button, Input, Modal } from "../../../components/ui";

export function GroupCreateModal({
  open,
  busy,
  onClose,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const valid = name.trim().length > 0 && name.trim().length <= 60;
  return (
    <Modal
      open={open}
      title="新建分组"
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!valid}
            onClick={() => onCreate(name.trim())}
          >
            创建
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <label className="text-gx-12 text-gx-text-secondary">分组名称</label>
        <Input
          value={name}
          autoFocus
          maxLength={60}
          placeholder="例如：客户项目"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid) onCreate(name.trim());
          }}
        />
        <p className="text-gx-11 text-gx-text-hint">分组用于在权威资源树中组织实体；实体移入分组需确认影响面。</p>
      </div>
    </Modal>
  );
}
