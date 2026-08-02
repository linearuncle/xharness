import type { ToolUseBlock } from "./messages.js";

/** preToolUse hook 的裁决：deny 时该工具调用不执行，reason 以 is_error tool_result 落位 */
export interface PreToolUseDecision {
  behavior: "allow" | "deny";
  reason?: string;
}

export interface PreToolUseContext {
  signal?: AbortSignal;
}

/** loop 只认识这个回调签名，不感知插件的存在（组装在调用方层，同 compact） */
export type PreToolUseHook = (
  toolUse: ToolUseBlock,
  ctx?: PreToolUseContext
) => Promise<PreToolUseDecision>;
