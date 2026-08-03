# GUI 需求完成后的 CDP 验证指南

这是一份给 AI 执行的 GUI 验证最小闭环。目标是高效证明三件事：基础界面和输入区没坏、
本次需求真的生效、关键边界被覆盖，并留下可核对结果。

GUI 测试默认使用 dev 实例，不要求每次打包。CDP 由 `gui/scripts/cdp-eval.mjs` 驱动，
可以直接检查 DOM、触发交互和调用 preload 暴露的 `api`。

默认尽量使用真实数据目录测试，以覆盖真实项目、会话和设置组合。只有多 worktree 并发、
首启、破坏性场景，或需要避免污染真实数据时，才使用第 4 节隔离目录。

## 1. 完成门禁

宣布 GUI 需求完成前，按这个顺序走：

1. 先在 `docs/gui-test-cases/` 写测试用例：列出标准冒烟、主成功路径、一个关键边界或回归路径。
2. 跑代码级检查：按改动范围选择 `npm test`、`npx tsc --noEmit` 等。
3. 按需 build：只有改到 `src/`、`dist/` 依赖路径或 GUI 引擎依赖时，才必须在根目录执行
   `npm run build`。纯 `gui/renderer/`、样式、文档改动可以跳过，并在报告里说明。
4. 重启 GUI dev 实例，不能复用改动前的旧进程。
5. 跑第 3 节快速标准冒烟。
6. 按测试用例跑本次需求专项验证。
7. 报告测试用例、命令、断言结果、数据影响和未覆盖项。

检查失败后，修复代码，更新测试用例，再从需要的最早步骤重跑。不能用“能打开”“肉眼看着正常”替代断言结果。

## 2. 启动与连接

单实例测试从仓库根目录执行：

```bash
# 仅当本次改动涉及 src/ 或 dist 依赖时执行
npm run build

pkill -f "MacOS/xharness"
npm --prefix gui start -- --remote-debugging-port=9223
```

`pkill -f "MacOS/xharness"` 只允许在确认没有其他 worktree 或用户实例并行运行时使用。并发时必须走第 4 节隔离流程。

在另一个终端确认连接：

```bash
node gui/scripts/cdp-eval.mjs --list
node gui/scripts/cdp-eval.mjs 'document.title'
```

成功标准：`--list` 能看到当前仓库的 `file://.../gui/renderer/index.html` page，标题为
`xharness`。固定端口可能误连旧实例，所以必须看 page URL。

## 3. 快速标准冒烟

标准冒烟只做公共底线检查，必须快，不打开设置页，不写数据，不发送 API 请求。更细的设置、IPC、持久化、主题检查放到第 5 节按需执行。

从仓库根目录执行：

```bash
node gui/scripts/cdp-eval.mjs '
(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const result = {
    title: document.title,
    sidebar: !!document.querySelector("#sidebar"),
    input: !!document.querySelector("#composer textarea#input"),
    send: !!document.querySelector("#btn-send"),
    debug: document.querySelector("#debug-badge")?.textContent.trim(),
    bridge: typeof api?.getState === "function",
  };
  assert(result.title === "xharness", `标题异常: ${result.title}`);
  assert(result.sidebar && result.input && result.send, "基础界面或输入区缺失");
  assert(result.bridge, "IPC bridge 未就绪");
  assert(/^CDP:(9223|auto)$/.test(result.debug || ""), `CDP 标记异常: ${result.debug}`);
  return result;
})()
'
```

退出码为 `0` 且返回对象符合断言即可。若本次需求正好改了这些基础节点，需要同步更新断言，不能直接跳过标准冒烟。

## 4. 多 worktree 并发隔离

多个 agent 或 worktree 同时测试时，不能共享 9223 和真实数据目录。每个 worktree 用唯一 `.xhtest-*` 目录和自动端口：

```bash
TEST_DATA_DIR="$PWD/.xhtest-agent-name"
mkdir -p "$TEST_DATA_DIR"
XH_DATA_DIR="$TEST_DATA_DIR" npm --prefix gui start -- --remote-debugging-port=0 \
  > "$TEST_DATA_DIR/cdp.log" 2>&1
```

