# GUI 需求完成后的 CDP 验证指南

本文是 GUI 需求的完成门禁，供 AI 在每次实现功能或修复问题后直接执行。目标不是证明
“应用能启动”，而是用可重复的断言证明：基础界面和导航没有被破坏、本次需求确实生效、
关键边界得到覆盖，并留下可核对的测试结果。

xharness 是 Electron 应用（主进程 `gui/main.js`，渲染层 `gui/renderer/`）。启动时加入
`--remote-debugging-port` 后，可以通过 Chrome DevTools Protocol（CDP）连接渲染进程，
直接检查 DOM、触发交互和调用 preload 暴露的 IPC，无需 Playwright 或 Puppeteer。

> Electron bundle 已被改名为 `xharness.app`，依赖 bundle id 识别应用的工具不可靠；
> 本项目的 GUI 自动验证统一使用 CDP。

## 1. 完成标准

AI 在宣布 GUI 需求完成前，必须按以下顺序闭环：

1. 根据改动列出本次需求的可观察结果和风险点。
2. 先写出本次 GUI 验证的测试用例，覆盖标准冒烟和需求专项；用例未写完前不得开始执行。
3. 执行改动所需的类型检查、单元测试等代码级验证。
4. 在仓库根目录执行 `npm run build`，保证 GUI 使用最新的 `dist/`。
5. 完全重启 GUI 开发实例，不能复用实现前启动的旧进程。
6. 按已写好的用例执行第 3 节的三段标准冒烟检查。
7. 按已写好的用例执行第 5 节的本次需求专项检查。
8. 任何检查失败时，修复后先更新测试用例，再从构建、重启、标准冒烟开始重新执行。
9. 按第 6 节报告测试用例和验证证据；不能只写“已测试”或“看起来正常”。

只有“代码级验证 + 标准冒烟 + 需求专项检查”全部通过，需求才算完成。CDP 验证不能替代
已有单元测试，单元测试也不能替代真实 GUI 验证。

### 数据策略

默认单实例流程直接使用真实数据目录 `~/Library/Application Support/xharness/`。这能覆盖
真实历史会话、项目和设置组合，但也意味着发送消息会消耗真实 token，并写入 session；
设置、会话等操作也会真实持久化。

- 不要假设应用处于首次启动空态。执行写操作前先读取并记录当前状态，断言应基于实际基线。
- 需求需要写操作时可以执行，但只操作本次需求涉及的数据；不要删除或覆盖无关用户数据。
- 临时修改用户偏好后，若验证目标不包含持久化，应恢复原值并在报告中说明。
- 首启流程、破坏性场景或多 worktree 并发测试必须使用第 4 节的隔离数据目录。

## 2. 构建、重启与连接

除非命令特别说明，本节从仓库根目录执行。

### 2.1 默认单实例流程

先构建，再终止旧 GUI，最后在一个持续运行的终端中启动新实例：

```bash
npm run build
pkill -f "MacOS/xharness"
cd gui
npm start -- --remote-debugging-port=9223
```

`pkill -f "MacOS/xharness"` 只允许在确认没有其他 worktree 或用户实例并行运行时使用。
没有旧进程时它返回 1，可忽略；并发场景禁止执行这条命令，必须改用第 4 节的隔离流程。

在另一个终端确认端点与页面目标均已就绪：

```bash
curl -s http://127.0.0.1:9223/json/version
curl -s http://127.0.0.1:9223/json/list
cd gui
node scripts/cdp-eval.mjs --list
```

成功标准：

- `/json/version` 返回 `Browser`、`Protocol-Version` 等字段。
- `--list` 至少包含一个当前 xharness 实例的 `file://` page 目标。
- 输入区显示红色 `CDP:9223` 标记。

固定端口可能误连到残留实例，因此不能只看 `curl` 成功；必须检查 `--list` 中的页面 URL
属于当前仓库。主进程启动日志出现异常时，也必须先处理，不能继续在半启动状态下测试。

### 2.2 CDP 驱动脚本

`gui/scripts/cdp-eval.mjs` 是零依赖 Node 脚本（Node >= 22），会自动匹配 `file://` 页面并
通过 `Runtime.evaluate` 执行表达式。以下命令从 `gui/` 目录执行：

```bash
node scripts/cdp-eval.mjs --list
node scripts/cdp-eval.mjs 'document.title'
node scripts/cdp-eval.mjs --port 9223 --url 'index\.html' '1 + 1'
node scripts/cdp-eval.mjs --data-dir ../.xhtest-agent-name --list
```

可用全局包括：

