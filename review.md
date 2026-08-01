# GOAL.md 评审报告：xharness Coding Harness 目标文件

**评审对象**：`GOAL.md`（TypeScript coding agent harness MVP 目标输入）  
**评审视角**：严格的可维护性 / 架构健康 / 可执行性审计（适配 GoalBuddy 目标文档，而非已有实现 diff）  
**结论**：**有条件通过（Request Changes）**——文档整体质量高、边界清晰，但存在若干会直接导致实现期「上帝循环 / 边界泄漏 / tranche 依赖打架」的结构性缺口，应先修订再开 T0。

---

## 总评

这份 GOAL 在 GoalBuddy 输入层面已经优于多数「愿景式」文档：

- 硬性技术决策表明确，Worker 不可自行改道。
- 功能带验收标准，tranche 有出口。
- 「明确不做」清单能抑制范围蔓延。
- 测试安全红线（破坏性命令审计、沙箱临时目录）设计成熟。

但作为**实现契约**，它仍偏「功能清单」而非「模块契约」。最大风险不是功能做不完，而是：

1. **核心引擎边界未钉死** → `loop.ts` 极易膨胀成 spaghetti 中枢；
2. **功能编号 / 工具数量 / tranche 依赖自相矛盾** → PM 拆任务与 Worker 实现时会反复升级 Judge；
3. **若干关键行为（中断、并行、压缩参数、上下文窗口）未定义** → 实现期特判丛生。

审批门槛（对照 skill 标准）：**当前未达到 Approve**。不是因为产品方向错，而是因为可见的「code judo」与边界澄清能显著降低后续实现复杂度，却尚未写入目标。

---

## 发现项（按严重度排序）

### P0 — 结构性：API / 消息 / 工具契约层缺失，`loop.ts` 注定成为上帝模块

**现状**：项目结构只有 `agent/loop.ts`、`tools/*`、`session/history.ts`、`ui/render.ts`，没有：

- `src/api/` 或 `src/client/`（Messages API 流式、重试、错误归一）
- `src/types/` 或等价的共享契约（Message / ContentBlock / Tool / ToolResult）
- 工具接口的硬性形状定义

**风险**：F1（主循环）+ F2（流式 API）+ 工具回填 + 流式渲染 + 中断 会全部挤进 `loop.ts`。这正是 coding harness 最常见的维护性塌方路径——分支不是「有点乱」，而是**整类复杂度本可被契约删除却未删**。

**要求写入 GOAL 的硬决策（建议直接加一节「模块契约」）**：

```text
src/
  api/client.ts     # 唯一负责：createMessage stream、重试、错误类型
  types/messages.ts # Message / ContentBlock / ToolUse / ToolResult
  types/tools.ts    # Tool 接口：name, description, inputSchema, execute()
  tools/registry.ts # 只做注册与 schema 导出，不做业务
  agent/loop.ts     # 只做：turn 状态机（user → model → tools → model）
```

**Code judo**：把「流式聚合 tool_use → 执行 → tool_result 回填」收成一个显式 turn state machine（例如 `idle | streaming | executing_tools | done | aborted`），而不是在 loop 里堆 `if`。目标文件应点名「loop 只编排、API 只 IO、tool 只副作用、ui 只渲染」——**不允许跨层泄漏**。

**判定**：结构性 blocker。不补齐则 T2 出口时文件体积与耦合几乎必然失控。

---

### P0 — 工具数量与 Skill 工具口径不一致（实现边界会分叉）

**矛盾点**：

| 位置 | 说法 |
|---|---|
| §4.2 标题 | 「内置工具（**8 个**）」 |
| §4.2 列表 | Bash/Read/Write/Edit/Grep/Glob/AskUserQuestion/TodoWrite = 8 |
| §4.3 F15 | 另提供 **`Skill` 工具** 让模型主动调用 |
| §3 结构 | `tools/` 下列出 8 个文件，**无 `skill.ts`** |
| T1 | 「F5–F10 六个文件/命令工具」——未含 Skill |

**风险**：Worker 会在「Skill 算不算第 9 工具」「schema 放 registry 还是 skills」「T1 还是 T5 注册」之间摇摆；registry 会出现临时 `if (name === 'Skill')` 特判。

**要求**：

1. 明确写死：**内置工具 9 个**，或写「核心工具 8 + Skill 元工具 1」。
2. 结构补 `src/tools/skill.ts`（或明确 Skill 由 `skills/loader` 导出并在 registry 注册，**唯一归属**）。
3. Tranche：Skill 工具注册放在 **T5**，T1 registry 预留扩展点即可，禁止 T1 为 Skill 加特殊分支。

