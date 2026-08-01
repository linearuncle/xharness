import { describe, expect, it } from "vitest";
import { createTodoWriteTool, type TodoStore } from "../../src/tools/todoWrite.js";
import type { TodoItem } from "../../src/types/tools.js";

function setup() {
  const store: TodoStore = { todos: [] };
  const updates: TodoItem[][] = [];
  const tool = createTodoWriteTool(store, (todos) => updates.push([...todos]));
  return { store, updates, tool };
}

describe("TodoWrite tool", () => {
  it("每次调用整体替换 store.todos 并触发 onUpdate", async () => {
    const { store, updates, tool } = setup();
    const first = await tool.execute({
      todos: [
        { content: "任务一", status: "in_progress" },
        { content: "任务二", status: "pending" },
      ],
    });
    expect(first.isError).toBeUndefined();
    expect(first.content).toContain("2 项");
    expect(store.todos).toHaveLength(2);

    const second = await tool.execute({
      todos: [{ content: "任务一", status: "completed" }],
    });
    expect(second.isError).toBeUndefined();
    expect(store.todos).toEqual([{ content: "任务一", status: "completed" }]);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual([{ content: "任务一", status: "completed" }]);
  });

  it("非法 status 报错且不修改 store、不触发 onUpdate", async () => {
    const { store, updates, tool } = setup();
    await tool.execute({ todos: [{ content: "旧任务", status: "pending" }] });

    const result = await tool.execute({
      todos: [{ content: "坏任务", status: "done" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("status");
    expect(store.todos).toEqual([{ content: "旧任务", status: "pending" }]);
    expect(updates).toHaveLength(1);
  });

  it("todos 非数组或缺少 content 报错", async () => {
    const { tool } = setup();
    const notArray = await tool.execute({ todos: "not-an-array" });
    expect(notArray.isError).toBe(true);
    expect(notArray.content).toContain("array");

    const noContent = await tool.execute({ todos: [{ status: "pending" }] });
    expect(noContent.isError).toBe(true);
    expect(noContent.content).toContain("content");
  });

  it("空数组合法：清空清单", async () => {
    const { store, tool } = setup();
    await tool.execute({ todos: [{ content: "任务", status: "pending" }] });
    const result = await tool.execute({ todos: [] });
    expect(result.isError).toBeUndefined();
    expect(store.todos).toEqual([]);
  });
});
