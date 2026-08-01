import { asRecord, toolError, type Tool, type ToolResult } from "../types/tools.js";
import type { Skill } from "../skills/loader.js";

function availableList(skills: Skill[]): string {
  return skills.map((s) => s.name).join(", ");
}

export function createSkillTool(skills: Skill[]): Tool {
  return {
    name: "Skill",
    description:
      "Invokes a skill by name to retrieve its full instructions. " +
      "Skills are reusable instruction sets for specialized tasks; the available skills " +
      "and their descriptions are listed in the system prompt. " +
      "When a user request matches a skill's description, call this tool with the skill name, " +
      "read the returned instructions carefully, and then follow them to complete the task. " +
      `Available skills: ${availableList(skills) || "(none)"}.`,
    inputSchema: {
      type: "object",
      properties: {
        skill: {
          type: "string",
          description: "The exact name of the skill to invoke",
        },
      },
      required: ["skill"],
    },
    async execute(input: unknown): Promise<ToolResult> {
      const args = asRecord(input);
      const name = args.skill;
      if (typeof name !== "string" || name.length === 0) {
        return toolError(
          "Skill: `skill` is required and must be a non-empty string"
        );
      }
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        return toolError(
          `Skill: unknown skill "${name}". Available skills: ${
            availableList(skills) || "(none)"
          }`
        );
      }
      return { content: skill.body };
    },
  };
}