连接隔离实例时追加 `--data-dir`：

```bash
TEST_DATA_DIR="$PWD/.xhtest-agent-name"
node gui/scripts/cdp-eval.mjs --data-dir "$TEST_DATA_DIR" --list
node gui/scripts/cdp-eval.mjs --data-dir "$TEST_DATA_DIR" 'document.title'
```

隔离目录默认没有供应商 key。若专项测试需要真实模型调用，建议从环境变量预置 DeepSeek key
到隔离目录的 `settings.jsonl`，再启动 GUI。GUI 仍只读取设置文件，不在运行时读取环境变量：

```bash
TEST_DATA_DIR="$PWD/.xhtest-agent-name"
TEST_DATA_DIR="$TEST_DATA_DIR" DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" node -e '
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.env.TEST_DATA_DIR;
const key = process.env.DEEPSEEK_API_KEY;
if (!dir) throw new Error("TEST_DATA_DIR is required");
if (!key) throw new Error("DEEPSEEK_API_KEY is required");
mkdirSync(dir, { recursive: true });
const provider = {
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com/anthropic",
  apiFormat: "anthropic",
  apiKey: key,
  enabled: true,
  builtin: true,
  models: [
    { id: "deepseek-v4-flash", contextWindow: 1000000 },
    { id: "deepseek-v4-pro", contextWindow: 1000000 }
  ]
};
writeFileSync(join(dir, "settings.jsonl"), JSON.stringify({ op: "upsert", provider, ts: Date.now() }) + "\n", { mode: 0o600 });
'
```

并发场景禁止执行宽泛 `pkill -f "MacOS/xharness"`。只结束当前 worktree 实例时，用：

```bash
pkill -f "$PWD/gui/node_modules/electron/dist/xharness.app"
```

## 5. 需求专项

标准冒烟不证明需求完成。执行前先在 `docs/gui-test-cases/` 写测试用例，每条用例写清楚：

- 名称、前置、操作、断言、证据。
- 至少覆盖主成功路径，以及一个关键边界或回归路径。

按改动选择最少但有效的专项检查：

| 改动 | 必测重点 |
| --- | --- |
| UI 元素、文本、菜单、弹层 | 真实点击/输入后断言最终 DOM 和可见状态 |
| 设置、主题、侧栏透明效果 | 打开对应页面，断言关键样式；涉及持久化时重启后再读 |
| IPC 或供应商状态 | 调用 `api`，断言返回结构；密钥只能看 `hasKey`，不得泄露明文 |
| 会话、项目、JSONL 持久化 | 记录原值，执行修改，重启后验证；需要时恢复 |
| `src/` 引擎、工具、中断、流式输出 | 先 `npm run build`，再通过 GUI 触发真实路径并断言最终状态 |
| 启动、打包脚本、运行时依赖 | 还要跑 `cd gui && node scripts/package-app.mjs`，并验证打包版能启动 |

专项脚本只需要主动抛错并返回最小证据：

```bash
node gui/scripts/cdp-eval.mjs '
(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  // 触发真实路径，再断言最终结果
  assert(true, "替换为本次需求断言");
  return { passed: true, evidence: "最小证据" };
})()
'
```

脚本过长时可保存成临时 `.js` 文件并用 `--file` 执行；临时文件不要提交。

## 6. 结果判定与报告

最终回复保持短，但必须可核对：

```text
GUI 验证：通过 / 失败
- 测试用例：执行前写了哪些用例，分别覆盖什么路径
- 代码级检查：命令和结果；若跳过，说明原因
- build：执行或跳过的原因
- GUI 重启与连接：dev / packaged，固定端口 / 隔离目录
- 标准冒烟：快速冒烟结果
- 需求专项：操作路径、关键断言、实际结果
- 数据影响：是否写入真实数据、发送真实消息、修改设置，是否恢复
- 未覆盖项：没有则写“无”
```
