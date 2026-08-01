export interface JsonSchemaProperty {
  type: string;
  description?: string;
  [key: string]: unknown;
}

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute(input: unknown): Promise<ToolResult>;
}

export function toolError(message: string): ToolResult {
  return { content: message, isError: true };
}

export function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}