---

### P0 — Tranche 依赖与 F 编号顺序打架（会制造假依赖与重复实现）

**矛盾点**：

1. **F3（T2）** 要求系统提示包含「项目指令文件内容」「可用技能列表」。
2. **F12 项目指令** 却排在 **T4**。
3. **Skills（F13–F16）** 排在 **T5**。
4. 文档叙述顺序是 F11 → F11b → F13… → F17 → **F12** → F18，编号与依赖图不一致。

**风险**：

- T2 Worker 为实现 F3，会「顺手」实现半吊子 CLAUDE.md 读取与空 skills 列表；
- T4/T5 再重写一遍 → 双路径、静默 fallback、边界模糊。

**Code judo（推荐直接改 tranche 表）**：

| 调整 | 做法 |
|---|---|
| 提前最小切片 | T2：`prompts.ts` 只要求**可注入钩子**（`projectInstructions: string`、`skillSummaries: SkillSummary[]`），用空串/空数组即可过单测 |
| F12 归属 | 明确 F12 **实现落在 T4**，但 T2 必须留稳定注入点，禁止 T2 内联读文件 |
| Skills 列表 | T2 系统提示可写死「暂无技能」或空列表；**禁止** T2 扫描 skills 目录 |
| 编号整理 | 重排 F12 到 4.3 之前或按依赖重编号，消除「F12 夹在 F17/F18 之间」 |

**判定**：结构性 blocker。这不是文风问题，是任务图错误。

---

### P1 — 关键控制流未定义，必生 ad-hoc 特判

以下行为 GOAL 点到了名字，但**没有可测试的不变量**，实现时会在 loop / bash / readline 之间散落布尔旗标：

#### 1) Ctrl+C「中断当前回合」

未定义：

- 是否 abort 进行中的 HTTP stream？
- 是否 kill 子进程 Bash？如何 kill（进程组）？
- 已完成的 tool_result 是否保留进 history？
- 中断后 user 消息是留下半截 assistant，还是回滚整 turn？
- 与「工具异常 → is_error tool_result 继续循环」如何区分？

**要求**：增加硬决策，例如：

- 中断 = abort stream + SIGTERM 当前 bash 进程组 + 向 history 写入一条系统可见的 interrupted 标记 + **丢弃未完成 assistant 流**（或明确保留 partial，二选一）；
- 下一轮从干净 user prompt 继续。

#### 2) 同一 response 多个 `tool_use`

写了「逐个执行」，但未写：

- 严格串行是否硬性？
- 某一个失败是否继续执行后续？
- 是否禁止隐式并行（避免 YOLO 下竞态写同一文件）？

**建议硬性规定**：**严格串行，按 API 返回顺序；单个失败仍回填 is_error 并继续执行其余**（与「循环不崩溃」一致）。并写入「明确不做：工具并行执行」。

#### 3) 工具上限 200

- 是「单 turn 内 tool_use 次数」还是「API round-trip 次数」？
- 超限时 history 是否保留？是否算 turn 失败？

写清可测定义，避免 loop 里魔法常量无语义。

---

### P1 — Compact 规格半透明，易做成「能跑但不可靠」的魔法层

F4 已有正确直觉（保留决策 / 任务状态 / 文件清单），但仍缺：

| 缺口 | 为什么重要 |
|---|---|
| 模型上下文窗口大小来源 | 80% 阈值依赖分母；应用 `XHARNESS_CONTEXT_WINDOW` 或按模型表硬编码 |
| 「最近 N 条」的 N | 未定义 → Worker 会拍脑袋 |
| token 估算 | chars/4 可接受，但应标明「估算器单一实现，住在 `session/history.ts`」 |
| summary 消息角色 | `user` / `assistant` / 自定义 system？影响后续 API 合法性 |
| 压缩失败 | API 挂了是跳过、重试还是硬失败？ |
| 与 TodoWrite 内存态关系 | 压缩后 todo 清单是否仍在？是否注入 summary？ |

**Code judo**：把 compact 收成纯函数式流水线：

`History → estimate → maybeSummarize(api) → History'`  

禁止在 loop 里内联压缩分支；`/compact` 与自动压缩共用同一入口。

---

### P1 — Grep「无 rg 回退纯 JS」是 MVP 复杂度税

