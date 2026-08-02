# GOAL: xharness — TypeScript Coding Harness MVP

> 本文件是 GoalBuddy PM 的目标输入。PM 据此维护 `state.yaml` 任务板，
> 派发 Scout（侦察）/ Worker（实现）/ Judge（裁决）完成整个目标。
> 产品决策以本文件为准；本文件未覆盖的产品/架构分歧一律升级 Judge，不得由 Worker 自行决定。

## 1. 目标一句话

用 TypeScript 实现一个可在终端交互使用的 coding agent harness（类 Claude Code 的 MVP），
核心闭环：**模型自主地 读代码 → 改代码 → 跑命令验证**，直到任务完成。

## 2. 硬性技术决策（不可由 Worker/Scout 变更）

| 决策项 | 结论 |
|---|---|
| 语言 / 运行时 | TypeScript，Node.js >= 22（Judge 裁决升级：Glob 工具依赖 Node 22 的 fs.glob），ESM |
| LLM 接口 | 仅 Anthropic Messages API **格式**（用 `@anthropic-ai/sdk`），流式（streaming）输出；端点与模型完全可配，不绑定 Anthropic 官方 |
| 默认端点 | **DeepSeek Anthropic 兼容端点 `https://api.deepseek.com/anthropic`**，可用 `ANTHROPIC_BASE_URL` 环境变量覆盖为官方 Anthropic 或其他兼容端点 |
| 默认模型 | `deepseek-v4-pro`（agentic coding 旗舰），可用 `XHARNESS_MODEL` 环境变量覆盖（如 `deepseek-v4-flash`、claude 系列）。注意旧名 `deepseek-chat`/`deepseek-reasoner` 已于 2026-07 停用，不得使用 |
| API Key | 读 `ANTHROPIC_API_KEY` 环境变量（填 DeepSeek key 即可），缺失时启动报错并提示 |
| 上下文窗口 | 内置模型表：`deepseek-v4-*` 为 1M token，未知模型默认 200K；可用 `XHARNESS_CONTEXT_WINDOW` 环境变量覆盖 |
| 配置读取 | 唯一出口 `src/config.ts` 的 `loadConfig()`：集中读取并校验全部环境变量；其余模块一律禁止直接读 `process.env` |
| 权限模式 | 仅 YOLO：所有工具直接执行，无确认弹窗、无权限系统。**MVP 有意不做任何运行时沙箱**——无路径约束（可读写 cwd 之外，如 `~/.xharness/`）、无命令黑名单；风险自负，README 必须写明（见 §8）。Worker 不得自行添加任何过滤逻辑 |
| CLI 形态 | 终端 REPL 交互（stdin/stdout），入口命令 `xharness`，无 TUI 框架依赖（不用 ink/blessed，用 ANSI 转义即可） |
| 内容搜索 | Grep 工具封装 ripgrep，**`rg` 为硬依赖**：启动时检测，缺失则报错退出并提示安装（`brew install ripgrep`）；**不做纯 JS 回退** |
| 测试框架 | vitest（unit 与 e2e 分 project，见 §6.2） |
| 代码检查 | `tsc --noEmit` 必须通过；不引入 eslint（MVP 不做） |
| 依赖原则 | 最小化。允许：`@anthropic-ai/sdk`、glob/minimatch 类小型库、gray-matter（frontmatter 解析）。禁止：langchain 等重框架。**新增其他依赖必须升级 Judge 批准** |
| 模型名治理 | 模型 ID 以 DeepSeek 官方文档为准；如遇模型下线等变化，修改走 Judge，Worker 不得擅改 |

## 3. 项目结构与模块契约

```
xharness/
├── GOAL.md              # 本文件
├── state.yaml           # GoalBuddy 任务板（PM 维护）
├── package.json         # 含 bin: xharness 与 build / test / test:e2e 脚本
├── tsconfig.json
├── src/
│   ├── index.ts         # CLI 入口：REPL、斜杠命令分发
│   ├── config.ts        # 唯一配置出口 loadConfig()
│   ├── api/
│   │   └── client.ts    # 唯一负责：Messages API 流式调用、重试、错误归一，对外输出领域事件
│   ├── types/
│   │   ├── messages.ts  # Message / ContentBlock / ToolUse / ToolResult / 领域事件类型
│   │   └── tools.ts     # Tool 接口：name、description、inputSchema、execute()
│   ├── agent/
│   │   ├── loop.ts      # Agent 主循环：只做回合编排
│   │   ├── prompts.ts   # 系统提示词组装
│   │   └── compact.ts   # 上下文压缩
│   ├── tools/
│   │   ├── registry.ts  # 只做注册与 schema 导出，不含业务逻辑
│   │   ├── bash.ts  read.ts  write.ts  edit.ts
│   │   ├── grep.ts  glob.ts
│   │   ├── askUserQuestion.ts
│   │   ├── todoWrite.ts
│   │   └── skill.ts     # Skill 元工具（T5 才注册进 registry）
│   ├── skills/
│   │   └── loader.ts    # 技能扫描/加载/注入
│   ├── session/
│   │   └── history.ts   # 消息历史、token 估算（估算器唯一实现处）
│   └── ui/
│       └── render.ts    # 流式渲染、工具调用展示
└── test/                # vitest 测试（unit 与 e2e 分 project）
```

