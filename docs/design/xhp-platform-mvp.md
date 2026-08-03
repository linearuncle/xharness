# Design: xhp — Multica 式 Managed Agents 平台 MVP

> 状态：2026-08-03 grilling 冻结（shared understanding）  
> 规格来源：https://multica.ai/docs/zh（产品能力规格，**非**文档站镜像、**非** fork 官方 monorepo）  
> 产品决策以 `GOAL.md` §4.15 为准；本文是设计展开与决策溯源。实现前须读 GOAL 条目。

## 1. 问题与目标

### 1.1 我们要解决什么

现有 **xharness** 是单会话 coding harness（REPL / GUI）：人与一个 agent 在一个
对话里读改代码。Multica 类产品的核心叙事是 **把 coding agent 当同事**：建工作区、
建 agent 配置、用 issue 指派任务、跟进度、查产物。

目标是以 Multica 中文产品文档为规格输入，做 **managed agents 协调平面**，
而不是：

| 非目标 | 说明 |
|---|---|
| 文档站 clone | 不做 multica.ai/docs 信息架构/品牌站 |
| 字面镜像 | 不做爬取/离线导出文档 |
| fork 官方 Multica | 不以 `multica-ai/multica` 代码树为起点 |
| 零碎 feature 吸收 | 不把「挑几条能力塞进现有 REPL」当成终点 |

### 1.2 成功定义（MVP）

在 **CLI 单机** 上演示一条黄金路径：

```
workspace create → agent create → issue create → issue assign
  → 真实 runtime 同步跑完 → issue/run 可查 → 工作区文件有可验证改动
  → run log 可 cat
```

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  xhp CLI（platform 入口）                                     │
│  workspace / agent / issue / run 命令                         │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│  src/platform/                                                │
│  Store(SQLite) · Domain · Runner(iface) · InProcessRunner     │
└───────────────────────────┬─────────────────────────────────┘
                            │ 仅经 agent-core 公开 API
┌───────────────────────────▼─────────────────────────────────┐
│  src/agent-core/（由现有 src 核心迁入/划界）                    │
│  loop · tools · api · config · history · compact …            │
│  现有 bin `xharness` 继续作为 REPL 入口                        │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 与 xharness 的关系（决策 3）

| 决策 | 结论 |
|---|---|
| 物理关系 | **引擎下沉 + 平台上盖**：抽出 loop/tools/api 为 runtime 内核；上层新建任务/workspace/指派 |
| 仓库 | 同一 monorepo；MVP 用 **目录边界** `src/agent-core` + `src/platform`（暂不一次切 `packages/*`） |
| 品牌 | 对外 bin=`xhp`；data dir 名 `xharness-platform`；README 写明内部工作名、非 Multica 官方 |
| 旧产品 | `xharness` bin 保留为 agent-core REPL；合 main 前 `tsc` + `npm test` + `xharness -p` 冒烟须绿 |

### 2.2 分层铁律（平台增量）

在既有 GOAL §3 铁律之上：

1. **platform 禁止** import UI/REPL 细节（`src/ui/*`、index REPL 编排）。
2. **platform 禁止** 直接 import `api` 实现或 SDK；只通过 **agent-core 公开出口**
   （`src/agent-core/index.ts` 或等价唯一 barrel）。
3. **agent-core** 继续：`loadConfig()` 唯一读 env；loop 不碰 SDK/原始流。
4. **Runner** 是可替换接口；MVP 仅 `InProcessRunner`。禁止 CLI 直接
   `指派 = 调 loop`——必须 `createRun(issue) → runner.execute(run) → 回写`。

## 3. 领域模型

### 3.1 Workspace

```
Workspace = { id: uuid, name: string, rootPath: string, createdAt }
```

- Run 的默认 **cwd / 可写根** = `rootPath`。
- **创建时 `rootPath` 必须已存在**（不自动 mkdir）。
- MVP **不做** workspace 外路径强制沙箱（继承 YOLO）；但 Run 记录必须记下
  `rootPath` + 实际 `cwd`。
- 平台元数据 **不** 默认写入用户项目目录（不用 `rootPath/.multica/`）。

### 3.2 Agent（配置档案，非常驻进程）

```
Agent = {
  id: uuid,                 // 全局唯一
  workspaceId,
  name,                     // workspace 内唯一
  systemPrompt?: string,
  model?: string,           // 覆盖 loadConfig 默认
  effort?: string,
  runtime: "agent-core",    // MVP 固定
  instructionsPath?: string // 预留，MVP 可空
}
```

- **无** online/busy、**无** 绑定 daemon 实例。
- MVP 默认继承 agent-core **全套工具**（YOLO）。
- skill 列表 **不** 进入 MVP 关键路径。

### 3.3 Issue

