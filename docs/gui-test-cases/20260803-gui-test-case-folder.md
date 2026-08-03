# GUI 测试用例目录说明

## 用例

- 标准冒烟
  - 前置：隔离数据目录 `.xhtest-test-case-folder`，dev GUI，自动 CDP 端口。
  - 操作：运行 `docs/cdp-testing.md` 第 3 节快速冒烟。
  - 断言：标题为 `xharness`，侧栏、输入框、发送按钮、CDP 标记和 IPC bridge 正常。
  - 证据：CDP 返回对象。

- 主成功路径
  - 前置：文档变更已写入 `docs/gui-test-cases/README.md`。
  - 操作：检查 `docs/cdp-testing.md` 是否指向 `docs/gui-test-cases/`，并说明隔离目录可从 `DEEPSEEK_API_KEY` 预置真实 DeepSeek key。
  - 断言：完成门禁和需求专项两处都要求先在该目录写测试用例；隔离流程说明 GUI 仍读设置文件，不在运行时读环境变量。
  - 证据：`rg` 命中结果。

- 关键边界
  - 前置：本次只增加测试用例说明，不改变 GUI 代码。
  - 操作：检查文档代码块语法、空白格式，并用假 key 在临时目录验证 settings 预置示例能生成 JSONL。
  - 断言：`bash -n`、`git diff --check` 和 JSONL 解析通过。
  - 证据：命令退出码。
