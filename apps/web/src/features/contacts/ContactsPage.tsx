// M2/S7 工作区通讯录页：/workspace/contacts 的路由壳。
//
// P2-B2：可视主体（部门树 / 成员 / 角色）已抽到 ContactsDirectory，工作区设置页内嵌同一组件，
// 两端共用一套口径；本文件只保留路由占位，不再重复实现任何列表逻辑。

import { ContactsDirectory } from "./ContactsDirectory";

export default function ContactsPage() {
  return <ContactsDirectory />;
}
