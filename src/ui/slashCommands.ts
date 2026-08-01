import type { Skill } from "../skills/loader.js";

/** 内置命令，优先级高于同名技能 */
export const BUILTIN_COMMANDS = ["help", "clear", "compact", "exit"] as const;
export type BuiltinCommand = (typeof BUILTIN_COMMANDS)[number];

export type SlashDispatch =
  | { kind: "builtin"; command: BuiltinCommand; args: string }
  | { kind: "skill"; skill: Skill; message: string }
  | { kind: "unknown"; command: string };

/**
 * 解析以 / 开头的输入行：内置命令优先于同名技能；
 * 命中技能时组装本回合用户消息（技能 body + 可选附加参数）。
 */
export function dispatchSlash(input: string, skills: Skill[]): SlashDispatch {
  const rest = input.slice(1);
  const spaceIdx = rest.search(/\s/);
  const name = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();

  if ((BUILTIN_COMMANDS as readonly string[]).includes(name)) {
    return { kind: "builtin", command: name as BuiltinCommand, args };
  }

  const skill = skills.find((s) => s.name === name);
  if (skill) {
    const message = args
      ? `${skill.body}\n\n用户附加参数: ${args}`
      : skill.body;
    return { kind: "skill", skill, message };
  }

  return { kind: "unknown", command: name };
}

export function buildHelpText(skills: Skill[]): string {
  const lines = [
    "内置命令：",
    "  /help     显示本帮助",
    "  /clear    清空会话历史与任务清单",
    "  /compact  手动压缩会话历史",
    "  /exit     退出",
  ];
  if (skills.length > 0) {
    lines.push("可用技能（/<名称> [参数] 触发）：");
    for (const s of skills) {
      lines.push(`  /${s.name} — ${s.description}`);
    }
  } else {
    lines.push("暂无已加载技能（技能目录：~/.xharness/skills 与 ./.xharness/skills）。");
  }
  return lines.join("\n") + "\n";
}

export function buildUnknownCommandText(
  command: string,
  skills: Skill[]
): string {
  const base = `未知命令: /${command}`;
  if (skills.length === 0) {
    return `${base}\n输入 /help 查看内置命令。\n`;
  }
  const names = skills.map((s) => `/${s.name}`).join(", ");
  return `${base}\n可用技能: ${names}（输入 /help 查看详情）。\n`;
}
