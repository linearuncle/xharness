# Grok 订阅使用与排错指南

本文面向使用 Grok（xAI）订阅账号的 xharness 用户：如何用 SuperGrok / X Premium
订阅登录、登录态如何维持、凭据存在哪、走的是哪个 API，以及出问题时的排查路径。
内容以 `GOAL.md` §4.8/§4.13、`gui/oauth-xai.js` 与实测记录
`docs/internal/responses-api-verification.md` 为准。

## 1. 前提

- 需要 **SuperGrok 或 X Premium** 订阅账号（普通 X 账号无 API 额度）。
- 无需 API Key：登录用 OAuth 设备码流程（RFC 8628），浏览器里授权一次即可。
- 仅 GUI 支持登录；CLI 不接入 OAuth（CLI 走 `ANTHROPIC_API_KEY` 环境变量路径）。
- 机器需能访问 `auth.x.ai`（登录）与 `api.x.ai`（API 调用）。

## 2. 登录步骤（OAuth 设备码流程）

1. 打开 **设置 → 模型设置**，在供应商列表选 **Grok**。
2. 详情页没有 API Key 输入框，而是「账号」登录区——点 **使用 Grok 账号登录**。
3. 界面显示一个 **user_code**（授权码），同时自动打开浏览器跳到 xAI 验证页
   （验证地址强制 https，防止恶意响应拉起别的程序）。核对页面上的代码与界面
   显示的一致，确认授权。
4. 授权期间 GUI 在后台按 RFC 8628 轮询令牌端点：等待中（`authorization_pending`）
   继续等；服务端要求减速（`slow_down`）自动加 5 秒间隔。授权完成后登录区显示
   「已连接 Grok 账号」。
5. 在聊天窗口的模型菜单里选一个 grok 模型（如 `grok-4.3`）即可开始使用。

中途可点取消；授权被拒、设备码过期（默认有效期 30 分钟）或轮询超时都会终止
本次登录，重新点登录即可。「重新登录」「退出登录」在同一区域。

## 3. token 生命周期与自动刷新

登录成功得到三个值：`access`（访问令牌）、`refresh`（刷新令牌）、`expires`
（过期时刻）。机制如下：

- access token 默认有效期约 1 小时，以 `Authorization: Bearer` 头发送。
- **每次发请求前**检查有效期：剩余不足 5 分钟就用 refresh token 自动换新
  （提前 5 分钟刷新，避免请求中途失效）；新凭据立即落盘。
- xAI 刷新时可能**不轮换** refresh token（响应里省略该字段），此时沿用旧值，
  不影响后续刷新。
- 刷新失败（如 refresh token 被吊销、长期未使用、账号退订）会提示
  「Grok 登录已失效…请到设置中重新登录」，按 §2 重新走一遍登录即可。
- 你不需要手动管理任何 token；唯一需要人工介入的场景就是刷新失败后重新登录。

## 4. 凭据存储与安全说明

- 存储位置：`~/Library/Application Support/xharness/settings.jsonl`
  （macOS；其他平台 `~/.xharness/gui/`），文件权限 **600**（仅本机当前用户可读）。
- **凭据是明文存储的**（oauth 与 API Key 同级敏感）——这是有意决策：ad-hoc 签名
  下用钥匙串/safeStorage 每次启动都会弹授权框。防的是同机其他用户（靠文件权限），
  防不了能读你 home 目录的恶意进程。介意的话请勿在共用电脑上登录。
- 凭据变更（登录/刷新/退出）会**整文件重写** settings.jsonl，不在历史追加行里
  残留旧凭据。
- 渲染进程拿不到凭据：IPC 下发的供应商信息是脱敏视图（剥离 oauth/apiKey，只带
  `hasKey`）；设置页普通「保存」不会清掉登录态（表单不携带 oauth 字段时沿用已存值）。
- 登出 = 凭据从 settings.jsonl 移除；卸载应用不会自动删除该目录，需要的话手动删。

## 5. API 端点：OpenAI Responses（/v1/responses）

grok 模型只支持 OpenAI Response API，xharness 默认已配好，无需手动设置：

- Base URL `https://api.x.ai`，实际请求 `POST /v1/responses`，流式（SSE）。
  （xAI 早年提供过 `/v1/messages` Anthropic 兼容端点，已弃用；老安装见 §7。）
