# xharness GUI

基于 Electron 的图形界面 harness，底层引擎完全复用 xharness（`../dist`）：
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

- **项目/会话**：左侧栏管理多项目多会话（右键会话可置顶/删除），持久化于 `~/.xharness/gui/state.json`
- **空态建议卡**：探索 / 构建 / 审查 / 修复 四张卡一键填入
- **流式会话**：文本流式渲染、`已处理 Ns` 计时、工具调用行（已运行/已读取/已编辑…）、
  思考内容折叠展示（点击"已思考"展开）、最终 markdown 渲染
- **AskUserQuestion**：模型提问渲染为可点击选项卡，也可在输入框自由作答
- **TodoWrite**：任务清单实时渲染（☐/■/✔）
- **斜杠命令**：输入 `/` 弹出技能与内置命令（/compact /clear + 项目技能）
- **@ 文件引用**：输入 `@` 模糊搜索项目文件（rg --files）插入路径
- **模型菜单**：模型（v4-pro / v4-flash）、推理强度（关闭/低/高/极高）会话内切换
- **上下文条**：项目名 · 本地 · git 分支；右上"环境信息"面板显示变更文件
- **YOLO 提示**：橙色"⚠ 完全访问"徽标——与 CLI 相同，无沙箱、工具直接执行

## 已知限制（MVP）

- 会话重开后仅以文本种子恢复历史（工具调用细节不回放给模型）
- 同一时间只渲染当前打开会话的事件流
- 中文输入依赖系统 IME；Ctrl+C 中断对应界面上的停止按钮（■）
