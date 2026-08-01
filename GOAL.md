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
  - **多 tool_use 严格串行**：同一响应含多个 `tool_use` 时按 API 返回顺序逐个执行；
    单个失败以 `is_error: true` 回填后**继续执行其余**；禁止任何形式的工具并行执行。
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

- **F4 上下文压缩 compact** (`src/agent/compact.ts`)
  - 自动：估算历史 token（字符数/4 近似，估算器唯一实现在 `session/history.ts`），
    超过模型上下文窗口（来源见 §2 上下文窗口决策）80% 时自动触发。
  - 手动：`/compact` 命令随时触发；**自动与手动共用同一入口函数**，禁止两套路径。
  - 压缩方式：调用 API 让模型把旧历史总结为 summary，以**一条带 `[历史摘要]` 前缀标记的
    user 消息**注入；保留最近 **N=10** 条原始消息。
  - **摘要必须保留：用户已做出的决策（含 AskUserQuestion 的回答）、当前任务状态、已改动的文件清单。**
  - 压缩调用失败（API 错误）：保留原历史、打印警告、本回合不再自动重试（用户可手动 `/compact`）。
  - TodoWrite 清单独立于消息历史，不参与压缩，压缩后仍在。
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
  - 扫描目录：`~/.xharness/skills/<name>/SKILL.md` 与 `<project>/.xharness/skills/<name>/SKILL.md`（项目级覆盖全局同名）。
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

## 5. Tranche 划分（PM 按序推进，每个 tranche 结束交 Judge 审）

| Tranche | 内容 | 出口标准 |
|---|---|---|
| T0 脚手架 | package.json（含 `bin: xharness`、`build/test/test:e2e` 脚本）、tsconfig、vitest 配置（unit/e2e 分 project）、目录骨架、`config.ts` 的 `loadConfig()` | 空测试通过，`tsc --noEmit` 通过，`xharness` 命令可启动（打印版本即可） |
| T1 工具层 | F5-F10 六个文件/命令工具 + registry（支持追加注册，**不含 Skill 工具**），全部带单测 | 所有工具单测通过 |
| T2 引擎 | F1-F3 + `api/client.ts` + `types/*`（主循环、API 对接、系统提示词），接通 T1 工具；F3 用空注入默认（**不实现 F12/Skills 数据源**） | 端到端冒烟（DeepSeek 端点）：完成一次含工具调用的任务；分层铁律核对通过 |
| T3 交互 | F17 流式渲染、F18 REPL、F11 AskUserQuestion、F11b TodoWrite | 终端可交互完成多步 coding 任务 |
| T4 上下文 | F4 compact（自动+手动）、F12 项目指令文件（接入 F3 注入钩子） | 超长会话压缩后可继续 |
| T5 技能 | F13-F16 Skills 系统 + Skill 元工具注册 + 内置命令 | 自定义技能可被 `/name` 和模型两种方式触发 |

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
- Hooks / settings.json 配置体系
- 权限确认模式（YOLO 之外）
- Plan 模式、git worktree 隔离
- 持久记忆、Artifact、定时任务
- OpenAI 等其他 provider 格式
- markdown 终端渲染、主题、TUI 框架
- 工具并行执行（严格串行，见 F1）
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
