export type Role = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | null;

/** 单次 API 调用的 token 用量（Anthropic 语义：input 不含缓存读写，三者相加为完整 prompt） */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_end"; id: string; name: string; result: string; isError: boolean }
  | { type: "error"; message: string }
  | { type: "turn_end"; reason: "end_turn" | "max_tool_calls" | "interrupted" }
  /** 每次 API 调用流结束时发出；durationMs 为首个输出增量到流结束的耗时（估算输出速度用） */
  | { type: "usage"; usage: Usage; durationMs: number };