**分层铁律（Worker 违反即任务失败，Judge 审 tranche 时逐条核对）：**

- `agent/loop.ts` 只做回合编排：不直接调用 SDK、不读 `process.env`、不解析流事件、不内联压缩逻辑。
- `api/client.ts` 是唯一接触 `@anthropic-ai/sdk` 与原始流事件的模块，对外输出归一化领域事件：
  `TextDelta | ToolStart | ToolEnd | Error | TurnEnd`。
- `ui/render.ts` 只消费领域事件，禁止解析 Anthropic 原始流。
- 工具只做副作用与结果返回，不感知会话状态。
- 除 `config.ts` 外，任何模块禁止读 `process.env`。

## 4. 功能需求（带验收标准）

### 4.1 核心引擎

- **F1 Agent 主循环** (`src/agent/loop.ts`)
  - 用户输入 → 调 Messages API（带 tools）→ 若响应含 `tool_use` 块则执行工具、
    以 `tool_result` 块回填 → 继续调 API → 循环，直到响应无 `tool_use`（回合结束）。
  - **多 tool_use 并行执行**（2026-08-02 决策变更，原为严格串行）：同一响应内的多个
    `tool_use` 并发执行，`tool_result` 按 tool_use 原顺序回填；单个失败以
    `is_error: true` 回填不影响其余；中断时批内已启动的工具各自响应 signal 收尾，配对保持完整。
  - **上限 200 的精确定义**：单回合内已执行的 tool_use 总次数（不是 API round-trip 数）。
    超限：停止执行、history 完整保留、向用户提示后回到提示符，不算崩溃。
  - 工具执行抛异常时，异常信息作为 `is_error: true` 的 tool_result 回填，循环不崩溃。
  - **Ctrl+C 中断语义**（F18、F11 同此定义）：abort 进行中的 HTTP 流；对进行中的 Bash
    子进程组发 SIGTERM；丢弃未完成的 assistant 输出与未回填的 tool_use；已完成回填的
    tool_result 保留；history 末尾追加一条中断标记；下一轮从干净的用户输入继续。
    AskUserQuestion 等待作答期间 Ctrl+C 同样中断整个回合。
  - 验收：能完成"读 package.json 并告诉我依赖"和"新建一个 hello.ts 并用 node 跑通"两类端到端任务。

- **F2 Anthropic API 对接** (`src/api/client.ts`)
  - 唯一接触 `@anthropic-ai/sdk` 的模块（见 §3 分层铁律）；流式解析在本层完成，
    对外发归一化领域事件；`tool_use` 块聚合完整后才交给 loop 执行。
  - API 错误（429/529/网络）指数退避重试，最多 3 次；错误归一为统一错误类型。
  - 验收：断网/无效 key 场景有清晰报错，不崩溃；单测断言领域事件序列。

- **F3 系统提示词组装** (`src/agent/prompts.ts`)
  - 包含：身份与行为规范、环境信息（cwd、平台、日期、git 状态摘要）、
    项目指令内容、可用技能列表。
  - **注入钩子设计**：项目指令与技能列表通过参数传入
    （`projectInstructions: string`、`skillSummaries: {name, description}[]`）。
    T2 实现时一律传空串/空数组即可通过验收；**T2 禁止内联读取指令文件或扫描技能目录**
    ——真实数据源分别由 T4 的 F12、T5 的 F13 接入此钩子。
  - git 状态摘要获取失败（非 git 仓库等）时静默为空，不抛错。
  - 验收：单测断言各段落均出现在组装结果中，空注入时不含对应段落。

