# xhp Platform MVP — 产品与设计规格

> 来源：grilling 会话共识（已冻结）。  
> 规格参照：Multica 中文产品文档叙事（https://multica.ai/docs/zh），**非**官方代码 fork，**非**文档站镜像。  
> 状态：shared understanding 已确认；实现前以本文为准。

---

## 1. 目标

以 Multica 式 **managed agents 平台** 为产品目标：任务指派、进度跟踪、workspace、agent 配置档案等。

| 是 | 否 |
|----|-----|
| 产品能力级 clone（文档当 PRD） | 镜像 / 离线导出 multica.ai/docs |
| 新系统 / 大改级平台层 | 往现有 harness 零碎塞 feature |
| 从零自研协调平面 | fork 官方 multica-ai/multica 代码树作起点 |
| CLI 单机可演示 MVP | 第一天 Web / 多机 daemon |

**对外工作名**：非 Multica 官方产品。README 须写明内部工作名。

---

## 2. 架构原则

### 2.1 分层

| 层 | 职责 |
|----|------|
| **agent-core** | 现有 harness 的 loop / tools / api 抽出为**可 import 库**；回合编排与供应商适配 |
| **platform** | workspace / agent / issue / run / 评论 / 持久化 / CLI |
| **Runner** | 可替换执行接口；把 Issue 变成一次 Run，并回写状态 |

- platform **禁止**倒依赖 UI / REPL 细节。
- Runner **只**依赖 agent-core **公开 API**；禁止 import 私有路径或直接碰供应商 SDK。
- agent-core 以**唯一出口**对外（例如 `src/agent-core/index.ts`）；公共 API 清单与出口同步。

### 2.2 仓库形态

- **单 monorepo**，目录边界清晰。
- MVP 阶段：`src/agent-core` + `src/platform`（**暂不**一次切成 `packages/*`）。
- 现有 `xharness` bin **保留**，作为 agent-core 的 REPL / 一次性 CLI 入口。
- 平台另提供 bin：`xhp`。

### 2.3 执行拓扑（MVP）

| 项 | 决定 |
|----|------|
| 演示路径 | **进程内同步**执行（CLI 阻塞到 Run 结束） |
| 记录模型 | **Issue 与 Run 独立记录**；禁止「指派 = 直接调 loop」无 Run 行 |
| Runner | 接口可替换；**in-process** 为第一种实现 |
| 并发 | **全局同时仅 1 个 Run**（整个 xhp 进程）；每 workspace 亦串行 |
| 取消 | **SIGINT 必做**：Run → `cancelled`，Issue → `todo` |

演进预留：Worker / daemon 实现第二种 Runner；对象模型与 CLI 回写路径不绑死 in-process。

---

## 3. MVP 主闭环

唯一成功主路径：

```text
建 workspace
  → 建/选 agent
  → 创建 issue
  → issue assign（立即创建 Run 并执行）
  → agent-core 真实跑完
  → 可查 issue 状态 / 系统评论 / 产物
  → 可 cat run log；CLI issue show / run show
```

### 3.1 演示成功判据

1. **真实 runtime**（禁止 mock agent 充当闭环）。
2. **可 cat 的 run log**，以及可查询的 issue / run 记录（SQLite 权威 + 导出 log 文件）。
3. Agent **必须**真实改动 `rootPath` 下文件，或产出可验证产物；禁止只回一句聊天。

### 3.2 明确不在 MVP（砍刀表）

| # | 能力 | MVP |
|---|------|-----|
| 1 | Web UI / 桌面 GUI（平台面） | 砍 |
| 2 | 多机 daemon / 远程 runtime | 砍 |
| 3 | Skill 沉淀与复用 | 砍 |
| 4 | 定时 / 自动触发 | 砍 |
| 5 | 多人协作 / 账号 / SSO | 砍 |
| 6 | GitHub/GitLab issue 双向同步 | 砍 |
| 7 | 多 agent 同 issue 协作 | 砍 |
| 8 | 计费 / usage 产品看板 | 砍 |
| 9 | 插件市场 / 第三方 runtime 发现 | 砍 |
| 10 | 人在回路审批（非 YOLO） | 砍 |
| — | 交互 TUI / REPL 内指派 | 砍 |
| — | 上次失败 Run 摘要注入下次 prompt | 砍 |
| — | backlog 状态 | 砍 |
| — | 多用户权限表 | 砍 |
| — | workspace 外路径强制沙箱 | 砍（YOLO；须记录路径） |

