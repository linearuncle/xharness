# xharness 开源前安全与隐私审查报告

| 项 | 内容 |
|---|---|
| 审查日期 | 2026-08-02 |
| 审查范围 | 全部已跟踪源码与配置、全部 34 条 git 提交（message + 内容抽查/模式扫描）、`.gitignore`、README YOLO 披露、GUI Electron 安全配置 |
| 审查目标 | 判定是否可安全开源，并给出按严重度排序的问题清单与修复建议 |
| 方法 | `git ls-files` 全量 + 敏感模式 grep；`git log --all --oneline` 全量消息；`git log -p` / pickaxe / PCRE 扫历史；手工审读关键路径 |

---

## 总览结论（先读这里）

| 维度 | 结论 |
|---|---|
| 密钥/令牌是否已泄露进仓库或历史 | **未发现**。无真实 API key、token、私钥、`.env` 实值 |
| 提交历史是否干净 | **干净**。34 条 commit 消息与 diff 抽查均无实密钥；`.env` / `.env.test` 从未入仓 |
| 产品风险（YOLO 无沙箱） | **设计如此**；CLI README 有独立醒目声明，但 GUI 路径披露偏弱 |
| Electron 安全基线 | **部分达标**（`contextIsolation: true`、preload 桥），但缺 CSP、markdown XSS 未消毒、`file://` 直引本地路径、`esc()` 不转义引号 |
| 开源合规 | **缺 LICENSE**（法律层面阻塞「正式开源」） |

**可否开源：**

- **从密钥与隐私泄露角度：可以发布**——当前工作树与完整 git 历史未发现可利用的凭证泄露，不需要 history rewrite。
- **从「负责任地公开给陌生人」角度：建议条件开源**——先补 **LICENSE**、加固 GUI XSS/CSP/`file://`、补强 YOLO/GUI 风险披露与 `.gitignore`，再公开或标 `0.1.0` release。
- **不阻塞项**：YOLO 无沙箱本身是产品定位，只要披露充分即可；不必为开源而改成沙箱模式。

---

## 1) 敏感信息扫描（源码与配置）

### 扫描覆盖

- 已跟踪文件：72 个（`git archive` 约 87 路径节点）；**未**跟踪 `node_modules/`、`dist/`、`.env`、`.env.test`（本地亦不存在实文件）。
- 重点路径：`.env.test.example`、`test/`、`gui/`、`state.yaml`、`review.md`、`GOAL.md`、`README.md`、`src/**`。
- 模式：`API_KEY` / `apiKey` / `password` / `secret` / `token` / `sk-*` 长串 / `AKIA*` / `ghp_` / `BEGIN PRIVATE KEY` / 绝对路径 `/Users/...` / 个人邮箱等。

### 结果摘要

| 类别 | 结果 | 说明 |
|---|---|---|
| 真实 API key / token / 密码 | **无** | 仅有占位符与测试假值 |
| `.env.test.example` | **安全** | `ANTHROPIC_API_KEY=你的 DeepSeek key` 为中文占位，非实值 |
| 单测假 key | **安全** | 如 `vi.stubEnv("ANTHROPIC_API_KEY", "test-key")`、`apiKey: "key"` |
| `state.yaml` | **无密钥** | 仅有 `deepseek_key: present (DEEPSEEK_API_KEY)` 表示「环境里有 key」，未写入值 |
| `review.md` | **无密钥** | 评审文档，仅讨论环境变量名 |
| 绝对用户路径 / 个人邮箱入仓 | **无** | 作者为 `linearuncle <…@users.noreply.github.com>` |
| lockfile registry token | **无** | `package-lock.json` / `gui/package-lock.json` 无 `_authToken` |
| 运行时密钥落盘（用户机） | **有设计** | GUI 手动模式把 `apiKey` 明文写入 `~/.xharness/gui/settings.jsonl`（**不在仓库内**，见问题 H3） |

### 证据摘录（均为非敏感用法）

