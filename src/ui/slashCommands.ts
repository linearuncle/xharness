import { EFFORT_LEVELS, type EffortLevel } from "../config.js";
import type { Skill } from "../skills/loader.js";

/** 内置命令，优先级高于同名技能 */
export const BUILTIN_COMMANDS = ["help", "clear", "compact", "effort", "exit"] as const;
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
    "  /effort   查看或切换 thinking 档位（none/low/high/max，下一回合生效）",
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

/** /effort 无参：当前档位与可选值 */
export function buildEffortStatusText(current: EffortLevel | undefined): string {
  return [
    `当前 thinking 档位: ${current ?? "未设置（= 端点默认 high）"}`,
    `可选档位: ${EFFORT_LEVELS.join(" | ")}（未设置 = 端点默认 high）`,
    "用法: /effort <档位>（会话内切换，下一回合生效）",
  ].join("\n") + "\n";
}

/** 解析 /effort 的参数；非法值报错并列出四档 */
export function parseEffortArg(
  arg: string
): { ok: true; value: EffortLevel } | { ok: false; error: string } {
  if ((EFFORT_LEVELS as readonly string[]).includes(arg)) {
    return { ok: true, value: arg as EffortLevel };
  }
  return {
    ok: false,
    error: `无效档位: "${arg}"，可选档位：${EFFORT_LEVELS.join(" | ")}\n`,
  };
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
