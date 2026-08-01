import type { AgentEvent } from "../types/messages.js";
import type { TodoItem } from "../types/tools.js";

const MAX_SUMMARY_CHARS = 80;

export interface OutputStream {
  write(chunk: string): unknown;
}

export interface RendererStreams {
  stdout?: OutputStream;
  stderr?: OutputStream;
}

export interface Renderer {
  onEvent(event: AgentEvent): void;
}

function truncateLine(text: string, max = MAX_SUMMARY_CHARS): string {
  const oneLine = text.replace(/\r?\n/g, " ");
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return truncateLine(line);
}

export function summarizeInput(input: Record<string, unknown>): string {
  const parts = Object.entries(input).map(([key, value]) => {
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    return `${key}: ${rendered}`;
  });
  return truncateLine(parts.join(", "));
}

export function createRenderer(streams: RendererStreams = {}): Renderer {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  let atLineStart = true;

  const ensureNewline = () => {
    if (!atLineStart) {
      stdout.write("\n");
      atLineStart = true;
    }
  };

  return {
    onEvent(event: AgentEvent): void {
      switch (event.type) {
        case "text_delta":
          if (event.text.length > 0) {
            stdout.write(event.text);
            atLineStart = event.text.endsWith("\n");
          }
          break;
        case "tool_start":
          ensureNewline();
          stdout.write(`⏺ ${event.name}(${summarizeInput(event.input)})\n`);
          break;
        case "tool_end": {
          ensureNewline();
          const mark = event.isError ? "✘" : "✔";
          stdout.write(`  ${mark} ${firstLine(event.result)}\n`);
          break;
        }
        case "error":
          ensureNewline();
          stderr.write(`错误: ${event.message}\n`);
          break;
        case "turn_end":
          ensureNewline();
          if (event.reason === "interrupted") {
            stdout.write("[回合已中断]\n");
          } else if (event.reason === "max_tool_calls") {
            stdout.write("[已达单回合工具调用上限，回合结束]\n");
          }
          break;
      }
    },
  };
}

const TODO_MARKS: Record<TodoItem["status"], string> = {
  pending: "☐",
  in_progress: "■",
  completed: "✔",
};

export function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "（任务清单为空）";
  return todos
    .map((todo) => `${TODO_MARKS[todo.status]} ${todo.content}`)
    .join("\n");
}

export function renderTodos(
  todos: TodoItem[],
  stream: OutputStream = process.stdout
): void {
  stream.write(`${formatTodos(todos)}\n`);
}
