# xharness GUI

基于 Electron 的图形界面，底层引擎完全复用 xharness（`../dist`）：
Agent 主循环、9 个工具、流式 API 客户端、compact、Skills、thinking 档位。

## 启动

```bash
# 先构建引擎
cd .. && npm install && npm run build

# 启动 GUI（需 API key，DeepSeek key 即可）
cd gui && npm install
ANTHROPIC_API_KEY=你的key npm start
# 或已设置 DEEPSEEK_API_KEY 时直接 npm start（自动映射）
```

## 功能

- **项目/会话**：左侧栏管理多项目多会话（右键会话可置顶/删除）
- **JSONL 持久化**（append-only 事件日志，防崩溃）：
  - `~/Library/Application Support/xharness/sessions/<会话id>.jsonl` —— 首行 meta，此后每行一个消息/工具/notice 块，
    标题与置顶变更以 `meta_update` 行追加，`/clear` 以 `clear` 行追加，启动时重放重建
  - `~/Library/Application Support/xharness/projects.jsonl` —— 项目增删操作日志
- **空态建议卡**：探索 / 构建 / 审查 / 修复 四张卡一键填入
- **流式会话**：文本流式渲染、`已处理 Ns` 计时、工具调用行（已运行/已读取/已编辑…）、
  思考内容折叠展示（点击"已思考"展开）、最终 markdown 渲染
- **AskUserQuestion**：模型提问渲染为可点击选项卡，也可在输入框自由作答
- **TodoWrite**：任务清单实时渲染（☐/■/✔）
- **斜杠命令**：输入 `/` 弹出技能与内置命令（/compact /clear + 项目技能）
- **@ 文件引用**：输入 `@` 模糊搜索项目文件（rg --files）插入路径
- **模型菜单**：按供应商分组的模型列表、推理强度（关闭/低/高/极高）会话内切换
- **设置界面**（侧栏底部 ⚙）：模型供应商管理——默认内置 DeepSeek（不可删）；
  可添加自定义供应商（名称 / Base URL / API Key / 模型列表），API 格式固定 Anthropic Messages；
  API Key **必须手动填写**（可切换明文显示，不读环境变量）；模型条目含模型 ID 与上下文窗口；
  配置持久化于 `~/Library/Application Support/xharness/settings.jsonl`（append-only，与会话数据同规范）
- **上下文条**：项目名 · 本地 · git 分支；右上"环境信息"面板显示变更文件
- **YOLO 提示**：橙色"⚠ 完全访问"徽标——与 CLI 相同，无沙箱、工具直接执行

## 已知限制

- 会话重开后仅以文本种子恢复历史（工具调用细节不回放给模型）
- 同一时间只渲染当前打开会话的事件流
- 中文输入依赖系统 IME；Ctrl+C 中断对应界面上的停止按钮（■）


## ⚠ YOLO 无沙箱模式 —— 风险声明（务必阅读）

GUI 与 CLI 完全一致：模型发起的文件读写与 shell 命令在你的机器上**直接执行，
无确认弹窗、无路径约束、无命令黑名单**。橙色"⚠ 完全访问"徽标即此含义，
首次启动需勾选确认后方可使用。

- 只在可信任务与非关键目录使用；重要数据先做好版本控制/备份
- API Key **明文**存于 `~/Library/Application Support/xharness/settings.jsonl`（权限 600，防同机其他用户）；文件被拷走即泄露
- 附件与粘贴的图片保存在 `~/Library/Application Support/xharness/attachments/`
- 风险自负；威胁模型与漏洞报告见仓库根目录 `SECURITY.md`

## 打包本地安装（macOS）

```bash
cd .. && npm run build     # 先构建引擎
cd gui && npm install      # postinstall 会自动改名 Electron 骨架
node scripts/package-app.mjs
```

产物：`release/xharness.app`（自包含，约 260MB）与分发包 `release/xharness-mac-<arch>.zip`（约 104MB，ditto 打包保留签名）。安装：解压后拖入 /Applications；
ad-hoc 签名，首次打开若被 Gatekeeper 拦截，右键 → 打开。

打包版已**内置 ripgrep**（Resources/bin/rg，MIT/Unlicense 可分发），用户无需 brew 安装。

注意：GUI **不读** shell 环境变量中的 API Key，请在设置中手动填写。