---

## 4. 领域对象

### 4.1 Workspace

```text
Workspace = { id, name, rootPath }
```

- Run 的 **cwd / 默认可写根** = `rootPath`。
- 创建时 **`rootPath` 必须已存在**；不自动 `mkdir` 造项目目录。
- MVP **不做** workspace 外强制沙箱；记录 `rootPath` 与 Run 的 cwd。
- 平台元数据 **不**默认写入用户 `rootPath`（不进用户 git）。

### 4.2 Agent

```text
Agent = {
  id,                    // 全局 uuid
  name,                  // 同一 workspace 内唯一
  systemPrompt?,
  model?,
  effort?,
  runtime: "agent-core"  // MVP 仅此
  // 预留扩展位：instructionsPath 等；MVP 不实现 skill 列表
}
```

- **无**独立进程身份；非 online/busy 常驻同事模型。
- MVP 默认继承 agent-core **全套工具**（YOLO）。
- `model` / `effort` 仅覆盖选模与思考档，**不**承载 API Key。

### 4.3 Issue

**状态**：`todo | in_progress | done | cancelled`（无 `backlog`）

**MVP 字段**：

| 字段 | 约束 |
|------|------|
| `title` | 必填 |
| `body` | 必填；兼作目标与验收描述 |
| `assigneeAgentId` | 指派时写入 |

### 4.4 Run

**状态**：`queued | running | succeeded | failed | cancelled`

- 与 Issue **独立**；一次执行一行 Run。
- **重试** = 对同一 Issue **新建 Run**（不原地改写旧 Run）。
- 每次 Run = agent-core **独立新会话**（不沿用上一次 tool history）。

### 4.5 状态机与回写语义

1. 创建 Issue → `todo`。
2. 指派并启动（MVP 同步）：创建 Run（`queued` → 立刻 `running`）；Issue → `in_progress`；写入 `assigneeAgentId`。
3. Run 成功 → Run `succeeded`；Issue `done`；系统评论摘要 + `artifacts[]`。
4. Run 失败或中断 → Run `failed` 或 `cancelled`；**Issue 回到 `todo`**（可再指派）。
5. **系统评论**：仅生命周期（开始 / 结束 / 失败摘要）；**tool 明细只进 run log**。
6. **产物**：Run 记录 `artifacts[]`（路径 + 说明）；不强制 git commit。
7. 人工评论：CLI `issue` 侧可后续加；MVP 以系统评论 + show 为准。

### 4.6 Issue → 模型输入（结构化任务包）

指派启动 Run 时，user 侧使用 **固定 markdown 模板**，至少包含：

- 目标 / 验收（来自 Issue `body`）
- 约束
- `rootPath`
- issue id（及 title）

system = `Agent.systemPrompt`（可空则 agent-core 默认）。

**指派 = 立即创建 Run 并执行**（MVP 不分离「只 assignee 不跑」）。

---

## 5. 持久化与配置

### 5.1 存储

| 项 | 决定 |
|----|------|
| 权威存储 | **SQLite**（用户级 data dir） |
| 可读 log | **每个 Run 一份**导出文件；路径记在 Run 行 |
| data dir | `xharness-platform`（macOS 示例：`~/Library/Application Support/xharness-platform/`） |
| 入库 | DB / log **不进**业务 git 仓库 |
| CLI | 必须提供 `issue show` / `run show`（不只依赖手写 SQL） |
| 权限 | MVP 无多用户权限表 |

### 5.2 模型与密钥

- **完全复用** agent-core 现有 `loadConfig()` / 环境变量约定。
- Agent.`model` / `effort` 可覆盖。
- **缺 key**：不建 Run；CLI **非零退出**并提示。
- workspace / agent / issue 的 **CRUD 不依赖 key**；仅 **执行 Run** 依赖。
- API Key **不得**写入 SQLite 或 run log（注意脱敏）。

### 5.3 运行体验

- 同步执行期间：**stdout 与 run log 双写流式**。
- SIGINT：Run `cancelled`，Issue `todo`。

---

## 6. CLI 规格（`xhp`）

**bin 名**：`xhp`  
**data dir 名**：`xharness-platform`  
README 写明：内部工作名，非 Multica 官方。

### 6.1 最小命令集

