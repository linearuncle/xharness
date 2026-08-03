# 新对话默认模型 = 最近一次选择

## 用例

- 标准冒烟
  - 前置：隔离目录 dev GUI（`dev-gui.mjs --data-dir`）
  - 操作：运行 `docs/cdp-testing.md` 第 3 节快速冒烟
  - 断言：标题、基础界面、输入区、CDP 标记、IPC bridge 正常
  - 证据：返回对象

- 主成功路径：会话内切 grok-4.5 后新对话默认 grok-4.5
  - 前置：隔离目录（load() 自动种子 deepseek + grok 两供应商，均 enabled）
  - 操作：① 新建会话 A；② `api.setModelChoice(A.id, project, "grok", "grok-4.5")`；
    ③ `api.newConversation(project)` 并 `api.openConversation(B.id)`
  - 断言：`openConversation(B).meta.providerId === "grok"` 且 `meta.model === "grok-4.5"`、
    `meta.effort === "high"`；`api.getState().general.lastChoice` 同值
  - 证据：meta JSON + lastChoice JSON

- 关键边界：重启 GUI 后 lastChoice 仍生效（持久化到 settings.jsonl）
  - 前置：上一用例已完成（lastChoice = grok/grok-4.5/high）
  - 操作：`dev-gui.mjs restart --data-dir ...` 后 `api.getState()` 与新建会话
  - 断言：`getState().general.lastChoice` 仍为 grok/grok-4.5/high；新会话 meta 同值
  - 证据：重启前后 lastChoice JSON

- 关键边界：供应商被禁用后回落安装默认
  - 前置：lastChoice = grok/grok-4.5
  - 操作：`api.upsertProvider({...grok, enabled:false})` 后新建会话并 open
  - 断言：新会话 meta.model === "deepseek-v4-flash"（grok 不可用回落）
  - 证据：meta JSON
