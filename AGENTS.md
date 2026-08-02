# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

```bash
npm run build                 # tsc 编译 src/ → dist/（GUI 依赖 dist，改核心后必须重建）
npx tsc --noEmit              # 类型检查
npm test                      # 单测（vitest unit project，API 全 mock，不耗 token）
npx vitest run --project unit test/unit/loop.test.ts   # 跑单个测试文件
npm run test:e2e              # E2E（先 build；需 ANTHROPIC_API_KEY/DEEPSEEK_API_KEY，无 key 整体 skip）
node dist/index.js -p "..."   # CLI 一次性模式（冒烟最快路径）

cd gui && npm start                        # 启动 Electron GUI（dev）
cd gui && node scripts/package-app.mjs     # 打包 release/xharness.app + mac-<arch>.zip
```

杀 GUI 进程用 `pkill -f "MacOS/xharness"`（Electron bundle 已被 postinstall 改名为
xharness.app，匹配 "Electron" 会失手）。GUI 调试：加 `--remote-debugging-port=9223`
后可用原生 WebSocket 直连 CDP 执行 JS（cua 等工具不认自定义 bundle id）。

## 仓库形态

两个交付物，一个引擎：

- **CLI**（`src/` → `dist/`，Node >= 22，ESM）：终端 REPL / `-p` 一次性模式。
- **GUI**（`gui/`，Electron）：**不复制引擎代码**，主进程直接 `import "../dist/..."`。
  改 `src/` 后不 `npm run build`，GUI 看不到变化。

`GOAL.md` 是产品规格（含各条设计决策与变更日期）；`docs/internal/` 是开发过程记录
（GoalBuddy 任务板、评审报告），改代码前有疑义先查 GOAL.md 对应条目。

## 核心架构与硬约束

### 分层铁律（违反即错，评审按此核对）

- `src/api/client.ts` 是**唯一**接触 `@anthropic-ai/sdk` 与原始流事件的模块，对外只发
  归一化领域事件（`text_delta | thinking_delta | tool_start | tool_end | error | turn_end`）。
- `src/agent/loop.ts` 只做回合编排：不碰 SDK、不读 `process.env`、不解析原始流、不内联压缩。
- `src/ui/render.ts` 只消费领域事件。
- `src/config.ts` 的 `loadConfig()` 是全项目**唯一** `process.env` 读取点。
- 工具（`src/tools/`）只做副作用与返回，不感知会话状态；异常一律转 `isError:true` 的
  ToolResult，不外抛。registry 禁止按工具名写特殊分支。

### 不变量：tool_use / tool_result 配对

history 中每个 `tool_use` 必须有配对 `tool_result`，否则官方 Anthropic 端点直接 400。
所有取舍（中断、上限 200 触顶、AskUserQuestion 被 SIGINT/EOF 打断）都用 `is_error`
占位块回填来保住配对——修改 loop/中断路径时此约束优先于其他一切语义。
单测里有 `expectAllToolUsesPaired` 辅助断言，改动相关逻辑必须覆盖。

### 工具执行模型

同一响应内多个 `tool_use` **并行执行**（Promise.all），`tool_result` 按原顺序落位；
单个失败不影响其余；批内已启动的工具在中断时各自响应 AbortSignal 收尾（Bash 对进程组发
SIGTERM）。上限 200 = 单回合已执行 tool_use 总数（非 round-trip 数）。

### 端点与模型

Anthropic 只是 **API 格式**；默认端点是 DeepSeek `https://api.deepseek.com/anthropic`，
默认模型 `deepseek-v4-pro`。thinking 档位（none/low/high/max）：`none` 发
`thinking:{type:"disabled"}`（实测唯一可靠关闭方式），`low/high/max` 透传
`reasoning:{effort}`（DeepSeek 扩展字段，client.ts 中唯一的 `as` 断言处）。
思考内容只渲染、**不入 history**。`budget_tokens` 不实现（DeepSeek 忽略）。

