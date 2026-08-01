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
| 语言 / 运行时 | TypeScript，Node.js >= 20，ESM |
| LLM 接口 | 仅 Anthropic Messages API（官方 `@anthropic-ai/sdk`），流式（streaming）输出 |
| 默认模型 | `claude-sonnet-5`，可用 `XHARNESS_MODEL` 环境变量覆盖 |
| API Key | 读 `ANTHROPIC_API_KEY` 环境变量，缺失时启动报错并提示 |
| 权限模式 | 仅 YOLO：所有工具直接执行，无确认弹窗、无权限系统 |
| CLI 形态 | 终端 REPL 交互（stdin/stdout），入口命令 `xharness`，无 TUI 框架依赖（不用 ink/blessed，用 ANSI 转义即可） |
| 内容搜索 | Grep 工具封装 ripgrep（`rg`），若系统无 `rg` 则回退到纯 JS 实现 |
| 测试框架 | vitest |
| 代码检查 | `tsc --noEmit` 必须通过；不引入 eslint（MVP 不做） |
| 依赖原则 | 最小化。允许：`@anthropic-ai/sdk`、glob/minimatch 类小型库、gray-matter（frontmatter 解析）。禁止：langchain 等重框架 |

## 3. 项目结构约定

```
xharness/
├── GOAL.md              # 本文件
├── state.yaml           # GoalBuddy 任务板（PM 维护）
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts         # CLI 入口：REPL、斜杠命令分发
│   ├── agent/
│   │   ├── loop.ts      # Agent 主循环
│   │   ├── prompts.ts   # 系统提示词组装
│   │   └── compact.ts   # 上下文压缩
│   ├── tools/
│   │   ├── registry.ts  # 工具注册与 schema 导出
│   │   ├── bash.ts  read.ts  write.ts  edit.ts
│   │   ├── grep.ts  glob.ts
│   │   ├── askUserQuestion.ts
│   │   └── todoWrite.ts
│   ├── skills/
│   │   └── loader.ts    # 技能扫描/加载/注入
│   ├── session/
│   │   └── history.ts   # 消息历史、token 估算
│   └── ui/
│       └── render.ts    # 流式渲染、工具调用展示
└── test/                # vitest 测试
```

## 4. 功能需求（带验收标准）

### 4.1 核心引擎

- **F1 Agent 主循环** (`src/agent/loop.ts`)
  - 用户输入 → 调 Messages API（带 tools）→ 若响应含 `tool_use` 块则逐个执行工具、
    以 `tool_result` 块回填 → 继续调 API → 循环，直到响应无 `tool_use`（回合结束）。
  - 单回合工具调用次数上限 200（防失控），超限中断并提示用户。
  - 工具执行抛异常时，异常信息作为 `is_error: true` 的 tool_result 回填，循环不崩溃。
  - 验收：能完成"读 package.json 并告诉我依赖"和"新建一个 hello.ts 并用 node 跑通"两类端到端任务。

- **F2 Anthropic API 对接**
  - 流式：文本增量实时打到终端；`tool_use` 块聚合完整后再执行。
  - API 错误（429/529/网络）指数退避重试，最多 3 次。
  - 验收：断网/无效 key 场景有清晰报错，不崩溃。

- **F3 系统提示词组装** (`src/agent/prompts.ts`)
  - 包含：身份与行为规范、环境信息（cwd、平台、日期、git 状态摘要）、
    项目指令文件内容（见 F12）、可用技能列表（名称+描述）。
  - 验收：单测断言各段落均出现在组装结果中。

- **F4 上下文压缩 compact** (`src/agent/compact.ts`)
  - 自动：估算历史 token（可用字符数/4 近似），超过模型上下文 80% 阈值时自动触发。
  - 手动：`/compact` 命令随时触发。
  - 压缩方式：调用 API 让模型把旧历史总结为一条 summary 消息，保留最近 N 条原始消息。
  - **摘要必须保留：用户已做出的决策（含 AskUserQuestion 的回答）、当前任务状态、已改动的文件清单。**
  - 验收：构造超长历史，自动压缩后会话能继续且模型不重复提问已答问题。

### 4.2 内置工具（8 个，`src/tools/`）

每个工具：name + description + JSON Schema 输入定义，注册到 `registry.ts`，
description 文本是工具质量的核心，须参照 Claude Code 的措辞风格详细撰写。

- **F5 Bash**：执行 shell 命令。超时参数（默认 120s，上限 600s）；stdout+stderr 合并返回；
  输出超 30000 字符则截断中间、保留头尾并标注。
- **F6 Read**：读文件，`cat -n` 风格行号；支持 offset/limit；默认最多 2000 行；
  单行超 2000 字符截断；文件不存在返回明确错误。
- **F7 Write**：新建/覆盖文件，自动创建父目录。
- **F8 Edit**：old_string → new_string 精确替换；old_string 必须在文件中**唯一**匹配，
  0 次或多次匹配都报错（错误信息告知匹配次数）；支持 `replace_all` 参数。