- `document`：渲染层 DOM。
- `getComputedStyle`：验证最终可见样式，不只检查 class 名。
- `api`：`gui/preload.cjs` 通过 contextBridge 暴露的 IPC 接口。

Promise 会被自动等待。退出码 `0` 表示表达式执行成功，`1` 表示连接或协议错误，`2` 表示
页面内抛出异常。测试表达式应主动 `throw new Error(...)` 断言预期，避免“成功输出了错误
状态”仍被误判为通过。

## 3. 标准冒烟检查

每次 GUI 改动都必须执行以下三段检查。它们不依赖空态，不发送 API 请求，也不修改持久化
数据；第二段会打开设置页，然后恢复到工作区。

以下命令均从 `gui/` 目录执行，默认连接 9223 端口。

### 3.1 基础界面、导航与输入区

```bash
node scripts/cdp-eval.mjs '
(() => {
  const result = {
    title: document.title,
    sidebar: !!document.querySelector("#sidebar"),
    composer: !!document.querySelector("#composer textarea#input"),
    sendButton: !!document.querySelector("#btn-send"),
    yoloBadge: document.querySelector("#yolo-badge")?.textContent.trim(),
    debugBadge: document.querySelector("#debug-badge")?.textContent.trim(),
  };
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  assert(result.title === "xharness", `标题异常: ${result.title}`);
  assert(result.sidebar && result.composer && result.sendButton, "基础界面、导航或输入区缺失");
  assert(result.yoloBadge?.includes("完全访问"), `YOLO 标记异常: ${result.yoloBadge}`);
  assert(["CDP:9223", "CDP:auto"].includes(result.debugBadge),
    `CDP 标记异常: ${result.debugBadge}`);
  return result;
})()
'
```

### 3.2 设置页交互与 vibrancy 不变量

打开设置时，下层 `#app` 必须为 `visibility:hidden`，否则半透明侧栏会透出工作区重影：

```bash
node scripts/cdp-eval.mjs '
(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const waitFor = async (check, message, timeout = 2500) => {
    const started = Date.now();
    while (!check()) {
      if (Date.now() - started > timeout) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const app = document.querySelector("#app");
  const settings = document.querySelector("#settings-view");
  const openButton = document.querySelector("#btn-settings");
  const backButton = document.querySelector("#btn-settings-back");
  assert(app && settings && openButton && backButton, "设置页基础节点缺失");

  if (!settings.classList.contains("hidden")) {
    backButton.click();
    await waitFor(() => settings.classList.contains("hidden"), "无法先返回工作区");
  }
  openButton.click();
  await waitFor(() => !settings.classList.contains("hidden"), "设置页未打开");

  const navPages = [...document.querySelectorAll("#set-sidebar .sb-item[data-page]")]
    .map(element => element.dataset.page);
  const expectedPages = ["models", "appearance", "plugins", "skills", "general"];
  const appHidden = getComputedStyle(app).visibility === "hidden";
  assert(appHidden, "设置页打开时工作区仍可见");
  assert(JSON.stringify(navPages) === JSON.stringify(expectedPages),
    `设置导航异常: ${JSON.stringify(navPages)}`);

  backButton.click();
  await waitFor(() => settings.classList.contains("hidden"), "无法返回工作区");
  const appRestored = getComputedStyle(app).visibility === "visible";
  assert(appRestored, "返回后工作区未恢复可见");
  return { settingsOpened: true, appHidden, navPages, appRestored };
})()
'
```

### 3.3 IPC 桥与供应商脱敏

`state:get` 返回的供应商列表不得泄露 API Key，只能暴露 `hasKey`：

```bash
node scripts/cdp-eval.mjs '
(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  assert(typeof api?.getState === "function" && typeof api?.send === "function", "IPC 桥未就绪");
  const state = await api.getState();
  assert(Array.isArray(state?.sidebar?.projects), "项目状态结构异常");
  assert(Array.isArray(state?.providers), "供应商状态结构异常");
  const leaked = state.providers.filter(provider => !!provider.apiKey).map(provider => provider.id);
  const missingFlag = state.providers.filter(provider => typeof provider.hasKey !== "boolean")
    .map(provider => provider.id);
  assert(leaked.length === 0, `供应商密钥泄露: ${leaked.join(", ")}`);
  assert(missingFlag.length === 0, `供应商缺少 hasKey: ${missingFlag.join(", ")}`);
  return {
    bridgeReady: true,
    projectCount: state.sidebar.projects.length,
    providers: state.providers.map(provider => ({ id: provider.id, hasKey: provider.hasKey })),
  };
})()
'
```