| 字段 | 说明 |
|---|---|
| id | uuid |
| workspaceId | |
| title | 必填 |
| body | 必填；兼作「目标与验收」 |
| status | `todo \| in_progress \| done \| cancelled`（**无 backlog**） |
| assigneeAgentId | 可选 |
| createdAt / updatedAt | |

**状态迁移：**

| 事件 | Issue |
|---|---|
| 创建 | `todo` |
| 指派并启动 Run | `in_progress`，写入 assignee |
| Run succeeded | `done` |
| Run failed / cancelled（含 SIGINT） | 回 `todo`（可再指派） |
| issue cancel | `cancelled` |

### 3.4 Run

| 字段 | 说明 |
|---|---|
| id | uuid |
| issueId / workspaceId / agentId | |
| status | `queued \| running \| succeeded \| failed \| cancelled` |
| cwd | 实际 cwd（默认 rootPath） |
| logPath | 可读 log 文件路径 |
| artifacts[] | `{ path, note? }` |
| startedAt / finishedAt | |
| errorSummary? | 失败摘要（系统评论 + 字段） |

**生命周期：**

1. 指派：`create Run(queued → 立刻 running)`，Issue → `in_progress`。
2. 成功：Run → `succeeded`；Issue → `done`；系统评论 + artifacts。
3. 失败/中断：Run → `failed`/`cancelled`；Issue → `todo`。
4. **重试** = 对同一 Issue **新建 Run**（不原地改写旧 Run）。

**评论：** 系统评论仅生命周期（开始 / 结束 / 失败摘要）。tool 明细只进 run log，
不写 SQLite comment 刷库。人工 `issue comment` 可选，不进 MVP 必做。

### 3.5 并发

- 每 workspace 串行（同时最多 1 Run）。
- MVP **全局** 同时仅 1 Run（整个 xhp 进程），避免未上队列就假装多租户。

## 4. 执行拓扑

### 4.1 Runner 接口（概念）

```ts
interface Runner {
  execute(ctx: {
    run: Run;
    issue: Issue;
    agent: Agent;
    workspace: Workspace;
    signal: AbortSignal;
    onEvent: (e: AgentEvent) => void; // 领域事件 → stdout + log
  }): Promise<{ status: "succeeded" | "failed" | "cancelled"; artifacts: Artifact[] }>;
}
```

- MVP：`InProcessRunner` import agent-core 公开 API，同进程调 loop。
- 演示同步阻塞；目录与接口按「可拔成 worker」预留，**不** 在 MVP 上多进程队列。

### 4.2 指派即跑

`xhp issue assign` = 立即创建 Run 并执行（无「只 assignee 不跑」）。
缺 API key：**不建 Run**，CLI 非零退出并提示（避免污染状态机）。

### 4.3 模型输入（结构化任务包）

每 Run **新会话**（不沿用上一次 Run 的 tool history）。

- `system` = `Agent.systemPrompt`（空则 agent-core 默认）。
- `user` = 固定 markdown 模板，至少含：
  - 目标 / 验收（来自 issue title + body）
  - 约束（含：须在 rootPath 下做出可验证改动，不要只聊天）
  - `rootPath`、`issue id`
- MVP **不做**「上次失败摘要注入」。

### 4.4 流式与取消

- 工具/文本 **一边 stdout 一边写 log**。
- SIGINT：abort runtime → Run `cancelled`，Issue `todo`。

### 4.5 配置与密钥

- 完全复用 agent-core `loadConfig()` / env；**platform 不自建 key store**。
- Agent 上 `model`/`effort` 仅覆盖选模与档位，**不承载 secret**。
- key **不入** SQLite / log（log 注意 redact）。
- workspace/agent/issue 的 CRUD **不依赖** key；仅执行 Run 依赖。

## 5. 持久化

| 层 | 职责 |
|---|---|
| SQLite | 权威：workspaces / agents / issues / runs / comments |
| per-Run 文件 | 纯文本或 JSONL log；路径记在 Run 行 |
| 位置 | 用户级 data dir（macOS：`~/Library/Application Support/xharness-platform/`），不进 git |

CLI 必须提供 `issue show` / `run show` / `run log`，不只依赖手滑 `sqlite3`。
MVP 无多用户权限表。

## 6. CLI 命令面（bin: `xhp`）

```
xhp workspace create --name <n> --path <existingDir>
xhp workspace list
xhp agent create --workspace <id|name> --name <n> [--model ...] [--effort ...] [--system-prompt ...]
xhp agent list --workspace ...
xhp issue create --workspace ... --title ... --body ...
xhp issue list --workspace ...
xhp issue show <id>
xhp issue assign <issueId> --agent <id|name>   # 立即 Run；同步；流式
xhp issue cancel <id>
xhp run show <id>
xhp run log <id>                               # 路径或内容
```