- **F4 上下文压缩 compact** (`src/agent/compaction/`)
  - **可插拔策略架构（2026-08-02 变更）**：压缩算法抽象为 `CompactionStrategy` 接口
    （`id/label/description/shouldCompact/compact`），在 `registry.ts` 注册；统一入口
    `maybeCompact`/`forceCompact`（`compaction/index.ts`）按 `config.compactionStrategy`
    分发，未知/未设 id 回退默认策略（容错不抛错）。**禁止在调用方按策略 id 写特殊分支**；
    新增算法只需实现接口并注册。选择途径：CLI 环境变量 `XHARNESS_COMPACT_STRATEGY`
    （在 `loadConfig()` 校验）；GUI 设置 → 通用 → 上下文压缩策略（settings.jsonl
    `general` 事件持久化，全局生效）。
  - 自动：触发条件归策略自有；手动 `/compact` 随时触发；**自动与手动共用策略的同一
    compact 实现**，禁止两套路径。
  - 压缩产物统一：模型总结的 summary 以**一条带 `[历史摘要]` 前缀标记的 user 消息**注入，
    前缀跨策略共用（切换策略后也能识别既有摘要）。
  - **摘要必须保留：用户已做出的决策（含 AskUserQuestion 的回答）、当前任务状态、已改动的文件清单。**
  - 压缩调用失败（API 错误）：保留原历史、打印警告、本回合不再自动重试（用户可手动 `/compact`）。
  - TodoWrite 清单独立于消息历史，不参与压缩，压缩后仍在。
  - tool_use/tool_result 配对不变量对所有策略生效：切点禁止落在配对中间。
  - 内置策略：
    - `classic`（默认）：估算历史 token（字符数/4 近似，估算器唯一实现在
      `session/history.ts`）超过上下文窗口 80% 自动触发；保留最近 **N=10** 条原始消息，
      其余单次摘要；切点落在配对中间时向旧侧扩窗。
    - `pi`（2026-08-02 新增，移植自 pi-mono `packages/coding-agent/src/core/compaction/`，
      文档 https://pi.dev/docs/latest/compaction）：剩余窗口不足 reserveTokens=16384 时
      自动触发；按 token 预算保留最近 keepRecentTokens=20000 的消息（切点只落在不含
      tool_result 的消息上，可切在 assistant 消息处）；结构化摘要（目标/约束/进度/
      关键决策/后续步骤/关键上下文）；再次压缩时把上次摘要作为底稿**增量更新**而非重新
      总结；从 Read/Write/Edit 工具调用累积读/改文件清单（`<read-files>`/
      `<modified-files>` 标签，跨多次压缩累积）；切点落在回合中间时对回合前缀单独摘要后
      合并（split turn）。未移植：分支摘要（无会话分支）、settings 外部配置（常量即默认）。
    - `grok`（2026-08-02 新增，移植自 xAI grok-build
      `crates/common/xai-grok-compaction` code_compaction 子系统 + `xai-grok-shell`
      宿主接线）：**全量替换（full-replace）**——不留尾部窗口，模型在自身上下文里对
      整个会话做九段式结构化"自我总结"（主要请求/技术概念/文件代码/报错修复/问题排查/
      全部用户消息/待办/当前工作/下一步；对话原样作为上下文，提示词追加为最后一条 user
      消息，区别于 pi 的序列化文本），然后从零重建历史
      `[<user_query> 最后真实用户请求, 尾部占位消息, 摘要载体]`（尾部 = 最后真实用户
      回合之后的 assistant 消息原样 + tool_result 以 "Tool call omitted..." 占位，
      配对不变量不破）；总结请求自身溢出时按 **verbatim → fitted → lossy** 输入阶梯
      降级（fitted 预算 = 窗口 - 32768 掐头保尾不拆配对；lossy 工具块打平成文本后适配
      70% 窗口，溢出按报错文本匹配识别）；清洗后 <500 字符的**退化摘要**按瞬态失败重试
      （总尝试 3 次）；摘要清洗剥 `<analysis>` 草稿、抽 `<summary>` 块、对回显控制
      token 注入零宽空格消毒；真实用户回合识别跳过摘要载体/中断标记；85% 窗口自动触发。
      未移植：two-pass 预触发、自动压缩 sticky 抑制、AGENTS.md/user_info 重注入
      （system prompt 在 history 外每回合重建）、TODO/后台任务 system-reminder
      （TodoWrite 在 history 外存活）。
    - `mimo`（2026-08-02 新增，移植自 MiMo-Code v0.1.9
      `packages/opencode/src/session/` 的 checkpoint.ts/prune.ts/overflow.ts 体系，
      即其"无限上下文"机制）：**检查点 + 本地重建**——用量每跨一档阈值（窗口 ≤200K
      每 20%，≤500K 每 10%，>500K 每 5%，各档 ≤ usable 上限）就把 watermark 之后的
      增量用 LLM 并入九节结构化检查点（活跃意图逐字引用/下一步/会话指令/当前工作/
      文件/发现/报错修复/设计决策/开放笔记，各节 token 预算），**历史不改动**（经
      `CompactResult.notice` 告知，非 warning）；真正溢出（≥ usable = 窗口 - 压缩
      预留 20K - 输出预留 20K）时**零 LLM 调用**本地即时重建：`[检查点转储载体
      （含最近用户输入原文 FIFO 16K/单条 2K 截头留尾 + 续接指令）, 尾窗]`，尾窗
      10K~20K token、至少 5 条含文本消息、从最后一条 assistant 前一条起、配对安全
      向旧侧扩；检查点更新前先 **prune**：最近 2 个用户回合外、累计 40K 保护之外的
      旧工具输出就地置为占位符（可释放 ≥20K 才执行，不动配对结构）。适配：writer
      从并行子代理改为回合前同步调用；检查点存会话内存态（WeakMap<History,State>）
      而非磁盘文件。未移植：任务树/活跃 actor/全局记忆/会话笔记节、writer 失败熔断、
      fork 缓存对齐、无检查点回退 opencode 摘要（本策略溢出时必产出检查点后重建）。
  - 验收：构造超长历史，自动压缩后会话能继续且模型不重复提问已答问题。