内容搜索回退等于再实现一个残缺 ripgrep（编码、gitignore、性能、glob）。这与「依赖最小化、MVP」冲突，且会把 `grep.ts` 推向多模式 spaghetti。

**建议（选一写死）**：

1. **推荐**：`rg` 为硬依赖，缺失时启动打印安装提示并禁用 Grep（或进程退出码非零提示）；**删除纯 JS 回退**；
2. 或：回退仅支持「单文件/小目录、无 PCRE」的最小路径，并单独立项，**不得**与 rg 路径共享一堆 `if (useJs)`。

当前写法会鼓励「一个函数两种引擎 + 静默行为差异」——这是典型边界不清。

---

### P1 — YOLO 产品安全边界只写在测试里，未写在运行时契约

§6.3 保护的是**测试环境**，但产品默认「所有工具直接执行」：

- Write/Edit/Bash 是否允许逃出 cwd？
- 是否允许读 `~/.ssh`、写仓库外路径？
- 目标是否声明「MVP 有意不做沙箱，风险自负」？

若有意不做：请在 §2 或 §7 明确 **「无路径沙箱、无命令黑名单（运行时）」**，避免 Worker 自作主张加半套过滤。  
若希望最低护栏：只加 **cwd 约束**（工具路径 resolve 后必须在 project root 下）——这比权限系统小一个数量级，且能删掉大量「要不要拦」的讨论。

**倾向**：MVP 可保持 YOLO，但必须**显式写明**，并在 README 完成标准里要求风险说明。

---

### P2 — 配置面与「硬决策」未形成单一配置模块