三段命令都必须退出码为 `0`，并返回符合断言的 JSON。若本次需求有意改变上述不变量，先
同步更新产品规格和本指南中的预期，不能临时删除断言来让测试通过。

## 4. 多 worktree 并发隔离

多个 AI agent 或 worktree 同时测试时，固定端口和默认数据目录会产生三类冲突：后启动的
实例无法占用 9223，却可能连接到别人的页面；宽泛的 `pkill` 会杀掉所有 GUI；多个实例
会同时读写真实 session 和 settings。

并发时必须同时隔离数据目录和 CDP 端口。以下命令从各自 worktree 的仓库根目录执行，
`.xhtest-*` 已被 gitignore。先把示例中的 `agent-name` 换成当前 agent 或 worktree 的
唯一标识：

```bash
TEST_DATA_DIR="$PWD/.xhtest-agent-name"
mkdir -p "$TEST_DATA_DIR"
XH_DATA_DIR="$TEST_DATA_DIR" npm --prefix gui start -- --remote-debugging-port=0 \
  > "$TEST_DATA_DIR/cdp.log" 2>&1
```

启动命令需要留在专用终端中持续运行。Chromium 会自动选择空闲端口，驱动脚本从日志中
读取本实例的实际端口：

```bash
TEST_DATA_DIR="$PWD/.xhtest-agent-name"
node gui/scripts/cdp-eval.mjs --data-dir "$TEST_DATA_DIR" --list
node gui/scripts/cdp-eval.mjs --data-dir "$TEST_DATA_DIR" 'document.title'
```

执行第 3 节和第 5 节的表达式时，在命令中追加 `--data-dir "$TEST_DATA_DIR"` 即可。

隔离流程的硬性规则：

- 每个 worktree 使用唯一的 `.xhtest-*` 目录；`XH_DATA_DIR` 同时隔离 JSONL 和 Chromium
  `userData`。
- `cdp.log` 必须接收 stdout 和 stderr。端口发现依赖其中最后一条
  `DevTools listening on ws://127.0.0.1:<port>/...` 日志。
- 隔离目录是全新首启状态，只适合首启、破坏性或并发检查；默认真实数据专项验证仍按第 2 节执行。
- 禁止并发执行 `pkill -f "MacOS/xharness"`。只终止当前 worktree 的实例：
  `pkill -f "$PWD/gui/node_modules/electron/dist/xharness.app"`。
- 测试窗口会真实显示，可能受到人工操作干扰。断言最终 DOM/IPC 状态，不要只依赖窗口焦点
  或短暂动画帧。

## 5. 需求专项验证

标准冒烟只证明公共基线未回归，不能证明本次需求已经实现。AI 必须先把需求翻译成可观察
结果，再选择对应检查层。至少覆盖主成功路径，以及本次改动最可能破坏的一条边界或回归路径。

在执行任何 GUI 检查前，AI 必须先写出测试用例。测试用例可以写在工作记录、最终报告草稿
或临时检查文件注释中，但必须先于执行动作产生，且内容足够让别人复核“为什么测这些”。
禁止先随手点界面或跑脚本，事后再倒推成测试用例。

每条测试用例至少包含：

- 用例名称：说明它覆盖标准冒烟、主成功路径、边界路径还是回归路径。
- 前置条件：使用真实数据目录还是隔离数据目录，是否需要已有项目、设置或会话。
- 操作步骤：通过 CDP 触发的点击、输入、IPC 调用或重启动作。
- 断言：明确写出必须为真的 DOM、样式、IPC 返回值、文件状态或日志条件。
- 证据：执行后要记录的最小结果对象、命令输出或日志位置。

| 改动类型 | 首选验证证据 |
| --- | --- |
| 元素、文本、显示状态 | 稳定 `id` 查询、`textContent`、`hidden`、`getComputedStyle` |
| 点击、输入、菜单、弹层 | 触发真实 DOM 事件，等待最终状态，再断言打开与关闭两条路径 |
| 渲染与流式更新 | 等待目标块定稿，断言最终 DOM；不要把中间帧当成功证据 |
| IPC 或主进程逻辑 | 通过 `api` 调用真实 IPC，断言返回值及渲染层结果，并检查启动日志 |
| 设置、会话、项目持久化 | 记录原值，执行修改，完全重启，再读取并断言；需要时恢复原值 |
| API、工具调用、中断 | 发送能稳定触发目标路径的真实消息，等待完成或中断，核对最终块和错误状态 |
| 主题、布局、可见性 | 同时检查 DOM 状态和计算后样式；涉及主题时覆盖浅色与深色 |

### 5.1 专项检查设计规则