- **F9 Grep**：内容正则搜索，封装 `rg`；参数：pattern、path、glob 过滤；返回 文件:行号:内容。
- **F10 Glob**：文件名模式匹配，按修改时间排序返回路径列表。
- **F11 AskUserQuestion**：模型向用户提选择题。参数：question、options（2-4 个，各含 label+description）。
  终端渲染编号选项，用户可输数字选择或直接输入自由文本（等价"Other"）。
  答案作为 tool_result 回填。阻塞等待，无超时。
- **F11b TodoWrite**：模型维护当前回合任务清单（内存态，不落盘）。
  参数：todos 数组（content + status: pending/in_progress/completed）。
  每次更新后在终端渲染清单（☐/■/✔ 样式）。

验收（对每个工具）：vitest 单测覆盖正常路径 + 至少 2 个边界情况（如 Edit 的 0 匹配/多匹配、Read 的不存在文件、Bash 超时）。AskUserQuestion 用 stdin mock 测试。

### 4.3 Skills / 斜杠命令系统（`src/skills/`）

- **F13 Skill 加载器**
  - 扫描目录：`~/.xharness/skills/<name>/SKILL.md` 与 `<project>/.xharness/skills/<name>/SKILL.md`（项目级覆盖全局同名）。
  - frontmatter 兼容 Claude Code 格式：`name`、`description`（用 gray-matter 解析）。
  - 验收：目录不存在时静默跳过；损坏的 frontmatter 打警告不崩溃。
- **F14 用户触发**：REPL 中输入 `/<name> [args]` → 该技能指令体 + args 注入本回合用户消息。
- **F15 模型触发**：技能列表（名称+描述）注入系统提示；提供 `Skill` 工具让模型主动调用，
  调用结果为技能指令体全文（作为 tool_result 注入）。
- **F16 内置命令**（硬编码，优先级高于同名技能）：
  `/compact`（手动压缩）、`/clear`（清空会话历史）、`/help`（列出内置命令+可用技能）、`/exit`（退出）。

### 4.4 会话与交互

- **F17 流式渲染** (`src/ui/render.ts`)
  - 模型文本流式输出；工具调用显示为一行摘要（工具名 + 关键参数，如 `⏺ Bash(npm test)`）；
    执行完显示结果状态行（成功/失败 + 结果摘要首行）。
  - 不要求 markdown 渲染（原样输出即可，MVP）。
- **F12 项目指令文件**
  - 启动时读取 cwd 下 `XHARNESS.md`（若存在）注入系统提示；同时兼容读取 `CLAUDE.md` 作为回退。
- **F18 REPL 会话**
  - readline 循环；Ctrl+C 中断当前回合（不退出进程）、Ctrl+D 或 `/exit` 退出；
    回合结束后回到提示符，历史保留在会话内（不跨进程持久化）。

## 5. Tranche 划分（PM 按序推进，每个 tranche 结束交 Judge 审）

| Tranche | 内容 | 出口标准 |
|---|---|---|
| T0 脚手架 | package.json、tsconfig、vitest 配置、目录骨架、CI 可跑 `npm run build` `npm test` | 空测试通过，`tsc --noEmit` 通过 |
| T1 工具层 | F5-F10 六个文件/命令工具 + registry，全部带单测 | 所有工具单测通过 |
| T2 引擎 | F1-F3（主循环、API 对接、系统提示词），接通 T1 工具 | 端到端冒烟：真实 API 完成一次含工具调用的任务 |
| T3 交互 | F17 流式渲染、F18 REPL、F11 AskUserQuestion、F11b TodoWrite | 终端可交互完成多步 coding 任务 |
| T4 上下文 | F4 compact（自动+手动）、F12 项目指令文件 | 超长会话压缩后可继续 |
| T5 技能 | F13-F16 Skills 系统 + 内置命令 | 自定义技能可被 `/name` 和模型两种方式触发 |

## 6. 验证命令（Worker 每个任务收尾必跑）

```bash
npm run build        # tsc 编译
npx tsc --noEmit     # 类型检查
npm test             # vitest
```

需要真实 API 的端到端验证仅在 T2/T3 出口做，跑前确认 `ANTHROPIC_API_KEY` 已设置；
单测一律 mock API，不消耗真实 token。

## 7. 明确不做（Worker 不得顺手实现，发现需求缺口升级 Judge）

- 子代理 / 多代理编排
- MCP 协议
- Hooks / settings.json 配置体系
- 权限确认模式（YOLO 之外）
- Plan 模式、git worktree 隔离
- 持久记忆、Artifact、定时任务
- OpenAI 等其他 provider 格式
- markdown 终端渲染、主题、TUI 框架

## 8. 完成标准（Judge 审定整个 goal）

1. 六个 tranche 全部通过出口标准；
2. `npm run build`、`npx tsc --noEmit`、`npm test` 全绿；
3. 端到端演示：在任意真实项目目录运行 `xharness`，让模型完成
   「找到某个函数并修改它，然后跑测试验证」的完整闭环，全程无人工干预（除 AskUserQuestion 作答）；
4. README.md 覆盖：安装、配置 API key、启动、斜杠命令、技能编写方法。

## 9. 工程约定

- git：每完成一个任务/一组改动即 commit，提交信息用中文简述改动；只 commit 不 push。
- 单文件不超过 500 行，超过即拆分。
- 注释与文档字符串从简；不写"本行做了什么"式注释。