分散的环境变量：

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_BASE_URL`
- `XHARNESS_MODEL`
- （E2E）`.env.test`

结构中无 `src/config.ts`。结果往往是到处 `process.env.X`，测试难注入，默认值漂移。

**要求**：增加硬约定——**唯一配置出口** `loadConfig(): Config`，缺 key 在启动时失败；loop/api/tools 禁止直接读 env。

---

### P2 — 流式渲染与 API 事件边界易糊

F17 要求工具行摘要 `⏺ Bash(npm test)`，但未规定：

- 参数摘要截断规则（多长？密钥红线？）；
- stream 事件由谁解析（api 层 vs ui 层）；
- 工具结果「首行摘要」对二进制/多行/JSON 的规则。

**建议**：规定 ui 只消费**已归一的领域事件**（`TextDelta | ToolStart | ToolEnd | Error | TurnEnd`），禁止 ui 解析 Anthropic 原始 SSE。这是防止 render.ts 与 client 双向耦合的关键一刀。

---

### P2 — E2E 作为 tranche 出口：可靠性契约不足

真实 LLM E2E 正确且有价值，但 GOAL 未要求：

- 超时与重试策略（模型偶发失败是否重跑 1 次？）；
- 断言优先「产物文件 / 退出码」，弱依赖「完整 tool 序列」的全等；
- `test:e2e` 在无 key 时 **skip 而非 fail**（本地与 CI 分流）；
- CI 是否默认跑 E2E（成本与 flakiness）。

否则 T2+ 出口会被 flaky 测试绑架，PM 无法稳定推进。

**建议补一句**：单测 mock 必须全绿才可合；E2E 允许标记 `e2e` project，CI 分 job；序列断言用「包含关键工具子序列」而非全序指纹。

---

### P2 — 文件体积与拆分：500 行规则好，但缺「模块职责」配套

「单文件不超过 500 行」比 skill 的 1k 红线更严，很好。  
但若没有 P0 的分层，Worker 会机械切文件（`loop2.ts`）而不减概念数——**移动复杂度 ≠ 删除复杂度**。

GOAL 应强调：**超限先问职责是否混杂，再拆文件**；禁止按行数横向切片。

---

### P3 — 小口径 / 可维护性债（不阻塞，但应顺手修）

1. **F11b 命名**：改为 F11a/F12 重排，或接受并在索引表列出全部 F*，避免任务板漏项。
2. **默认模型名** `deepseek-v4-pro` / `deepseek-v4-flash`：作为硬决策可以，但建议加「以 DeepSeek 当前文档为准；GOAL 变更走 Judge」——避免模型下线后 Worker 擅自改回 `deepseek-chat`。
3. **git 状态摘要**注入系统提示：未定义命令失败（非 git 仓库）时行为——应静默为空，不抛。
4. **AskUserQuestion 阻塞无超时**：合理，但应写明与 Ctrl+C 的交互（中断提问 = 中断 turn）。
5. **TodoWrite 仅内存**：会话 `/clear` 是否清空 todo？应写是。
6. **package `bin` 字段 / 本地 `npx` 启动**：T0 出口应包含 `xharness` 可执行入口，而不仅是目录骨架。
7. **依赖允许列表**：`glob/minimatch 类` 过宽；建议点名允许包或「新增依赖必须 Judge」。
8. **§8 完成标准 #3**「任意真实项目目录」与 §6.2「绝不在真实项目跑 E2E」不冲突，但应标明演示是人工/脚本，不等于 CI E2E。

---

## 做得好的地方（保留，勿在修订中回退）

1. **硬性技术决策表**：语言、API 形状、默认端点、YOLO、无 TUI 框架——决策密度高，适合 GoalBuddy。
2. **明确不做**：子代理、MCP、Hooks、多 provider——正确砍掉了最容易拖垮 MVP 的子系统。
3. **工具 description 质量要求**：点出「参照 Claude Code 措辞」——这是 agent 成功率的隐藏主路径，写进目标是对的。
4. **Edit 唯一匹配语义**：与主流 harness 对齐，边界可测。
5. **测试安全红线 + Bash 审计**：比很多生产原型更严肃；保留并在实现时做成可复用的 `assertNoDestructiveBash(calls)` 纯函数。
6. **Tranche 出口意识**：T0→T5 递进合理（在修好 F12/Skills 依赖之后）。
7. **工程约定**：中文 commit、500 行上限、少注释——与可维护性目标一致。

---

## 建议的「目标层 Code Judo」总览

用更少概念表达同一 MVP：

| 删除 / 推迟 | 用什么代替 |
|---|---|
| Grep 纯 JS 双引擎 | `rg` 硬依赖或显式最小回退独立模块 |
| loop 内联 API/重试/压缩/渲染 | `api` + `types` + turn 状态机 + 领域事件 |
| T2 偷偷实现 F12/Skills | 稳定注入点 + 空默认 |
| Skill 工具口径漂移 | 9 工具 or 8+1 元工具，结构与 T5 对齐 |
| 散落 `process.env` | 唯一 `loadConfig()` |
| 未定义中断/并行/压缩参数 | 写死不变量，消灭特判空间 |

目标不是把 GOAL 写成设计论文，而是：**让 Worker 没有「合理的多种架构」可选**——只剩一种无聊、直接、可测的结构。

---

## 修订清单（合并进 GOAL 即可转 Approve）

### 必须（blocker）

- [ ] 增加「模块契约 / 目录」：`api/client.ts`、`types/*`、`config.ts`；写明 loop 禁止直接碰 SDK 与 env。
- [ ] 统一工具数量与 Skill 工具归属；更新 §3 结构与 T1/T5 边界。
- [ ] 修复 F3 与 F12/Skills 的 tranche 依赖；F 编号按依赖重排或附依赖图。
- [ ] 写死：多 tool_use 串行策略、200 次上限语义、Ctrl+C 中断语义。
- [ ] Compact：上下文窗口来源、N、失败策略、与 history 的唯一入口。

### 应当

- [ ] 砍掉或严格限制 Grep JS 回退。
- [ ] 显式 YOLO 路径/命令无沙箱（或最小 cwd 约束二选一）。
- [ ] E2E：无 key skip、断言策略、与单测 CI 分流。
- [ ] UI 只消费领域事件，不解析原始 SSE。
- [ ] T0 出口含 `bin: xharness` 与脚本 `build/test/test:e2e`。

### 可选

- [ ] 重编号 F* 消除 F11b/F12 乱序。
- [ ] 允许依赖白名单收紧。
- [ ] `/clear` 同步清空 Todo 状态等细节表。

---

## 审批结论

| 项 | 结果 |
|---|---|
| 产品方向与 MVP 切分 | 通过 |
| 作为 GoalBuddy 可执行目标 | **不通过（需修订）** |
| 主要原因 | 核心架构边界未钉死 + 工具/Skill 口径不一致 + tranche 依赖自相矛盾 + 关键控制流不变量缺失 |
| 修订后再审预期 | 补齐「必须」清单后可 **Approve** 开工 T0 |

**一句话**：GOAL 已经选对了要做的产品；现在要做的 code judo 是**删掉实现期的歧义分叉**，让 harness 的骨架在文档里就变得「事后看起来不可避免」，而不是等 `loop.ts` 过 500 行再拆。