- workspace / agent 在 CLI 上 **id 与 name 均可引用**（agent name 仅 workspace 内唯一）。
- **不要** MVP：交互式 TUI、REPL 内指派。

## 7. 明确不做（MVP）

| # | 能力 | 原因 |
|---|---|---|
| 1 | Web UI / 桌面平台 GUI | 硬约束 CLI；GUI 吞对象模型时间 |
| 2 | 多机 daemon / 远程 runtime | Runner 可替换已预留 |
| 3 | Skill 沉淀与复用 | 主闭环是指派执行 |
| 4 | 定时 / 自动触发 | 无可靠 Run 历史前无意义 |
| 5 | 多人 / 账号 / SSO | 无权限表 |
| 6 | GitHub/GitLab issue 同步 | 先有第一方 Issue |
| 7 | 多 agent 同 issue 协作 | 全局单 Run |
| 8 | 计费 / usage 看板 | Run 可粗记 token，不做产品面 |
| 9 | 插件市场 / 第三方 runtime 发现 | 仅 agent-core |
| 10 | 人在回路审批（非 YOLO） | 与 xharness 定位一致 |

## 8. 工程纪律

| 项 | 约定 |
|---|---|
| 目录 | MVP：`src/agent-core` + `src/platform`；以后可再迁 `packages/*` |
| 合 main | `npx tsc --noEmit` + `npm test` + `xharness -p` 冒烟绿 |
| feature 分支 | 允许短暂破坏；合入前须绿 |
| GUI CDP | 触及 renderer 时再走；纯目录搬迁且 public API 不变可只 CLI/单测 |
| 单文件 | ≤500 行 |
| 依赖 | 新增须 GOAL/Judge；SQLite 驱动选型实现前确认（优先零/少原生依赖） |
| 早期零迁移 | 新 data dir / 新 bin；不为旧平台状态写迁移 |

## 9. 建议落地顺序（非 binding tranche，供 PM 拆任务）

1. **agent-core 划界**：唯一公开出口 + 可被传入 cwd / agent 配置 / abort / onEvent 的 session API。
2. **Store + 领域类型**：SQLite schema、CRUD、状态迁移单测。
3. **InProcessRunner + 任务包模板**：事件 → stdout/log；SIGINT。
4. **xhp CLI**：命令表接通；黄金路径脚本/E2E。
5. **README 片段**：安装、env、演示剧本、与 Multica 无关声明。

### 9.1 黄金路径演示剧本（建议）

在临时目录 `mkdir -p /tmp/xhp-demo && echo 'export function add(a,b){return a}' > /tmp/xhp-demo/math.ts`：

```bash
xhp workspace create --name demo --path /tmp/xhp-demo
xhp agent create --workspace demo --name worker
xhp issue create --workspace demo --title "fix add" \
  --body "修改 math.ts 的 add 使返回 a+b；可用 node -e 验证。"
xhp issue assign <issueId> --agent worker
xhp issue show <issueId>
xhp run log <runId>
# 期望：math.ts 已修正；issue done；log 可 cat
```

## 10. 决策日志（grilling 编号）

| # | 主题 | 选择 |
|---|---|---|
| 1 | clone 语义 | 产品能力 clone（文档当规格） |
| 2 | 代码起点 | 从零自研协调平面（不 fork Multica） |
| 3 | 与 xharness | 引擎下沉 + 平台上盖；CLI 单机 MVP；单 monorepo |
| 4 | MVP 主闭环 | Issue→Agent→结果回写；真 runtime；可 cat 记录；真改文件 |
| 5 | 执行拓扑 | 同步 in-process + Issue/Run 分离 + 可替换 Runner；串行 |
| 6 | Workspace | `{id,name,rootPath}`；已存在路径；无强制沙箱 |
| 7 | Agent | 配置档案；uuid；workspace 内 name 唯一 |
| 8 | 状态机 | Issue 四态 / Run 五态；失败回 todo；无 backlog |
| 9 | 持久化 | SQLite 权威 + per-Run log；用户级 data dir |
| 10 | 砍刀 | Multica 类扩展 1–10 全砍；SIGINT 必做；流式双写；评论生命周期 only |
| 11 | 调 runtime | 同进程 import；`src/agent-core` + `src/platform` |
| 12 | 模型输入 | 结构化任务包；指派即跑；每 Run 新会话 |
| 13 | 密钥 | 复用 loadConfig/env；缺 key 不建 Run |
| 14 | 命名/CLI | `xhp` / `xharness-platform`；命令表已定 |
| 15 | 兼容 | 合 main 绿；全局同时 1 Run |
| 16 | 收口 | shared understanding；实现细节留给落地 |

## 11. 下一步（需用户明确下令）

- 按 TDD 落地 xhp MVP  
- 或先只抽 agent-core 公开 API，不动 platform  
- 或把本节同步进 GoalBuddy `state.yaml` 任务板