```text
xhp workspace create --name <n> --path <existingDir>
xhp workspace list

xhp agent create --workspace <id|name> --name <n> [--model ...] [--effort ...] [--system-prompt ...]
xhp agent list --workspace ...

xhp issue create --workspace ... --title ... --body ...
xhp issue list --workspace ...
xhp issue show <id>
xhp issue assign <issueId> --agent <id|name>   # 立即 Run；同步；流式
xhp issue cancel <id>                          # MVP 要

xhp run show <id>
xhp run log <id>                               # 打印 log 路径或内容
```

### 6.2 引用规则

- CLI 上 **id 与 name 均可引用**（在歧义处优先文档化解析顺序）。
- **agent name** 仅保证 **workspace 内**唯一。

### 6.3 不做

- 交互式 TUI
- REPL 内指派（平台指派只走 `xhp`）

---

## 7. agent-core 集成

| 项 | 决定 |
|----|------|
| 调用方式 | **同进程 import** 库 API（非 spawn CLI 刮输出） |
| cwd | `workspace.rootPath` |
| 事件 | 领域事件驱动 log / stdout；结束时事务性回写 Run / Issue |
| Abort | 与 SIGINT 共用 AbortSignal 语义 |
| 旧入口 | `xharness` bin 保留为 REPL / `-p` 一次性模式 |

---

## 8. 工程纪律

| 项 | 决定 |
|----|------|
| 分支 | feature 分支允许短暂破坏 |
| 合入 main | `tsc --noEmit` + `npm test`（unit）+ `xharness -p` 冒烟 **必须绿** |
| GUI | 仅当改动触及 renderer 时走既有 CDP 验证；纯目录搬迁且 public API 不变时可只做 CLI/单测 |
| 实现未决 | SQLite schema 细表、任务包模板原文、export 函数签名 → **实现阶段**定，不得违背本文语义 |

---

## 9. 目标验收清单（Definition of Done — MVP）

- [ ] `src/agent-core` 与 `src/platform` 目录边界存在；platform 不依赖 UI/REPL
- [ ] agent-core 唯一公开出口；Runner 只经该出口调用
- [ ] `xhp` 命令集可用；data 落在 `xharness-platform`
- [ ] 主闭环一条命令剧本可演示（真 key、真改文件）
- [ ] Issue/Run 状态机与失败/SIGINT 语义符合 §4.5
- [ ] SQLite + per-Run log；`issue show` / `run show` / `run log` 可用
- [ ] 缺 key 时 assign 不建 Run 且非零退出
- [ ] 合入标准：`tsc` + unit + `xharness -p` 冒烟通过
- [ ] README 声明内部工作名、非 Multica 官方

---

## 10. 决策日志（grilling 冻结）

| # | 主题 | 结论 |
|---|------|------|
| 1 | clone 含义 | 产品能力平台，非镜像/非零碎吸收 |
| 2 | 与官方 Multica 代码 | 从零自研协调平面；文档当 PRD |
| 3 | 与 xharness 关系 | 抽出 runtime 内核 + 上层平台；单 monorepo |
| 4 | MVP 主闭环 | workspace → agent → issue 指派 → 真跑 → 可查 |
| 5 | 执行拓扑 | 同步 in-process + Issue/Run 分离 + 可替换 Runner；全局单 Run |
| 6 | Workspace | `{id,name,rootPath}`；已存在路径；YOLO 记路径 |
| 7 | Agent | 配置档案；workspace 内 name 唯一；uuid |
| 8 | 状态机 | Issue 四态 / Run 五态；失败回 todo；无 backlog |
| 9 | 存储 | SQLite + per-Run log；用户级 data dir |
| 10 | 砍刀 | §3.2 全砍项 |
| 11 | 集成 | 同进程库调用；`src/*` 先分目录 |
| 12 | Prompt | 结构化任务包；指派即跑；无失败摘要注入 |
| 13 | 密钥 | 复用 loadConfig/env |
| 14 | CLI | `xhp` + 命令表 + issue cancel |
| 15 | 兼容 | 合 main 三件套绿灯；agent-core 唯一出口 |
| 16 | 收口 | shared understanding 确认；实现另令 |

---

## 11. 非目标声明（防范围回潮）

本文 **不**要求与 Multica 功能对等，**不**要求兼容 Multica 协议或数据格式，**不**授权使用 Multica 商标作为对外产品名。规格来源仅作能力与对象叙事参照；实现与命名归属本仓库产品线（工作名 xhp / xharness-platform）。
