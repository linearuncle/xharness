# SQLite 存储迁移：CDP 验证用例（20260803）

背景：GUI 持久化从 JSONL 四件套（projects.jsonl / settings.jsonl / sessions/*.jsonl / attachments/）
迁移为单库 `xharness.db`（node:sqlite，WAL）。store.js 对外 API 与语义不变。
新架构细节见 docs/storage-sqlite.md。

前置：隔离数据目录 `.xhtest-sqlite-storage`（不污染真实数据；目录内无任何旧 JSONL，视为全新安装）。
启动：`npm run gui:dev -- start --data-dir .xhtest-sqlite-storage --port 0`。

## 用例 1：标准冒烟

- 操作：docs/cdp-testing.md §3 标准冒烟脚本（--data-dir 指向隔离目录）。
- 断言：退出码 0；title=xharness、侧栏/输入区/发送按钮存在、IPC bridge 就绪、CDP 标记 auto。
- 覆盖：基础界面未受存储层改动影响。

## 用例 2：项目 + 会话 + 块持久化（主成功路径）

- 前置：隔离目录内用 store.js 预置一个项目（addProject）。
- 操作：CDP 调 `api.newConversation(projectDir)` → `api.appendBlock(id, {kind:"user",text:"cdp-sqlite"})`
  → `api.openConversation(id)`。
- 断言：newConversation 返回 id；openConversation 的 blocks 含该 user 块；
  `state:get` 的 sidebar 中项目下出现该会话。
- 覆盖：conversations/blocks 表写入与读取路径、sidebarData。

## 用例 3：设置持久化（外观 / 通用 / 供应商 key）

- 操作：`api.setAppearance({mode:"dark", dark:{accent:"#123456"}})`；`api.setGeneral({compactionStrategy:"aggressive"})`；
  `api.upsertProvider({id:"t1",name:"T",baseUrl:"https://example.com",apiKey:"sk-cdp",models:[{id:"m"}]})`。
- 断言：`api.getAppearance()` mode=dark 且 dark.accent=#123456（其余字段默认补齐）；
  `api.getGeneral().compactionStrategy === "aggressive"`；
  `api.getSettings()` 中 t1 `hasKey === true` 且无 apiKey 明文；
  `api.getProviderKey("t1") === "sk-cdp"`。
- 覆盖：kv 表、providers 表、脱敏视图。

## 用例 4：附件 BLOB（粘贴 → xatt:// 展示）

- 操作：`api.savePastedImage(<1x1 png base64>, "png")`；渲染层 `new Image()` 加载
  `xatt://a/<name>`；再请求 `xatt://a/nonexistent.png` 与 `xatt://a/..%2F..%2Fetc%2Fpasswd`。
- 断言：返回 `path` 以 `att:` 开头；Image onload 触发且 naturalWidth=1；
  不存在附件 404；路径穿越 404/400。
- 覆盖：attachments 表写入、xatt:// 协议、安全边界。

## 用例 5：/clear 水位语义（关键边界/回归）

- 操作：会话内先 append 两块（经 `api.send(id, "/clear")` 前手动 appendBlock），
  再 `api.send(id, "/clear")`（slash 内置路径，无需 API key），随后 `api.openConversation(id)`。
- 断言：send 后收到 cleared 事件；openConversation blocks 为空；会话仍存在、标题不变。
- 覆盖：cleared_seq 水位推进，会话 meta 保留。

## 用例 6：重启后全量重放（持久化闭环）

- 操作：`npm run gui:dev -- stop --data-dir ...` 后重新 start，再次读取。
- 断言：用例 2 的会话与块、用例 3 的外观/通用/key、用例 5 的 clear 结果全部仍在；
  sidebar 排序按 updatedAt 倒序。
- 覆盖：load() 重放、懒加载 blocks、WAL 恢复。

## 数据影响与清理

- 全部写入均在隔离目录 `.xhtest-sqlite-storage`，无真实 API 请求（无 key，chat:send 走到
  引擎配置失败即止，块已落库）。验证结束后 stop GUI 并按 §4 清理进程；隔离目录保留供复查。
