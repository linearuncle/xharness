# 侧栏项目文件夹点击改为折叠/展开（issue #12）

## 背景

修复前点击侧栏项目文件夹会切换项目/新建对话；修复后改为折叠/展开该项目下的会话列表
（点击会话行仍打开会话，不受影响）。折叠状态仅内存态、不持久化；无会话打开（空态）时
点击其他项目文件夹顺带切换新对话目标，保留原「在此项目开新对话」入口。

## 用例

- 标准冒烟
  - 前置：隔离目录 dev GUI（`XH_DATA_DIR=/tmp/xh-issue12`，`--remote-debugging-port=0`）
  - 操作：运行 `docs/cdp-testing.md` 第 3 节快速冒烟
  - 断言：标题、基础界面、输入区、CDP 标记、IPC bridge 正常
  - 证据：返回对象

- 主成功路径：点击项目文件夹折叠/展开对话列表
  - 前置：隔离目录已添加三个项目，项目 A 有 3 条会话、项目 B 有 1 条、C 无会话
  - 操作：CDP 里点击项目 B 的 `.sb-project` 行
  - 断言：B 行出现折叠态（chevron 无 `open` class），其 `.sb-conv` 子行从 DOM 消失，
    A 的会话行仍可见，`#es-folder` 变为 B；再点击一次恢复展开，会话行重新出现
  - 证据：折叠前后 `#sb-projects` 的 `.sb-conv` 数量与 chevron class

- 主成功路径（样式）：chevron 旋转 + 会话数徽标
  - 操作：对展开/折叠行的 `.sb-chev` 取 `getComputedStyle().transform`
  - 断言：折叠为 `none`、展开为旋转矩阵；有会话的项目显示 `.sb-count` 徽标且数值正确，
    无会话项目不显示
  - 证据：计算样式与徽标文本

- 关键边界：有会话打开时点击别的项目文件夹只折叠、不切走对话
  - 前置：打开项目 A 的一条会话（`empty-state` 含 `hidden`、`chat-scroll` 可见）
  - 操作：点击项目 B 的 `.sb-project`
  - 断言：`empty-state` 仍隐藏、当前会话仍 active；B 的会话列表折叠
  - 证据：empty-state/chat-scroll 可见性与 `.sb-conv.active` 的标题

- 回归路径：空态下点击其他项目文件夹仍可切换新对话目标
  - 前置：当前在项目 A 空态（`empty-state` 可见，`#es-folder` 为 `xh-proj-a`）
  - 操作：点击项目 B 的 `.sb-project`
  - 断言：`#es-folder` 变为 `xh-proj-b`，且 B 的会话列表同时折叠
  - 证据：`#es-folder` 文本 + B 的 chevron class

- 回归路径：折叠状态在侧栏重渲染后保持
  - 前置：项目 B 处于折叠态
  - 操作：调用 `api.newConversation("/tmp/xh-proj-b")` 触发 sidebar 重渲染
  - 断言：B 仍折叠，新会话行不可见
  - 证据：重渲染后 B 的 chevron class 与 `.sb-conv` 数量

- 注意：空态点击会触发 `selectProject`（内部 `await refreshContext` 后异步重渲染），
  断言前需等待约 200ms；纯折叠/展开路径是同步重渲染。

## 结果

- 代码级检查：`npm test` 247/247 通过；本次仅改 `gui/renderer/`，无需 `npm run build`
- 标准冒烟：通过（标题/侧栏/输入区/CDP 标记/bridge）
- 专项：5 组断言全部通过（初始态、折叠/展开、样式与徽标、有会话不切走、空态切换、
  重渲染保持）
- 数据影响：仅写入隔离目录 `/tmp/xh-issue12`（含一条测试用新会话），未触碰真实数据