### 4.2 内置工具（核心 8 个 + Skill 元工具 1 个，`src/tools/`）

工具总口径：**9 个**——核心工具 8 个（本节 F5-F11b）在 T1/T3 落地；
Skill 元工具 1 个（`skill.ts`，见 F15）在 **T5** 落地。
每个工具：name + description + JSON Schema 输入定义，注册到 `registry.ts`；
registry 从 T1 起即支持追加注册，**禁止为任何工具写特殊分支**。
description 文本是工具质量的核心，须参照 Claude Code 的措辞风格详细撰写。

- **F5 Bash**：执行 shell 命令。超时参数（默认 120s，上限 600s）；stdout+stderr 合并返回；
  输出超 30000 字符则截断中间、保留头尾并标注。
- **F6 Read**：读文件，`cat -n` 风格行号；支持 offset/limit；默认最多 2000 行；
  单行超 2000 字符截断；文件不存在返回明确错误。
- **F7 Write**：新建/覆盖文件，自动创建父目录。
- **F8 Edit**：old_string → new_string 精确替换；old_string 必须在文件中**唯一**匹配，
  0 次或多次匹配都报错（错误信息告知匹配次数）；支持 `replace_all` 参数。
- **F9 Grep**：内容正则搜索，封装 `rg`（硬依赖，见 §2，**不实现 JS 回退**）；
  参数：pattern、path、glob 过滤；返回 文件:行号:内容。
- **F10 Glob**：文件名模式匹配，按修改时间排序返回路径列表。
- **F11 AskUserQuestion**：模型向用户提选择题。参数：question、options（2-4 个，各含 label+description）。
  终端渲染编号选项，用户可输数字选择或直接输入自由文本（等价"Other"）。
  答案作为 tool_result 回填。阻塞等待，无超时；等待期间 Ctrl+C 中断整个回合（见 F1）。
- **F11b TodoWrite**：模型维护当前会话任务清单（内存态，不落盘）。
  参数：todos 数组（content + status: pending/in_progress/completed）。
  每次更新后在终端渲染清单（☐/■/✔ 样式）。
  `/clear` 同步清空清单；不参与 compact（见 F4）。

验收（对每个工具）：vitest 单测覆盖正常路径 + 至少 2 个边界情况（如 Edit 的 0 匹配/多匹配、Read 的不存在文件、Bash 超时）。AskUserQuestion 用 stdin mock 测试。

### 4.3 Skills / 斜杠命令系统（`src/skills/`）

- **F13 Skill 加载器**
  - 扫描目录：`~/.agents/skills/<name>/SKILL.md` 与 `<project>/.agents/skills/<name>/SKILL.md`（项目级覆盖全局同名；2026-08-02 由 `.xharness/` 改为跨 harness 通用的 `.agents/`，与 AGENTS.md 同生态、不自创专属目录名）。
  - frontmatter 兼容 Claude Code 格式：`name`、`description`（用 gray-matter 解析）。
  - 验收：目录不存在时静默跳过；损坏的 frontmatter 打警告不崩溃。
