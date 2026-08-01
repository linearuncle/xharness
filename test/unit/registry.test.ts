import { describe, expect, it } from "vitest";
import type { Tool } from "../../src/types/tools.js";
import { createDefaultRegistry, ToolRegistry } from "../../src/tools/registry.js";

function makeTool(name: string): Tool {
  return {
    name,
    description: `dummy tool ${name}`,
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: async () => ({ content: "ok" }),
  };
}

describe("ToolRegistry", () => {
  it("注册后可 get，list 返回 API 形状", () => {
    const registry = new ToolRegistry();
    const tool = makeTool("Dummy");
    registry.register(tool);
    expect(registry.get("Dummy")).toBe(tool);
    expect(registry.get("Nope")).toBeUndefined();
    expect(registry.list()).toEqual([
      {
        name: "Dummy",
        description: "dummy tool Dummy",
        input_schema: { type: "object", properties: {}, required: [] },
      },
    ]);
  });

  it("重名注册抛错", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("Dup"));
    expect(() => registry.register(makeTool("Dup"))).toThrow(/Dup/);
  });

  it("createDefaultRegistry 注册 F5-F10 六个工具，且允许继续追加注册", () => {
    const registry = createDefaultRegistry();
    const names = registry.list().map((entry) => entry.name);
    expect(names).toEqual(["Bash", "Read", "Write", "Edit", "Grep", "Glob"]);
    expect(names).not.toContain("Skill");

    registry.register(makeTool("Extra"));
    expect(registry.get("Extra")).toBeDefined();
    expect(registry.list()).toHaveLength(7);
  });
});
