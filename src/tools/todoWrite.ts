import {
  asRecord,
  toolError,
  type TodoItem,
  type TodoStatus,
  type Tool,
  type ToolResult,
} from "../types/tools.js";

export interface TodoStore {
  todos: TodoItem[];
}

const VALID_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

function parseTodos(raw: unknown): TodoItem[] | string {
  if (!Array.isArray(raw)) {
    return "TodoWrite: `todos` is required and must be an array";
  }
  const todos: TodoItem[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (typeof rec.content !== "string" || rec.content.length === 0) {
      return "TodoWrite: each todo requires a non-empty string `content`";
    }
    if (
      typeof rec.status !== "string" ||
      !VALID_STATUSES.includes(rec.status as TodoStatus)
    ) {
      return `TodoWrite: invalid \`status\` ${JSON.stringify(rec.status)}; must be one of pending, in_progress, completed`;
    }
    todos.push({ content: rec.content, status: rec.status as TodoStatus });
  }
  return todos;
}

export function createTodoWriteTool(
  store: TodoStore,
  onUpdate: (todos: TodoItem[]) => void
): Tool {
  return {
    name: "TodoWrite",
    description:
      "Creates and manages a structured task list for the current session. " +
      "Use it to plan multi-step work and to show the user progress: mark the task you are working on " +
      "as `in_progress` (only one at a time), mark tasks `completed` immediately when done, and keep " +
      "upcoming tasks as `pending`. Each call REPLACES the entire list, so always send the full updated " +
      "list, not a delta. The list lives in memory for this session only and is rendered to the user " +
      "after every update. Skip this tool for trivial single-step tasks.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The complete task list; each call fully replaces the previous list",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "Short description of the task",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "Current state of the task",
              },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    execute(input: unknown): Promise<ToolResult> {
      const args = asRecord(input);
      const todos = parseTodos(args.todos);
      if (typeof todos === "string") {
        return Promise.resolve(toolError(todos));
      }
      store.todos = todos;
      onUpdate(store.todos);
      const done = todos.filter((t) => t.status === "completed").length;
      return Promise.resolve({
        content: `任务清单已更新：共 ${todos.length} 项，已完成 ${done} 项`,
      });
    },
  };
}