- **F14 用户触发**：REPL 中输入 `/<name> [args]` → 该技能指令体 + args 注入本回合用户消息。
- **F15 模型触发**：技能列表（名称+描述）经 F3 的 `skillSummaries` 注入钩子进入系统提示；
  提供 `Skill` 元工具（`src/tools/skill.ts`）让模型主动调用，
  调用结果为技能指令体全文（作为 tool_result 注入）。
  **该工具 T5 才注册进 registry**；T1-T4 期间 registry 不出现它的任何痕迹。
- **F16 内置命令**（硬编码，优先级高于同名技能）：
  `/compact`（手动压缩）、`/clear`（清空会话历史）、`/help`（列出内置命令+可用技能）、`/exit`（退出）。

### 4.4 会话与交互

- **F17 流式渲染** (`src/ui/render.ts`)
  - **只消费 §3 定义的领域事件**，禁止解析 Anthropic 原始流。
  - 模型文本流式输出；工具调用显示为一行摘要（工具名 + 关键参数，如 `⏺ Bash(npm test)`），
    参数摘要截断至单行 80 字符；执行完显示结果状态行（成功/失败 + 结果摘要首行，同样截断）。
  - 不要求 markdown 渲染（原样输出即可，MVP）。
- **F12 项目指令文件**
  - 启动时读取 cwd 下 `AGENTS.md`（跨 harness 通用标准文件名）经 F3 的
    `projectInstructions` 注入钩子进入系统提示；不存在时回退读取 `CLAUDE.md`；
    都不存在则注入空串。**不自创专属文件名**。
- **F18 REPL 会话**
  - readline 循环；Ctrl+C 中断当前回合（语义以 F1 定义为准，不退出进程）、
    Ctrl+D 或 `/exit` 退出；回合结束后回到提示符，历史保留在会话内（不跨进程持久化）；
    `/clear` 清空消息历史与 Todo 清单。

### 4.5 Thinking / effort（T7 增量，2026-08-01 立项）

- **F19 思考档位与思考内容输出**
  - **档位（就这四档，不多不少）**：`none | low | high | max`。`low/high/max` 对应
    DeepSeek Anthropic 格式参数 `"reasoning": {"effort": "<档位>"}`；`none` 在 client 层
    映射为 Anthropic 官方参数 `"thinking": {"type": "disabled"}` 且不携带 reasoning——
    2026-08-01 实测端点忽略 `reasoning.effort`（none 仍思考、非法值静默接受），而
    `thinking.disabled` 可真正关闭（Judge T7 裁决 b；上游若修复 effort，none 行为
    不受影响）。默认不传任何参数（端点默认 = high）。
  - 配置：`XHARNESS_EFFORT` 环境变量（启动默认）+ `/effort <档位>` 内置命令（会话内切换，
    下一回合生效；无参数时打印当前档位与可选值）。非法值报错列出四档。
  - **明确不做**：`budget_tokens`（DeepSeek 忽略之，不实现）；thinking 块的 history
    回传适配（thinking 内容不入 history，只渲染）。
  - 流式输出 thinking 内容：`api/client.ts` 处理 `thinking_delta` 流事件，新增领域事件
    `ThinkingDelta`（§3 铁律联合类型扩一项）；`ui/render.ts` 以暗色（ANSI dim）渲染
    思考文本，thinking 结束、正文开始时视觉分隔（空行即可）。
  - `reasoning` 参数经 client 层随请求下发；loop 不感知（铁律不变）。
  - `/help` 补 `/effort`；README 补档位说明（含 v4-pro 的 low→high 映射现状）。
  - 验收：单测覆盖——effort 参数按档位正确进请求/默认不传、ThinkingDelta 事件流、
    /effort 切换与非法值；E2E 一例：`/effort none` 与 `high` 下同一问题，none 无思考
    输出、high 有暗色思考段。

### 4.6 插件系统（2026-08-02 立项）