- 每次请求发送**完整会话历史**（`store:false` 无状态模式，不在 xAI 侧留存会话），
  系统提示词走 `instructions` 字段。
- **thinking 档位**：grok 只有 low/high 两档。界面上选「关闭/默认」不显式传
  reasoning（端点按模型默认行为推理）；「低」→ low；「高/Max」→ high。个别模型
  不支持 reasoning 参数时，客户端会自动去掉该参数重试一次，无感。
- **费用与统计**：xAI 回报的 `input_tokens` 包含缓存命中部分（`cached_tokens`），
  xharness 已拆分后按「命中价」计费（设置页模型行的定价徽标来自 models.dev 同步，
  含分层价）。注意 grok 的**推理 token 计入输出 token**，高推理档输出计费会明显
  高于低档位；推理也吃单次回答的 max_output_tokens 预算，极高推理档下长回答可能
  被截断（界面上表现为回答戛然而止），把 thinking 档位调低即可。
- 图片附件会转为 `input_image`（base64 data URL）随消息发送。

## 6. 常见报错与排错

| 现象/报错 | 原因 | 处理 |
|---|---|---|
| 「供应商「Grok」未登录，请到设置中使用 Grok 账号登录」 | 没有凭据（从未登录/已退出/换机） | 设置 → Grok → 登录，§2 |
| 「Grok 登录已失效（…），请到设置中重新登录」 | 自动刷新失败：refresh 被吊销、账号退订、xAI 侧故障 | 先重发一条消息（瞬时故障会再触发刷新）；仍失败则重新登录 |
| 登录页停在「正在申请设备码…」后报错 | 访问不了 `auth.x.ai`（网络/代理） | 检查网络与代理后重试 |
| 浏览器授权了但界面一直转圈 | 轮询仍在等（正常，尤其手机端授权慢）；或点了「slow_down」后间隔变长 | 耐心等；超过设备码有效期（约 30 分钟）会报超时，重新登录 |
| 「授权被拒绝」/「设备码已过期」 | 浏览器里点了拒绝，或拖太久 | 重新走 §2 |
| 发送后报 401/403 | access token 失效且刷新失败，或订阅过期 | 重新登录；确认订阅仍有效 |
| 发送后报 400「unsupported / invalid argument」 | 多半是旧安装 API 格式仍是 Anthropic（见 §7），或模型名已下线 | 按 §7 切换格式；模型列表在设置页「立即同步」刷新 |
| 回答突然中断、戛然而止 | 高推理档下推理 token 耗尽 max_output_tokens | thinking 档位调低再试 |
| 费用比预期高 | 推理 token 计入输出计费；长上下文按分层价升档 | 看输入框上方统计条的 input/output/缓存命中率；高档模型大上下文会触发分层价 |
| 一切正常但没有思考流 | 选了「关闭」或该模型不输出摘要 | 属正常，思考内容只渲染不入历史 |

排错时的自助检查顺序：设置里 Grok 显示「已连接」→ 模型菜单里确实选的是 grok
模型 → 重发一条（触发自动刷新）→ 重新登录 → 查看数据目录 settings.jsonl 里
grok 行的 `apiFormat` 是否为 `openai-responses`（§7）。

## 7. 老安装注意：API 格式需手动切一次

2026-08-02 之前的安装，settings.jsonl 里 grok 供应商的 `apiFormat` 是
`anthropic`（走已弃用的 `/v1/messages`）。xharness 遵循零迁移原则**不会自动改**
你的设置，表现为 grok 请求报错。修复：设置 → Grok 详情 → 「API 格式」下拉改选
**OpenAI Responses (/v1/responses)** → 保存。新安装无此问题（默认已是该格式）。

## 附：实现索引（给需要深挖的人）

- OAuth 设备码流程：`gui/oauth-xai.js`（端点、轮询、刷新全在其中，零依赖）
- 登录态维持/请求前刷新：`gui/engine.js` 的 `resolveAuth`
- Responses 协议客户端：`src/api/responses.ts`（SSE 翻译、usage 拆分、reasoning 降级）
- 实测记录：`docs/internal/responses-api-verification.md`
- 产品规格：`GOAL.md` §4.8（OAuth 供应商）、§4.13（Response API 支持）
