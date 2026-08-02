# xAI /v1/responses 实测记录（2026-08-02，GOAL §4.13 配套）

实测环境：GUI settings.jsonl 里已登录的 grok OAuth access token（Bearer），
`POST https://api.x.ai/v1/responses`，`stream:true, store:false`。探针脚本一次性使用，
不落地 token。

## 结论（对方案的影响）

| 验证项 | 结果 | 影响 |
|---|---|---|
| `store:false` | 全部用例 200 接受 | 无状态重放历史可行，按方案实现 |
| 流式事件序列 | `created → in_progress → output_item.added(reasoning) → reasoning_summary_part.added → reasoning_summary_text.delta×N → … → output_item.done → output_item.added(message) → content_part.added → output_text.delta×N → output_text.done → content_part.done → output_item.done → completed` | 与翻译表一致 |
| **thinking 增量事件名** | 实测为 `response.reasoning_summary_text.delta`（非 reasoning_text.delta） | responses.ts 两种都收，正确命中 |
| `reasoning:{effort:"low"/"high"}` | grok-4.3 接受；**grok-4-1-fast 也接受（未 400）** | xAI 已放开该模型的 reasoning 参数；responses.ts 的 400 自动降级保留作兜底 |
| 不传 reasoning | grok-4.3 仍默认推理（reasoning item 照发） | effort none = 端点默认行为，符合预期 |
| function_call 流程 | `output_item.added(function_call) → function_call_arguments.delta → .done → output_item.done → completed` | 与翻译表一致 |
| usage 形状 | `input_tokens` **含** `input_tokens_details.cached_tokens`（实测 193 中 192 命中）；`output_tokens` 含 `output_tokens_details.reasoning_tokens` | cached 拆分逻辑必要且正确；reasoning 按输出计费与引擎一致 |

## 原始样例（压缩后事件序列）

基本文本（grok-4.3，store:false，无 reasoning）：

```
response.created → response.in_progress
→ response.output_item.added(reasoning) → response.reasoning_summary_part.added
→ response.reasoning_summary_text.delta×30 → response.reasoning_summary_text.done
→ response.reasoning_summary_part.done → response.output_item.done
→ response.output_item.added(message) → response.content_part.added
→ response.output_text.delta×2 → response.output_text.done → response.content_part.done
→ response.output_item.done → response.completed
usage: {"input_tokens":199,"input_tokens_details":{"cached_tokens":128},
        "output_tokens":121,"output_tokens_details":{"reasoning_tokens":119},"total_tokens":320}
```

工具调用（grok-4.3，自定义 function 工具）：

```
… reasoning item … → response.output_item.added(function_call)
→ response.function_call_arguments.delta → response.function_call_arguments.done
→ response.output_item.done → response.completed
usage: {"input_tokens":280,"input_tokens_details":{"cached_tokens":192},
        "output_tokens":215,"output_tokens_details":{"reasoning_tokens":202}}
```