- **F20 插件与 preToolUse hooks**
  - 目录：全局 `~/.agents/plugins/<name>/`（与技能同级的跨 harness 目录）+ 项目
    `.agents/plugins/<name>/`，项目覆盖全局同名；每个插件一个 `plugin.json` 清单
    （name/version/description/enabled/hooks.preToolUse[]）。
  - hook 声明：`{matcher, command, timeout}`——matcher 为对工具名的正则，command 经
    `/bin/sh -c` 执行，可用环境变量 `${PLUGIN_ROOT}`（插件目录）与 `${NODE}`
    （当前 Node 可执行；打包版 GUI 下配合 `ELECTRON_RUN_AS_NODE=1` 让 Electron
    以纯 node 运行脚本，插件因此无需依赖系统 python/node）。
  - **协议兼容 codex/Claude Code**：stdin 收
    `{hook_event_name:"PreToolUse", tool_name, tool_input, cwd}`；stdout 输出
    `{hookSpecificOutput:{permissionDecision:"deny", permissionDecisionReason}}` 即拦截。
    显式 deny、非零退出、超时、spawn 失败 → 拒绝（守护类插件自身故障 fail-closed）；
    正常退出且无裁决输出 → 放行。多 hook 按声明顺序串行，首个 deny 即返回。
  - **分层**：`loop.ts` 只加通用 `preToolUse` 回调挂载点（不感知插件）；deny 转
    `is_error` tool_result 落位，**配对不变量优先**（同 §3 铁律）。插件装载
    （`src/plugins/loader.ts`）与 hook 执行（`hooks.ts`）、安装管理（`install.ts`）
    在 `src/plugins/`，由调用方（CLI createSession / GUI engine 每回合）组装——
    与 compact 同款调用方组装模式。GUI 每回合重新 loadPlugins，设置改动即时生效。
  - **内置插件 agentguard**（`plugins/agentguard/`，移植自
    github.com/linearuncle/codex-agentguard，MIT）：Bash 工具执行前拦截文件删除
    （rm/unlink/rmdir/find -delete/git clean/Python/Node 删除 API）与数据库删除 SQL
    （DROP/TRUNCATE/DELETE FROM），误报有意接受；hook 脚本为零依赖 Node（`${NODE}` 执行）。
    **默认安装**：CLI/GUI 首启种子复制到 `~/.agents/plugins`，`.seeded.json` 标记
    「种过」，用户删除后不复装。
  - **GUI 管理（设置 → 插件，增删改无查）**：列表+详情；新增 = GitHub 仓库
    （`owner/repo` 或 https URL，git clone --depth 1，支持根 plugin.json 或
    `plugins/<name>/plugin.json` 布局）/ 本地目录；删 = 两步确认删目录；改 = 启用/禁用
    开关（写回 plugin.json 的 enabled）+ 清单 textarea 直接编辑（主进程校验 JSON）。
    只管理全局目录；IPC 信任边界：root 路径必须位于全局插件目录内（assertInGlobalDir）。
  - 与 §2「YOLO 无运行时过滤」的关系：插件是**用户自装的可选护栏**，非产品内置
    黑名单；产品默认态的唯一内置插件 agentguard 可一键禁用/删除，YOLO 定位不变。
  - 验收：单测覆盖 loader 解析/覆盖/非法清单、hook deny/超时/非零退出 fail-closed、
    loop 集成配对不变量、agentguard 规则命中与放行、种子安装与删除不复装。

### 4.7 会话用量统计（2026-08-02 立项，参考 pi 的 footer 设计）

- **数据源（分层不破）**：`client.ts` 从原始流 `message_start`/`message_delta` 采集
  usage（Anthropic 命名：input/output/cache_read/cache_creation），流末发
  `usage` 领域事件（含 durationMs = 首个输出增量到流末，估算输出速度用），并随
  `StreamMessageResult.usage` 返回。端点未回报则不发事件。loop 不感知，仅透传 onEvent。
- **聚合在调用方（GUI engine）**：按会话累计 input/output/cacheRead/cacheWrite/费用；
  缓存命中率取**最近一次调用** `cacheRead/(input+cacheRead+cacheWrite)`（pi 同款口径）；
  上下文占用 = 最近一次调用完整 prompt+output 对 contextWindow 占比；compact 的摘要调用
  经 `CompactDeps.onEvent` 一并计入；压缩/清空后上下文按估算值刷新（费用保留，钱已花出）。
- **费用**：模型定价（美元/百万 token：input/output/cacheRead，缓存写按 input 价，
  DeepSeek 语义）存 provider 模型配置 `pricing` 字段，GUI 添加模型弹窗选填；内置
  deepseek-v4-flash/pro 有官方默认价（engine 内 DEFAULT_MODEL_PRICING）。无定价 =
  不累计不显示费用。