### compact（src/agent/compact.ts）

自动（>80% 窗口）与手动 `/compact` 共用 `doCompact`；保留最近 10 条原始消息，切点若落在
tool_use/tool_result 配对中间则**向旧侧扩窗**（宁多保留不拆对）；摘要以 `[历史摘要]`
前缀 user 消息注入；失败保留原历史不重试。自动触发在调用方层（CLI index / GUI engine），
不在 loop 内。

### 技能与斜杠命令

`~/.agents/skills/<name>/SKILL.md`（全局，跨 harness 通用目录）与项目
`.agents/skills/`（覆盖全局同名）；frontmatter 兼容 Claude Code（name/description）。
内置命令（/help /clear /compact /effort /exit）优先级高于同名技能。技能双触发：
用户 `/<name>`、模型经 `Skill` 元工具。

## GUI 要点（gui/）

- `engine.js` 按会话（convId）维护 History/Registry/供应商选择；**每回合开始
  `process.chdir(projectDir)`**——工具相对路径跟会话项目走，不跟 Electron 启动目录。
- 持久化全部为 **append-only JSONL**，数据目录 `~/Library/Application Support/xharness/`
  （sessions/、projects.jsonl、settings.jsonl、attachments/）。settings.jsonl 权限 600，
  手填 API Key **明文**存储（有意决策：ad-hoc 签名下 safeStorage/钥匙串每次启动弹框，
  已弃用；不要改回钥匙串）。IPC 层脱敏：providers 下发时 key 置空 + `hasKey`，留空保存
  = 保持原 key。
- 安全基线（开源审查后确立，勿回退）：渲染层 markdown 一律过 DOMPurify；CSP 收紧；
  附件走 `xatt://` 受控协议（只按文件名从 attachments 目录取），禁止裸 `file://`；
  projectDir 类 IPC 校验必须为已添加项目。
- Electron 两个易踩的坑：`-webkit-app-region: drag` 区域**不受 z-index 遮挡影响**，
  会吃掉浮层点击（浮层下方不得有 drag 区）；"点击外部关闭菜单"要用 `mousedown` 判定
  （click 阶段若菜单内容已被重建，`contains()` 会误判为外部点击）。
- 打包脚本复制 .app 必须用 `ditto`（cpSync 破坏框架符号链接导致 codesign 失败）；
  打包版内置 ripgrep 于 Resources/bin 并置于 PATH 首位（Finder 启动不继承 shell PATH）。

## 项目约定

- **YOLO 是产品定位**：无确认、无沙箱、无命令黑名单，不要"顺手"加运行时过滤；
  披露靠 README/SECURITY.md/首启确认弹窗。
- **早期零迁移**：数据结构/路径变更一律当全新项目处理，不写迁移与兼容代码。
- E2E 约定（test/e2e/）：DeepSeek + `deepseek-v4-flash`、mkdtemp 沙箱、提示词禁破坏性
  命令且有 `assertNoDestructiveCommands` 审计、断言产物/退出码优先 + 工具子序列
  （禁全序列指纹）、retry 1 次、无 key skip。
- 依赖最小化：运行时仅 `@anthropic-ai/sdk` + `gray-matter`（GUI 另有 marked/dompurify）；
  ripgrep 为硬依赖无 JS 回退；新增依赖需先在 GOAL.md 层面确认。
- **每次改动后必须 git 提交 + 自测**（不要等用户提醒）：
  1. 自测：相关改动至少跑 `npx tsc --noEmit` 与 `npm test`（或触及的单测）；改核心/GUI
     依赖 dist 时先 `npm run build`；能冒烟则 `node dist/index.js -p "..."`。
  2. git：用中文简述提交信息 commit；无远程仓库时只 commit、不 push；`dist/`、`release/` 不入库。
- 单文件不超过 500 行；rg 内容搜索；模型 ID 以 DeepSeek 官方文档为准
  （`deepseek-chat` 等旧名已停用）。