- `.env.test.example:7`：`ANTHROPIC_API_KEY=你的 DeepSeek key`
- `test/e2e/helpers.ts:36-40`：从 `.env.test` / 环境变量解析 key，**无硬编码**
- `gui/store.js:28-29`：默认 `apiKey: ""`，`keyMode: "env"`
- `state.yaml:10`：`deepseek_key: present (DEEPSEEK_API_KEY)`

---

## 2) Git 提交历史审查

### 2.1 全量 commit message（34 条）

已执行 `git log --all --oneline` 与 message 正文敏感词扫描。消息中出现的 `token` / `API_KEY` 均为功能描述（如 compact 前后 token、环境变量名），**无实密钥**。

### 2.2 提交内容抽查

| 检查项 | 结果 |
|---|---|
| pickaxe / 全文 diff 对 `API_KEY`、`DEEPSEEK`、`ANTHROPIC_API_KEY` | 仅文档、配置加载、测试 stub |
| 类真实密钥 PCRE：`sk-(ant-\|or-)?[A-Za-z0-9_-]{20,}` | **零命中** |
| 长引号密钥赋值、`Bearer …`、AWS/GitHub PAT | **零命中** |
| `/Users/...` 绝对路径入 diff | **零命中** |
| `.env` / `.env.test` 是否曾提交 | **从未**（`git rev-list --all -- .env .env.test` 空） |
| `dist/`、`node_modules/` 是否曾提交 | **从未** |
| 触及 `.env*` 的提交 | 仅 `c7e2f05` 引入 `.env.test.example`（占位符） |

### 2.3 历史作者信息