- **展示**：composer-bar「完全访问」同行右侧，格式
  `{ctx%}/{窗口} · {N} t/s · 缓存 {N}% · ${cost}`；>70% 橙、>90% 红；tooltip 含
  ↑↓/缓存读写/累计费用明细。设置 → 通用「显示会话统计」开关（`general.showSessionStats`，
  默认开）。
- CLI 暂不展示（领域事件已就绪，接入只是 render 层工作）。
- 验收：单测覆盖 client usage 采集/无 usage 不发事件；实测 DeepSeek Anthropic 端点
  两处 usage 字段均回报（2026-08-02 curl 验证）。

### 4.8 Grok（xAI）OAuth 供应商（2026-08-02 立项，移植自 pi-mono）

- **接入方式**：设备码流程（RFC 8628，移植 pi-mono `packages/ai/src/auth/oauth/xai.ts`
  与 `device-code.ts`），面向 SuperGrok / X Premium 订阅账号，无需 API Key。
  端点：`auth.x.ai/oauth2/device/code` + `/oauth2/token`，client_id 沿用 pi 公开
  客户端（`b1a00492-…`，公共客户端 id 非机密），referrer=xharness（实测接受）。
  流程：申请设备码 → GUI 展示 user_code + 自动开浏览器（验证地址强制 https）→
  RFC 8628 轮询（authorization_pending 续等 / slow_down 加 5s / denied、expired
  终止）→ 凭据 `{access, refresh, expires}` 落盘。
- **API 调用**：api.x.ai 原生支持 Anthropic Messages 格式（实测 `/v1/messages`），
  Base URL `https://api.x.ai`，与既有 client 完全兼容；OAuth access token 走
  `Authorization: Bearer`（`Config.authToken`，client.ts 里 authToken 设置时
  apiKey 传 null）。请求前 token 剩余有效期不足（提前 5 分钟）即用 refresh token
  刷新并落盘（refresh 未轮换时沿用旧值）；刷新失败提示重新登录。
- **存储**：内置供应商 `grok`（`authType:"oauth-xai"`，builtin），oauth 凭据与
  apiKey 同级敏感——明文存 settings.jsonl（既有决策，权限 600），变更走整文件
  重写；IPC 脱敏视图剥离 oauth，仅暴露 hasKey；普通"保存"不携带 oauth 字段时
  沿用已存凭据（防止保存表单清掉登录态）。
- **GUI**：设置 → 模型设置的 Grok 详情页以"账号"登录区替代 API Key 输入
  （登录/重新登录/退出登录 + 设备码展示区）；供应商列表 Grok 行使用 lobehub
  Grok 图标（MIT，currentColor 随主题）。内置模型：grok-4.3（2M 窗口，含官方
  定价 $1.25/$2.5/命中 $0.2）、grok-4.5（2M）、grok-4.1-fast（1M）。
- engine 的 config 拆分：`configMeta`（同步、无鉴权，statsEvent/sessionMeta 用）
  与 `config`（异步、含 resolveAuth）。CLI 不接入 OAuth（环境变量 key 路径不变）。

## 5. Tranche 划分（PM 按序推进，每个 tranche 结束交 Judge 审）

| Tranche | 内容 | 出口标准 |
|---|---|---|
| T0 脚手架 | package.json（含 `bin: xharness`、`build/test/test:e2e` 脚本）、tsconfig、vitest 配置（unit/e2e 分 project）、目录骨架、`config.ts` 的 `loadConfig()` | 空测试通过，`tsc --noEmit` 通过，`xharness` 命令可启动（打印版本即可） |
| T1 工具层 | F5-F10 六个文件/命令工具 + registry（支持追加注册，**不含 Skill 工具**），全部带单测 | 所有工具单测通过 |
| T2 引擎 | F1-F3 + `api/client.ts` + `types/*`（主循环、API 对接、系统提示词），接通 T1 工具；F3 用空注入默认（**不实现 F12/Skills 数据源**） | 端到端冒烟（DeepSeek 端点）：完成一次含工具调用的任务；分层铁律核对通过 |
| T3 交互 | F17 流式渲染、F18 REPL、F11 AskUserQuestion、F11b TodoWrite | 终端可交互完成多步 coding 任务 |
| T4 上下文 | F4 compact（自动+手动）、F12 项目指令文件（接入 F3 注入钩子） | 超长会话压缩后可继续 |
| T5 技能 | F13-F16 Skills 系统 + Skill 元工具注册 + 内置命令 | 自定义技能可被 `/name` 和模型两种方式触发 |
| T7 thinking | F19 思考档位（none/low/high/max）与思考内容流式输出 | /effort 四档可切换；high 下可见暗色思考流，none 下无；单测+E2E 过 |

