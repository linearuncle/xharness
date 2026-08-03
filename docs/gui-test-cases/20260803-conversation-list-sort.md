# 对话列表按最近活动排序

## 用例

- 标准冒烟
  - 前置：隔离目录 dev GUI
  - 操作：运行 `docs/cdp-testing.md` 第 3 节快速冒烟
  - 断言：标题、基础界面、输入区、CDP 标记、IPC bridge 正常
  - 证据：返回对象

- 主成功路径：新建对话置顶
  - 前置：隔离目录，已添加一个测试项目且至少有 1 条旧对话
  - 操作：调用 `api.newConversation(projectDir)` 新建对话
  - 断言：该项目 `sidebar.conversations[0].id` 等于新建 id；DOM 中该项目下第一个 `.sb-conv` 标题为「新对话」且 active
  - 证据：sidebar JSON + DOM 顺序

- 关键边界：旧对话有新内容后上浮
  - 前置：同一项目下至少两条对话（A 较旧、B 较新）
  - 操作：对 A 调用 `api.appendBlock(A, {kind:"user", text:"x"})`（或发送消息），等待 `sidebar:update`
  - 断言：`conversations[0].id === A`，且 DOM 顺序与 sidebar 一致
  - 证据：sidebar JSON + DOM 顺序
