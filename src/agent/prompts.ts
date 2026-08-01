import { spawnSync } from "node:child_process";

export interface SkillSummary {
  name: string;
  description: string;
}

export interface EnvInfo {
  cwd: string;
  platform: string;
  date: string;
  gitStatus: string;
}

export interface BuildSystemPromptOptions extends EnvInfo {
  projectInstructions: string;
  skillSummaries: SkillSummary[];
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.error || result.status !== 0) return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

export function collectEnv(cwd: string): EnvInfo {
  let gitStatus = "";
  const branch = runGit(cwd, ["branch", "--show-current"]);
  if (branch !== null) {
    const status = runGit(cwd, ["status", "--short"]) ?? "";
    const lines = [`分支: ${branch || "(detached)"}`];
    lines.push(status ? `变更:\n${status}` : "工作区干净");
    gitStatus = lines.join("\n");
  }
  return {
    cwd,
    platform: process.platform,
    date: new Date().toISOString().slice(0, 10),
    gitStatus,
  };
}

export function buildSystemPrompt(opts: BuildSystemPromptOptions): string {
  const sections: string[] = [];

  sections.push(
    [
      "你是 xharness，一个运行在用户终端里的 coding agent。你通过调用工具（读写文件、执行命令、搜索代码）来完成用户交给你的编程任务。",
      "",
      "行为规范：",
      "- 动手前先用 Read/Grep/Glob 了解相关代码，再做修改。",
      "- 修改代码后尽量用 Bash 运行测试或命令验证结果。",
      "- 遵循项目现有的代码风格与约定，改动保持最小必要范围。",
      "- 回答简洁直接，不输出无关的客套内容。",
      "- 不确定用户意图时先提问，不要擅自做大范围改动。",
    ].join("\n")
  );

  const envLines = [
    "# 环境信息",
    `工作目录: ${opts.cwd}`,
    `平台: ${opts.platform}`,
    `日期: ${opts.date}`,
  ];
  if (opts.gitStatus) envLines.push(`git 状态:\n${opts.gitStatus}`);
  sections.push(envLines.join("\n"));

  if (opts.projectInstructions) {
    sections.push(`# 项目指令\n${opts.projectInstructions}`);
  }

  if (opts.skillSummaries.length > 0) {
    const list = opts.skillSummaries
      .map((s) => `- ${s.name}: ${s.description}`)
      .join("\n");
    sections.push(`# 可用技能\n${list}`);
  }

  return sections.join("\n\n");
}