- 唯一作者：`linearuncle <181569493+linearuncle@users.noreply.github.com>`（GitHub noreply，可接受）
- 多处 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`（工具署名，无隐私风险）

**本节结论：无需 BFG/filter-repo 清洗历史即可开源。**

---

## 3) `.gitignore` 覆盖评估

当前完整内容：

```
node_modules
dist
.env.test
.env
```

| 路径/模式 | 现状 | 评估 |
|---|---|---|
| `node_modules` | 已忽略 | 根与 `gui/node_modules` 均生效（`git check-ignore` 确认） |
| `dist` | 已忽略 | 正确；构建产物不入库 |
| `.env` / `.env.test` | 已忽略 | 正确；example 仍跟踪 |
| `~/.xharness/**` | 不在仓库路径 | 用户数据写 home，**不会**因漏 ignore 而误提交；但应在文档说明勿拷贝进仓库 |
| `.DS_Store` / `*.log` / `coverage` / `.vscode` / `.idea` | **未忽略** | 低风险遗漏，易脏工作区 |
| `.env.*` / `.env.local` 等变体 | **仅列两个文件名** | 若有人建 `.env.production` 可能误提交 |
| `*.pem` / 凭证类 | **未忽略** | 防御性缺失 |
| `state.yaml` / `review.md` / `GOAL.md` | **已跟踪** | 无密钥，但属内部任务板/评审；开源时是否保留属产品选择（见 L1） |

---

## 4) YOLO 无沙箱 —— README 风险披露评估

### CLI（根 `README.md`）

- 有独立章节 **「YOLO 无沙箱模式 —— 风险声明（务必阅读）」**（约 L127–141）。
- 明确三点：无确认、无路径约束、无命令黑名单；建议可信任务/非关键目录/先 git 备份；结尾「风险自负」。
- 「已知限制」再次声明不做沙箱与其它权限模式。

**评估：对 CLI 用户披露基本充分**，达到同类 agent harness 常见水平。仍可加强（见 M4）：责任边界、适用对象、与 GUI 的对应关系、安全报告渠道。

### GUI（`gui/README.md` + 界面）

- 仅一行功能说明：`YOLO 提示：橙色"⚠ 完全访问"徽标——与 CLI 相同，无沙箱、工具直接执行`。
- 界面有 `⚠ 完全访问` badge（`gui/renderer/index.html`）。
- **根 README 完全未提及 GUI/Electron 子项目**。

**评估：GUI 路径披露不足**——桌面用户更可能忽略 CLI README，却同样触发无沙箱 Bash/Write。

### 代码侧印证（披露与行为一致）

- `src/tools/bash.ts`：`spawn("bash", ["-c", command], { detached: true })`，无黑名单/沙箱。
- `src/tools/write.ts` / `read.ts`：任意 `file_path`，无 cwd 约束。
- E2E 仅审计「测试过程中模型是否发出破坏性命令」，**不是**运行时防护。

---

## 5) GUI Electron 安全配置

| 控制项 | 现状 | 判定 |
|---|---|---|
| `contextIsolation` | `true`（`gui/main.js` L37–39） | **达标**（显式开启） |
| `nodeIntegration` | **未显式设置** | Electron 37 默认 `false`，实际安全；**建议显式写 false** |
| `sandbox`（webPreferences） | **未设置** | 建议显式 `sandbox: true`（与 preload 兼容需验证） |
| Preload 桥 | `preload.cjs` + `contextBridge.exposeInMainWorld("api", …)` | **达标**（无 `remote`） |
| CSP | `index.html` **无** `Content-Security-Policy` | **不足** |
| 页面加载 | `loadFile(.../renderer/index.html)` | 本地 file 协议；可接受，但需配合 CSP 与禁用随意导航 |
| `file://` 图片 | `app.js` 多处 `src="file://${esc(path)}"` | **风险**（见 H2） |
| Markdown → HTML | `marked.parse` → `innerHTML`，无 DOMPurify | **风险**（见 H1） |
| HTML 转义 | `esc()` 仅 `& < >`，**不转义引号** | **风险**（见 H1） |
| IPC 校验 | handlers 基本信任 renderer 入参 | **薄弱**（见 M2） |
| API Key 进渲染进程 | `getProviders()` 完整对象含 `apiKey` | **隐私/暴露面**（见 M1） |

---

## 问题清单（按严重度排序）

严重度定义：

- **Critical**：真实密钥已泄露或可直接导致远程接管；本仓库 **未发现**。
- **High**：开源后显著扩大攻击面或法律/合规硬伤，公开前强烈建议处理。
- **Medium**：设计/配置缺陷，应修复或明确文档披露。
- **Low**：卫生与可维护性，不阻塞发布。

---

### H1 — GUI：模型/用户内容 Markdown 未消毒即 `innerHTML`（XSS → 高权限 IPC）

**严重度：High**

**证据：**

- `gui/main.js` L142：`ipcMain.handle("md:render", (_e, text) => marked.parse(text ?? ""));`（`marked` 默认可保留 HTML）
- `gui/renderer/app.js` L164、L399：`api.renderMarkdown(...).then((h) => (….innerHTML = h))`
- `gui/renderer/app.js` L627–629：`esc()` 不处理 `"` / `'`
- Preload 暴露大量能力：`chat:send`、`attach:save-clipboard`、任意 `attachmentPaths` 读文件、`settings:upsert` 等

**风险：** 恶意或被投毒的模型输出 / 会话重放内容可在渲染进程执行脚本；结合 IPC 可诱导读任意本地文件、改设置、向 agent 塞指令（本地 app 的「跨上下文」升级）。

**修复建议：**

1. 渲染前用 **DOMPurify**（或主进程消毒后只下发安全 HTML）；或禁用 raw HTML（marked 自定义 renderer）。
2. `esc()` 补全属性转义：`"` → `&quot;`，`'` → `&#39;`。
3. 为 `index.html` 增加严格 CSP（至少限制 `script-src 'self'`，避免 inline 可逐步迁移）。
4. 缩小 preload API 面；敏感操作做路径白名单/对话框来源校验。

---

### H2 — GUI：用 `file://` + 任意路径展示附件

**严重度：High**（与 H1 叠加时更高）

**证据：**

- `gui/renderer/app.js` L172、L216、L1021：`src="file://${esc(a.path)}"`
- `gui/main.js` L178–196：`loadAttachments` 对传入路径 `readFileSync`，无「必须在附件目录/用户点选路径」校验
- `chat:send` 的 `attachmentPaths` 完全由渲染进程提供

**风险：** 渲染进程一旦被 XSS 或被恶意页面脚本控制，可拼 `file://` 探测本地资源，或通过 `attachmentPaths` 把任意文件（含密钥文件）读入上下文发给模型。

**修复建议：**

1. 附件统一拷贝到 `~/.xharness/gui/attachments/`，渲染只用 **受控 id** 或自定义协议（如 `xharness-att://`）由主进程流式返回。
2. 禁止 renderer 直接拼 `file://`；主进程校验路径前缀。
3. `webPreferences` 考虑限制 `webSecurity` 保持默认 true；注册 `protocol.handle` 代替裸 file URL。

---

### H3 — 缺少 LICENSE（正式开源硬阻塞）

**严重度：High（合规）**

**证据：** 仓库根目录无 `LICENSE` / `LICENSE.md`；`package.json` 无 `license` 字段。

**风险：** 未声明许可证时，他人默认 **无权** 合法复制/修改/再分发；GitHub 会标 “View license: None”。

**修复建议：** 选定 OSI 许可证（MIT/Apache-2.0 等）写入 `LICENSE`，并在 `package.json` / `gui/package.json` 声明 `license`；若含依赖需 NOTICE 则一并处理。

---

### M1 — API Key 明文持久化并完整进入渲染进程

**严重度：Medium**

**证据：**

- `gui/store.js` L16、L158–162：`settings.jsonl` append 完整 `provider`（含 `apiKey`）
- `gui/main.js` L63、L69：`providers: store.getProviders()` 原样给前端
- `gui/renderer/app.js` L875：设置页直接绑定 `work.apiKey`

**风险：** 本机 malware/备份同步/日志误传可带走 key；XSS 可直接读 `S.providers`。

**修复建议：**

1. 优先文档强调 **环境变量模式**；手动 key 使用系统钥匙串（`keytar` 等）或 OS secure storage。
2. IPC 返回 providers 时 **脱敏**（仅 `apiKeySet: boolean`），编辑时单独通道。
3. README / GUI README 明确「key 明文落在 `~/.xharness/gui/settings.jsonl`」。

---

### M2 — IPC 信任边界过宽（任意路径读写入口）

**严重度：Medium**

**证据：** `gui/main.js` 中 `chat:send` / `files:search` / `skills:list` 等直接使用 renderer 传入的 `projectDir` 与路径；无 `event.senderFrame` 校验、无路径规范化约束。

**风险：** 在 H1 成立时放大危害；即便无 XSS，恶意扩展或未来若加载远程内容会更糟。

**修复建议：** 所有路径 `resolve` 后限制在用户已添加项目目录或附件目录；拒绝 `..` 跳出；仅处理来自本窗口的 sender。

---

### M3 — Electron 安全开关未写全 + 无 CSP

**严重度：Medium**

**证据：** `gui/main.js` L37–40 仅设 `preload` + `contextIsolation: true`；`gui/renderer/index.html` 无 CSP meta / 响应头。

**修复建议：**

```js
webPreferences: {
  preload: join(here, "preload.cjs"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true, // 验证 preload 兼容后开启
  webSecurity: true,
}
```

并增加 CSP；禁用 `window.open` / 外部导航或统一 `shell.openExternal` 白名单。

---

### M4 — YOLO / 危险能力披露对 GUI 与「新用户首屏」不充分

**严重度：Medium**

**证据：**

- 根 README L127–141 披露充分，但 **不提 GUI**。
- `gui/README.md` 仅一行 YOLO；无「风险自负」独立章节。
- 首次启动无强制确认/风险模态（仅有橙色 badge）。

**修复建议：**

1. 根 README 增加「GUI」小节并链到 YOLO 声明。
2. `gui/README.md` 复制同等级风险章节。
3. GUI 首次运行模态：勾选「我理解将授予完全访问」再启用发送。
4. 可选：增加 `SECURITY.md` 说明威胁模型（本地 YOLO agent）与漏洞报告方式。

---

### M5 — `.gitignore` 过薄

**严重度：Medium（运维卫生）**

**证据：** 仅 4 行；未覆盖常见 env 变体与编辑器/OS 垃圾文件。

**修复建议（示例）：**

```
node_modules/
dist/
.env
.env.*
!.env.test.example
!.env.example
*.log
.DS_Store
coverage/
.vscode/
.idea/
*.pem
```

---

### L1 — 内部任务板/评审文件是否应进入公开仓库

**严重度：Low**

**证据：** `state.yaml`（GoalBuddy 任务板）、`review.md`（GOAL 评审）已跟踪；含环境版本与流程回执，**无密钥**。

**建议：** 开源时可保留作设计考古，或移入 `docs/internal/` / 不发布分支，避免读者混淆「产品文档 vs 开发过程」。

---

### L2 — 无 `SECURITY.md` / 无安全联系渠道

**严重度：Low**

**建议：** 增加简短 `SECURITY.md`（支持版本、报告邮箱/私信、响应预期）。

---

### L3 — 根 README 未介绍 GUI 子项目

**严重度：Low（产品完整性）**

**建议：** 在安装/使用章增加 GUI 启动指引，并交叉引用风险声明。

---

## 明确「非问题」清单（避免重复劳动）

| 项 | 说明 |
|---|---|
| 仓库内真实 API key | 未发现 |
| git 历史密钥 | 未发现，无需 scrub |
| `.env.test.example` | 占位符，可保留 |
| `test-key` 单测 | 可接受 |
| `node_modules` / `dist` 入库 | 未发生 |
| CLI YOLO 设计本身 | 有意设计；披露到位即可开源，不强制改沙箱 |
| `state.yaml` 的 `deepseek_key: present` | 非密钥材料 |

---

## 开源前检查清单（建议执行顺序）

1. **[必须]** 添加 `LICENSE` 并在 package.json 声明。
2. **[强烈建议]** 修复 H1/H2（markdown 消毒 + 取消裸 `file://` + 属性转义）。
3. **[强烈建议]** 显式 Electron 安全 webPreferences + CSP（M3）。
4. **[强烈建议]** 补强 YOLO 披露覆盖 GUI + 首启确认（M4）。
5. **[建议]** API key 脱敏 IPC / 文档说明明文存储（M1）；收紧附件路径（M2）。
6. **[建议]** 扩展 `.gitignore`（M5）。
7. **[可选]** 整理 `state.yaml`/`review.md` 去留；添加 `SECURITY.md`。
8. **[发布前再跑一遍]**  
   `git grep -iE 'sk-[a-z0-9]{10,}|api[_-]?key\s*=\s*["\047][a-z0-9]'`  
   `git log --all -p | rg --pcre2 'sk-(ant-)?[A-Za-z0-9_-]{20,}'`

---

## 最终结论

| 问题 | 答案 |
|---|---|
| 现在把仓库推成 **public** 会不会已经泄露 key？ | **不会**（就当前历史与工作树而言） |
| 是否建议 **立刻** 无改动开源？ | **不建议「零改动正式宣布开源」**——至少补 LICENSE；GUI 安全项应修或显著披露 |
| 推荐策略 | **条件开源**：完成 H3 +（H1/H2 或等价披露）+ M4/M5 后打 tag 公开；YOLO 保持设计并维持醒目警告 |
| 总评 | **密钥与历史：通过。产品安全与合规：有条件通过。** |

---

*本报告仅针对「开源前安全与隐私」；不替代完整渗透测试、依赖 CVE 审计（`npm audit`）或法律意见。*
