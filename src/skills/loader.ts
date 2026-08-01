import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";

export interface Skill {
  name: string;
  description: string;
  body: string;
}

export interface LoadSkillsOptions {
  /** 全局技能目录，默认 ~/.xharness/skills */
  globalDir?: string;
  /** 项目技能目录，默认 <cwd>/.xharness/skills */
  projectDir?: string;
  cwd?: string;
  warn?: (message: string) => void;
}

function listSkillDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    // 目录不存在等：静默跳过
    return [];
  }
}

function parseSkillFile(
  root: string,
  dirName: string,
  warn: (message: string) => void
): Skill | null {
  const file = join(root, dirName, "SKILL.md");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null; // 无 SKILL.md 的目录不是技能
  }

  let parsed: { data: Record<string, unknown>; content: string };
  try {
    parsed = matter(raw);
  } catch (err) {
    warn(
      `[技能] 跳过 ${file}：frontmatter 解析失败（${
        err instanceof Error ? err.message : String(err)
      }）`
    );
    return null;
  }

  const rawName = parsed.data.name;
  const name =
    typeof rawName === "string" && rawName.trim().length > 0
      ? rawName.trim()
      : dirName;
  const rawDescription = parsed.data.description;
  if (typeof rawDescription !== "string" || rawDescription.trim().length === 0) {
    warn(`[技能] 跳过 ${file}：frontmatter 缺少 description`);
    return null;
  }

  return {
    name,
    description: rawDescription.trim(),
    body: parsed.content.trim(),
  };
}

/**
 * 扫描全局与项目两级技能目录（<root>/<name>/SKILL.md），
 * 项目级覆盖全局同名技能。
 */
export function loadSkills(opts: LoadSkillsOptions = {}): Skill[] {
  const warn = opts.warn ?? ((message) => console.warn(message));
  const globalDir = opts.globalDir ?? join(homedir(), ".xharness", "skills");
  const projectDir =
    opts.projectDir ?? join(opts.cwd ?? process.cwd(), ".xharness", "skills");

  const byName = new Map<string, Skill>();
  for (const root of [globalDir, projectDir]) {
    for (const dirName of listSkillDirs(root)) {
      const skill = parseSkillFile(root, dirName, warn);
      if (skill) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}
