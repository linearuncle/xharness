# AgentGuard（xharness 内置插件）

移植自 [codex-agentguard](https://github.com/linearuncle/codex-agentguard)（MIT）。
在 Bash 工具执行前拦截常见的文件删除（`rm`/`unlink`/`rmdir`/`find -delete`/
`git clean`/Python 与 Node 的删除 API）与数据库删除 SQL（`DROP`/`TRUNCATE`/
`DELETE FROM`），把决定权交还给用户。

- 威胁模型是"粗心的 agent"，不是"恶意的人"；检测为命令原文的模式匹配，
  误报是有意接受的（拦错的代价只是 agent 停下来问一句）。
- Hook 输入异常按 fail-closed 拒绝。
- 本插件只是额外护栏，不是安全边界，不能替代备份、最小权限与人工审查。

xharness 首次启动会把本插件种子安装到 `~/.agents/plugins/agentguard`；
删除后不会自动复装，可在 GUI 设置 → 插件中管理（启用/禁用/编辑/删除）。
