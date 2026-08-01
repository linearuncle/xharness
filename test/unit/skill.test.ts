import { describe, expect, it } from "vitest";
import { createSkillTool } from "../../src/tools/skill.js";
import type { Skill } from "../../src/skills/loader.js";

const skills: Skill[] = [
  { name: "commit", description: "生成提交", body: "提交技能完整指令正文" },
  { name: "review", description: "代码审查", body: "审查技能完整指令正文" },
];

describe("Skill 元工具", () => {
  it("元数据：name 为 Skill、schema 要求 skill 参数、描述列出可用技能", () => {
    const tool = createSkillTool(skills);
    expect(tool.name).toBe("Skill");
    expect(tool.inputSchema.required).toEqual(["skill"]);
    expect(tool.description).toContain("commit");
    expect(tool.description).toContain("review");
  });

  it("命中技能名返回 body 全文", async () => {
    const tool = createSkillTool(skills);
    const result = await tool.execute({ skill: "commit" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("提交技能完整指令正文");
  });

  it("未知技能名返回 is_error 并列出可用技能", async () => {
    const tool = createSkillTool(skills);
    const result = await tool.execute({ skill: "nonexistent" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("nonexistent");
    expect(result.content).toContain("commit");
    expect(result.content).toContain("review");
  });

  it("缺少 skill 参数返回 is_error", async () => {
    const tool = createSkillTool(skills);
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("required");
  });

  it("技能列表为空时未知名报错并标注 (none)", async () => {
    const tool = createSkillTool([]);
    const result = await tool.execute({ skill: "anything" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("(none)");
  });
});
