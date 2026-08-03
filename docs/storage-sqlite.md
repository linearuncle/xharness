# xharness GUI 存储层：SQLite 架构与细节（2026-08-03 起）

本文是 GUI 应用数据存储的现行架构说明，替代原「append-only JSONL 事件日志」方案
（projects.jsonl / settings.jsonl / sessions/*.jsonl / attachments/ 四件套已废弃，
旧文件不导入、不删除，按零迁移原则视为全新安装）。实现入口：`gui/store.js`
（全部产品数据），附件 IPC 与 `xatt://` 在 `gui/main.js`。

## 1. 方案选型：为什么是 node:sqlite

| 候选 | 结论 | 原因 |
|---|---|---|
| **`node:sqlite`（Node 内置）** | **采用** | 零新增依赖（符合仓库依赖最小化铁律）；同步 API，与原 store.js 同步模型同构，改动最小；WAL/事务/预编译语句全套；Electron 37（Node 22.16）与 Node ≥22.13 均开箱可用（已实测，仅一条 ExperimentalWarning） |
| better-sqlite3 | 否决 | 原生模块，需按 Electron ABI 重编译，打包要 asarUnpack + 重签名，依赖链变重 |
| sql.js / wa-sqlite | 否决 | wasm 全量入库前要先读出整库到内存，写回整库，大历史下不可接受 |

数据库引擎即 SQLite 本体，WAL 模式下的可靠性、原子性、查询能力都是成熟事实；
对 GUI 这种「单进程写、读远多于写、单库几 MB~几百 MB」的负载是杀鸡用牛刀但零成本。

## 2. 文件布局

数据目录不变（`XH_DATA_DIR` 覆盖逻辑、与 Chromium userData 同目录的约定都不变）：

| 情况 | 路径 |
|---|---|
| macOS 默认 | `~/Library/Application Support/xharness/` |
| 非 macOS 默认 | `~/.xharness/gui/` |
| 覆盖 | 环境变量 `XH_DATA_DIR`（多实例 / CDP 并发测试隔离） |

目录内产品数据只有**一个库文件**：

```
xharness/
  xharness.db          # 全部产品数据（权限 600）
  xharness.db-wal      # 运行期 WAL 侧车（600），干净退出时自动 checkpoint 并删除
  xharness.db-shm      # 运行期共享内存侧车（600），同上
  <Chromium userData>  # Cache/Local Storage/DevToolsActivePort 等「室友」，与存储设计无关
```

不再有 `sessions/`、`attachments/`、`projects.jsonl`、`settings.jsonl`、
`models-catalog.json`（模型目录缓存也迁入库内 kv 表）。备份 = 拷一个文件。

## 3. Schema（六张表）

```sql
CREATE TABLE projects (                            -- 侧栏项目名单
  dir TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL                        -- Date.now()；排序：新添加在前
) WITHOUT ROWID;

CREATE TABLE providers (                           -- 模型供应商（含 apiKey/oauth 明文）
  id TEXT PRIMARY KEY,
  pos INTEGER NOT NULL,                            -- 展示顺序（内置种子：deepseek 置顶、grok 压尾）
  data TEXT NOT NULL,                              -- 完整 provider JSON
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE kv (                                  -- 单行 JSON 配置
  key TEXT PRIMARY KEY,                            -- 'appearance' | 'general' | 'modelsCatalog'
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE conversations (                       -- 会话 meta（原 sessions/<id>.jsonl 首行）
  id TEXT PRIMARY KEY,
  project_dir TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,                     -- 最近活动（append/标题/clear 都抬升）
  cleared_seq INTEGER NOT NULL DEFAULT 0           -- /clear 水位：重放只取 seq 更大的块
) WITHOUT ROWID;

CREATE TABLE blocks (                              -- 会话块（原 jsonl 里 meta 之后的每行）
  conv_id TEXT NOT NULL,
  seq INTEGER NOT NULL,                            -- 会话内单调递增（ clear 不清零）
  ts INTEGER NOT NULL,
  data TEXT NOT NULL,                              -- block JSON（含 ts，与原行格式一致）
  PRIMARY KEY (conv_id, seq)
) WITHOUT ROWID;                                   -- 聚簇主键：单会话重放是一次连续范围扫描

CREATE TABLE attachments (                         -- 附件 BLOB（原 attachments/ 目录）
  name TEXT PRIMARY KEY,                           -- paste-<ts>.png / <ts>-<原名>
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
```

- 全部 `WITHOUT ROWID`：主键即聚簇索引，省掉每行 8 字节 rowid 与二级索引回表；
  `blocks` 按 `(conv_id, seq)` 物理相邻，单会话重放 = 一次 range scan。
- 无版本号表、无迁移脚本：零迁移原则不变，破坏性变更按全新项目处理。

## 4. 读写模型

**写：内存镜像 + 同步写穿。** store.js 维持原来的内存态（projects/providers/
appearance/general/会话 meta），每个 mutator 先更新内存，再同步写库
（`node:sqlite` 是同步 API，主进程内无并发交错）。写失败只 `console.error`、
内存优先——与原「append 失败仅打日志」策略逐字一致，不因一次磁盘故障打挂界面。
多行写入（appendBlock 的 block 行 + 会话 updated_at）用 `BEGIN`/`COMMIT` 包成单事务。

**读：启动重放 meta，blocks 懒加载。** `load()` 只读 projects/providers/kv/
conversations 四张 meta 表；某个会话的 blocks 在首次 `getConversation()` 时才
`SELECT ... WHERE conv_id=? AND seq > cleared_seq ORDER BY seq` 载入并缓存。
大历史库不再拖慢冷启动（实测见 §7）。

**PRAGMA**：`journal_mode=WAL`（读不阻塞写，崩溃只丢未 checkpoint 的末尾事务，
库体不易坏）；`synchronous=NORMAL`（WAL 下应用崩溃不丢已提交事务，掉电才可能丢
最后一个 commit）——耐久性与原 `appendFileSync` 相当，写入快一个数量级。

## 5. 旧语义 → 新机制对照（行为等价的关键）

| 原 JSONL | 新机制 | 等价性说明 |
|---|---|---|
| sessions 首行 `kind:"meta"` | conversations 行 | 会话存在性 = meta 行；无 meta 即不存在 |
| `meta_update` 行 | `UPDATE conversations.title` | 「仅标题为默认时可改」判断在内存，与原一致 |
| `clear` 行（文件不缩、日志可考古） | `cleared_seq` 水位推进，**旧 blocks 行保留** | 重放只读水位之后；考古仍可查水位之前的行 |
| blocks 行 `{...block, ts}` | blocks 表 `data`（同格式 JSON）+ `ts` 列 | 重放出的块带 ts，与原重放一致 |
| `updatedAt` = 末行 ts | `updated_at` 列同步抬升 | sidebar 排序规则不变 |
| projects `add`（去重、最新在前）/`remove` | `INSERT OR IGNORE` + `added_at DESC` | 重复添加不动位置，与原 unshift 去重一致 |
| providers upsert/delete | `INSERT ... ON CONFLICT` / `DELETE`；`pos` 保序 | 内存数组顺序 = `ORDER BY pos`；种子 deepseek 置顶、grok 压尾 |
| settings 换 key/oauth/删供应商 → **整文件 rewrite** | 单行 `UPDATE`/`DELETE`，**旧密文随行值一起消失** | 敏感语义保留且更严：不再有任何历史残留窗口 |
| appearance/general 追加行、末行生效 | kv 单行覆盖写 | 「rewrite 必须带上 appearance/general」这个坑整体消失 |
| attachments/ 目录文件 | attachments 表 BLOB | 命名规则不变；xatt:// 按名取 BLOB（见 §6） |
| models-catalog.json 缓存 | kv 表 `modelsCatalog` 行 | TTL/失败静默逻辑不变 |

**零迁移**：旧 JSONL 一律不读取、不转换、不删除。老数据目录首次启动等价于
全新安装（项目/会话/设置需重建）；确认无误后可手动删除旧文件。

## 6. 安全细节

- **明文决策不变**：apiKey/oauth 仍明文（不碰钥匙串的取舍不变），防护手段仍是
  文件权限。`openDb()` 在 schema 写入后对 `xharness.db`、`-wal`、`-shm` 三个文件
  统一 `chmod 600`——侧车文件由 SQLite 在**首次写入时按 umask 创建（不继承主库
  权限，实测为 644）**，而它们只在持库期间存在，故每次开库后立即补 chmod 可全覆盖。
- **脱敏边界不变**：`getProvidersSafe()` 剥离 apiKey/oauth 只带 `hasKey`；
  `settings:getProviderKey` 按 id 取明文回填设置页。
- **附件引用改为不透明令牌**：`attach:save-clipboard` / `attach:pick` 返回
  `path = "att:<入库名>"`（渲染层只当不透明 id 使用，无需改动）；`loadAttachments`
  只接受 `att:` 前缀令牌。`attNameOk()` 校验（等于自身 basename 且非 `.`/`..`）
  与原「必须在受控目录内」等价，防路径穿越。
- **`xatt://` 协议不变**：按附件名从库取 BLOB 返回，仍禁止任意 `file://`；
  不存在 → 404，非法名 → 404/400。

## 7. 性能（实测，M 系列 Mac，Node 22）

| 指标 | 数值 |
|---|---|
| 写入 5000 块（50 会话 × 100 块，每块 200B） | ≈103ms（约 4.8 万块/秒） |
| 冷启动 `load()`（50 会话，仅 meta） | ≈2ms |
| 单会话懒加载 100 块 | ≈0.15ms |
| `sidebarData()` | ≈0.13ms |
| 5MB 附件 BLOB 写+读回 | ≈27ms |

手段：预编译语句全程复用；WAL + NORMAL；聚簇主键范围扫描；meta/块分层懒加载。
原方案每个 appendBlock 都是一次 open-write-close 系统调用，且启动时全量重放
所有会话文件；新方案两项常数级开销都消除。

## 8. 生命周期与已知取舍（沿用，未随本次改变）

- 仍无「删除会话并回收」产品面；`/clear` 只推进水位，旧块保留（与原日志一致）。
- 附件只增不减（无 GC）；库文件体积只增不减（未做自动 VACUUM，需要时可手动
  `sqlite3 xharness.db 'VACUUM;'`）。
- 单实例假设不变：WAL 本身支持多进程读写，但产品不保证多实例共写同一
  `XH_DATA_DIR`，测试隔离约定不变。

## 9. 排障与手工检查

```bash
# 看侧栏与会话
sqlite3 ~/Library/Application\ Support/xharness/xharness.db \
  'SELECT id,title,updated_at FROM conversations ORDER BY updated_at DESC LIMIT 10;'
# 无 sqlite3 CLI 时用仓库自带 Node：
node -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);
console.log(db.prepare("SELECT key,updated_at FROM kv").all())' ~/Library/Application\ Support/xharness/xharness.db
# 查看 /clear 之前的考古块
sqlite3 ... 'SELECT seq,substr(data,1,80) FROM blocks WHERE conv_id=? AND seq<=(SELECT cleared_seq FROM conversations WHERE id=?);'
```

## 10. 本次迁移的验证记录

- **新旧等价**：同一操作序列分别跑旧 `store.js`（git HEAD）与新实现，32 项断言
  全绿（操作返回值 + 写后即读快照 + 模拟重启重放快照逐字段一致；含 clear/
  标题一次性/种子顺序/oauth 沿用/updateProviderModels diff 检测/builtin 删保）。
- **CDP GUI 闭环**：`docs/gui-test-cases/20260803-sqlite-storage.md` 6 用例全过
  （标准冒烟、会话块持久化、设置持久化、附件 xatt 展示与安全边界、/clear、
  重启全量重放）。
- **性能**：§7 实测值。