## 6. 验证方案

### 6.1 静态验证（Worker 每个任务收尾必跑）

```bash
npm run build        # tsc 编译
npx tsc --noEmit     # 类型检查
npm test             # vitest 单测（一律 mock API，不发真实请求）
```

### 6.2 大量端到端 / 集成测试（用 DeepSeek Anthropic 兼容端点）

真实 LLM 参与的测试统一走 DeepSeek 端点（即默认端点，无需覆盖）+ 轻量模型
`deepseek-v4-flash`，成本低、可大量跑，用于 T2 之后每个 tranche 的出口验证与回归：

```bash
export ANTHROPIC_API_KEY=$DEEPSEEK_API_KEY
export XHARNESS_MODEL=deepseek-v4-flash   # E2E 统一用 flash，写入 .env.test
npm run test:e2e
```

- E2E 用例形态：脚本驱动 harness 完成小型 coding 任务（读文件回答、新建并运行脚本、
  Edit 修改函数后跑测试、触发 compact、技能调用等）。
- **可靠性契约**：无 `ANTHROPIC_API_KEY` 时 `test:e2e` 整体 **skip 而非 fail**（本地与 CI 分流）；
  单个用例超时/偶发失败允许自动重跑 1 次；断言优先"产物文件、退出码、文件内容"，
  工具调用序列只断言"包含关键子序列"，**禁止全序列全等指纹**（LLM 输出天然有波动）；
  unit 与 e2e 用 vitest project 分开、CI 分 job，e2e 不阻塞单测合入。
- 每个用例在**独立临时工作目录**（fixture 沙箱）中运行，绝不在 xharness 仓库本身或
  用户目录里跑；用例结束清理临时目录（由测试框架清理，不由被测模型执行）。
- 出口冒烟与第 8 节最终演示同样默认用 DeepSeek 端点；官方 Anthropic 端点 + Claude
  模型仅作为一次性的兼容性验证（确认 `ANTHROPIC_BASE_URL` 覆盖机制可用），可选。

### 6.3 测试安全红线（破坏性防护）

- **测试提示词中禁止要求模型执行破坏性操作**：`rm`/`rm -rf`、`rmdir`、`git reset --hard`、
  `git push`、`git clean`、`chmod`/`chown`、`kill`、`sudo`、写 `/etc`、`> /dev/*` 等一律不出现在用例中。
- E2E 断言层增加**工具调用审计**：每个用例结束后扫描本次全部 Bash 调用记录，
  若命中上述破坏性命令模式则该用例直接判失败（即使任务结果正确）——
  既保护环境，也回归检测模型是否越权。
- 沙箱临时目录用随机路径且不含任何真实项目文件；测试环境变量与用户真实
  `ANTHROPIC_API_KEY` 隔离（用 `.env.test` 注入）。

## 7. 明确不做（Worker 不得顺手实现，发现需求缺口升级 Judge）

- 子代理 / 多代理编排
- MCP 协议
- settings.json 配置体系（Hooks 已由 §4.6 插件系统承载，2026-08-02 解除；
  插件之外不做通用 hooks 配置）
- 权限确认模式（YOLO 之外）
- Plan 模式、git worktree 隔离
- 持久记忆、Artifact、定时任务
- OpenAI 等其他 provider 格式
- markdown 终端渲染、主题、TUI 框架
- 运行时沙箱、路径约束、命令黑名单（YOLO 有意为之，见 §2；测试红线见 §6.3 是测试层的事）

## 8. 完成标准（Judge 审定整个 goal）

1. 六个 tranche 全部通过出口标准；
2. `npm run build`、`npx tsc --noEmit`、`npm test` 全绿，`npm run test:e2e`（DeepSeek 端点）全绿；
3. 端到端演示：在任意真实项目目录运行 `xharness`，让模型完成
   「找到某个函数并修改它，然后跑测试验证」的完整闭环，全程无人工干预（除 AskUserQuestion 作答）；
4. README.md 覆盖：安装（含 ripgrep 依赖）、配置 API key、启动、斜杠命令、技能编写方法、
   **YOLO 无沙箱模式的风险说明**（明确告知所有工具直接执行、无任何运行时防护）。

## 9. 工程约定

- git：每完成一个任务/一组改动即 commit，提交信息用中文简述改动；只 commit 不 push。
- 单文件不超过 500 行，超过即拆分。
- 注释与文档字符串从简；不写"本行做了什么"式注释。