- 从 `gui/renderer/index.html` 或实现代码选择稳定 `id`；不要依赖纯样式类、元素序号或文案
  片段，除非文案本身就是验收目标。
- 先触发用户真实操作，再验证用户可见结果；只调用内部函数不能证明界面链路正常。
- 异步行为使用轮询等待明确条件，设置合理超时；不要用一个固定 `sleep` 后盲目读取。
- 断言要主动抛错，并返回简短诊断对象。只打印大段 DOM 或状态供 AI 主观判断不算自动验证。
- 验证负向路径时，同时断言“没有发生什么”，例如菜单已关闭、旧内容未残留、敏感字段未返回。
- 涉及持久化时必须重启应用后再验证，内存中的当前值不能作为持久化成功的证据。
- 涉及真实 API 时记录使用的供应商、模型、提示词意图和最终状态，但不得在报告中输出密钥。

可复用的断言骨架：

```bash
node scripts/cdp-eval.mjs '
(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const waitFor = async (check, message, timeout = 5000) => {
    const started = Date.now();
    while (!check()) {
      if (Date.now() - started > timeout) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };

  // 1. 记录测试前状态
  // 2. 通过点击、输入或 api 调用触发真实路径
  // 3. 等待明确的完成条件
  // 4. 对需求结果与回归边界分别断言

  assert(true, "把这里替换为本次需求的断言");
  return { passed: true, evidence: "返回最小且可核对的证据" };
})()
'
```

若一条命令过长，将表达式保存为临时 `.js` 检查文件并通过 `--file` 执行。临时检查文件
不要提交；有长期回归价值的检查应整理为正式自动化测试并纳入仓库。

### 5.2 条件性验证

- 修改 `src/`：`npm run build` 是硬要求，因为 GUI 直接加载 `dist/`。
- 修改启动、打包脚本或 GUI 运行时依赖：除开发版闭环外，还要执行
  `(cd gui && node scripts/package-app.mjs)`，再用
  `open release/xharness.app --args --remote-debugging-port=9223` 验证打包版能启动并完成冒烟。
- 修改持久化：至少验证“修改 → 重启 → 重新读取”，并检查对应 JSONL 没有被意外清空。
- 修改中断或工具执行：除界面状态外，还要验证最终 history 中的 `tool_use` / `tool_result`
  保持配对。

## 6. 结果判定与报告

最终回复至少包含以下信息：

```text
GUI 验证：通过 / 失败
- 测试用例：执行前写了哪些用例，分别覆盖什么路径
- 代码级检查：执行了哪些命令，结果是什么
- 构建与重启：开发版或打包版、固定端口或隔离数据目录
- 标准冒烟：基础界面、设置交互、IPC 脱敏三项结果
- 需求专项：操作路径、关键断言、实际结果
- 数据影响：是否发送真实消息、修改设置或新增测试会话，是否已恢复
- 未覆盖项：没有则写“无”；有则说明原因和风险
```

失败时必须保留具体异常、失败断言和相关日志，回到实现阶段修复，然后完整重跑。不得用以下
情况替代通过结论：页面能打开、没有肉眼看到报错、CDP 命令退出码为 0 但未断言结果、只跑
标准冒烟而没有需求专项测试。

## 7. 常见故障

- **`fetch failed` / 连不上 9223**：GUI 未启动、未带调试参数、端口被占用，或旧进程尚未
  退出。先检查启动日志和 `/json/version`；单实例才可使用宽泛 `pkill`。
- **`curl` 成功但结果不属于当前代码**：9223 上是残留或其他 worktree 的实例。用
  `--list` 检查 page URL，终止错误实例后重新构建、启动。
- **没有匹配的 page 目标**：先执行 `--list`，再通过 `--url '<regex>'` 精确匹配当前
  `index.html`；并发时也可以用 URL 中的 worktree 路径区分。
- **`--data-dir` 读不到端口**：确认启动参数为 `--remote-debugging-port=0`，并确认 stdout、
  stderr 都重定向到同一目录的 `cdp.log`。Electron 不会生成可依赖的
  `DevToolsActivePort` 文件。
- **修改 `src/` 后行为不变**：GUI 正在读取旧 `dist/`。重新执行 `npm run build` 并完全
  重启，热刷新不能解决主进程或引擎代码过期。
- **退出码 2 / 页面内异常**：查看异常中的失败断言。若是选择器失效，对照当前
  `gui/renderer/index.html`；若产品行为有意改变，更新需求、实现和长期断言，不能直接跳过。
- **结果偶发不稳定**：把固定延时替换为等待明确状态；确认窗口没有被其他人操作；并发场景
  确认端口和数据目录确实隔离。
