# GUI CDP 测试方案

GUI 是 Electron 应用（主进程 `gui/main.js`，渲染层 `gui/renderer/`）。Electron 内嵌
Chromium，加 `--remote-debugging-port` 启动后即开放标准 CDP（Chrome DevTools
Protocol）端点，可以用 HTTP + 原生 WebSocket 直连渲染进程执行 JS，完成调试、
冒烟测试与端到端 UI 验证——无需 Playwright/Puppeteer 等任何第三方依赖。

> 注意：Electron bundle 已被 postinstall 改名为 `xharness.app`，cua 等按 bundle id
> 识别应用的工具不认；直连 CDP 端口是唯一可靠方案。

## 1. 启动（带 CDP 端口）

```bash
npm run build          # 改了 src/ 必须先重建 dist，GUI 主进程 import ../dist/...
cd gui && npm start -- --remote-debugging-port=9223
```

打包版同样支持（Chromium 参数经 `--args` 透传）：

```bash
open release/xharness.app --args --remote-debugging-port=9223
```

验证端点已起来（未起来说明进程没启动或端口被占）：

```bash
curl -s http://127.0.0.1:9223/json/version   # 返回 Browser/Protocol-Version 等
curl -s http://127.0.0.1:9223/json/list      # 返回所有可调试目标（page/worker/...）
```

在 Chrome 里打开 `http://127.0.0.1:9223` 也能得到可视化 DevTools 入口。

## 2. 驱动脚本 gui/scripts/cdp-eval.mjs

零依赖 Node 脚本（Node >= 22，内置 fetch/WebSocket），自动匹配 `file://` 页面目标
并用 `Runtime.evaluate`（`awaitPromise` + `returnByValue`）求值：

```bash
node scripts/cdp-eval.mjs --list                       # 列出所有 CDP 目标
node scripts/cdp-eval.mjs 'document.title'             # 求值表达式，JSON 输出
node scripts/cdp-eval.mjs --file checks/smoke.js       # 求值文件内容（表达式/IIFE）
node scripts/cdp-eval.mjs --port 9223 --url 'index\.html' '1+1'   # 自定义端口/目标匹配
```

退出码：`0` 成功；`1` 连接/协议错误；`2` 页面内抛异常——可直接用于断言式检查。

表达式里可用的全局：`document`（渲染层 DOM）、`api`（preload contextBridge 暴露的
IPC 桥，见 `gui/preload.cjs`）。返回 Promise 的表达式会自动 await。

## 3. 标准冒烟检查（实测通过，可直接复制跑）

三段检查覆盖：应用壳渲染 → 交互与关键不变量 → IPC 桥。全部只读，不耗 API token。

### 3.1 应用壳与首屏状态

```bash
node scripts/cdp-eval.mjs '({
  title: document.title,
  sidebar: !!document.querySelector("#sidebar"),
  composer: !!document.querySelector("#composer textarea#input"),
  sendBtn: !!document.querySelector("#btn-send"),
  emptyStateVisible: !document.querySelector("#empty-state").classList.contains("hidden"),
  projectDir: document.querySelector("#es-folder")?.textContent,
  modelLabel: document.querySelector("#model-label")?.textContent.trim(),
  yoloBadge: document.querySelector("#yolo-badge")?.textContent.trim(),
  theme: document.documentElement.dataset.theme ?? "light",
})'
```

预期：`title === "xharness"`，三个布尔全 `true`，`yoloBadge` 含"完全访问"。

### 3.2 交互 + 设置页 vibrancy 不变量

打开设置时下层 `#app` 必须 `visibility:hidden`（否则半透明侧栏透出重影，
见 AGENTS.md GUI 要点）：

```bash
node scripts/cdp-eval.mjs '(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  document.querySelector("#btn-settings").click();
  await sleep(400);
  const settingsVisible = !document.querySelector("#settings-view").classList.contains("hidden");
  const appHiddenWhileSettings = getComputedStyle(document.querySelector("#app")).visibility === "hidden";
  const navPages = [...document.querySelectorAll("#set-sidebar .sb-item[data-page]")].map(el => el.dataset.page);
  document.querySelector("#btn-settings-back").click();
  await sleep(400);
  const backToApp = document.querySelector("#settings-view").classList.contains("hidden")
    && getComputedStyle(document.querySelector("#app")).visibility === "visible";
  return { settingsVisible, appHiddenWhileSettings, navPages, backToApp };
})()'
```

预期：全 `true`，`navPages` 为 `["models","appearance","plugins","skills","general"]`。

### 3.3 IPC 桥与供应商脱敏

providers 列表必须脱敏（`apiKey` 置空、只回 `hasKey`）：

```bash
node scripts/cdp-eval.mjs '(async () => {
  const s = await api.getState();
  return {
    bridgeReady: typeof api.send === "function",
    yoloAcked: s.yoloAcked,
    projects: s.sidebar.projects.map(p => p.dir.split("/").pop()),
    providers: s.providers.map(p => ({ id: p.id, hasKey: p.hasKey, keyLeaked: !!p.apiKey })),
  };
})()'
```

预期：`bridgeReady: true`，所有 `keyLeaked: false`。

### 3.4 判定与报告

把三段输出的 JSON 与预期逐项比对即可；脚本退出码非 0 直接判失败。功能改动后
在 3.1–3.3 之外追加针对该功能的断言（选择器从 `gui/renderer/index.html` 取，
一律用稳定 `id`，不用样式类）。

## 4. 排障

- **连不上端口**（`fetch failed`）：GUI 没起、没带 `--remote-debugging-port`，或
  端口被旧进程占。杀进程用 `pkill -f "MacOS/xharness"`（匹配 "Electron" 会失手）。
- **没有匹配的 page 目标**：先 `--list` 看实际目标，用 `--url '<regex>'` 调整匹配。
- **改了 src/ 行为没变化**：忘了 `npm run build`，GUI 主进程跑的是旧 dist。
- **页面内异常（退出码 2）**：输出含异常描述，多为选择器失效——渲染层 DOM 变了，
  按 `gui/renderer/index.html` 现状更新检查表达式。

## 5. 边界

- 数据目录是真实用户数据（`~/Library/Application Support/xharness/`），冒烟检查
  **只读优先**：不发真实消息（耗 token、写 session）、不改设置、不删会话。
- 需要写路径的验证（如发消息）在专用测试账号/数据目录下进行，不在本文档范围。
