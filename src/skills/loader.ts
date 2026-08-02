import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";

export interface Skill {
  name: string;
  description: string;
  body: string;
  /** SKILL.md 绝对路径（GUI 设置页展示/打开用；运行时逻辑不依赖） */
  file?: string;
}

export interface LoadSkillsOptions {
  /** 全局技能目录，默认 ~/.agents/skills */
  globalDir?: string;
  /** 项目技能目录，默认 <cwd>/.agents/skills */
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
    file,
  };
}

export interface SkillsScan {
  skills: Skill[];
  warnings: string[];
}

/** 扫描单个技能目录，返回全部有效技能与加载警告（GUI 设置页用，不做同名合并） */
export function scanSkillsDir(root: string): SkillsScan {
  const warnings: string[] = [];
  const skills: Skill[] = [];
  for (const dirName of listSkillDirs(root)) {
    const skill = parseSkillFile(root, dirName, (m) => warnings.push(m));
    if (skill) skills.push(skill);
  }
  return { skills, warnings };
}

/**
 * 扫描全局与项目两级技能目录（<root>/<name>/SKILL.md），
 * 项目级覆盖全局同名技能。
 */
export function loadSkills(opts: LoadSkillsOptions = {}): Skill[] {
  const warn = opts.warn ?? ((message) => console.warn(message));
  const globalDir = opts.globalDir ?? join(homedir(), ".agents", "skills");
  const projectDir =
    opts.projectDir ?? join(opts.cwd ?? process.cwd(), ".agents", "skills");

  const byName = new Map<string, Skill>();
  for (const root of [globalDir, projectDir]) {
    for (const dirName of listSkillDirs(root)) {
      const skill = parseSkillFile(root, dirName, warn);
      if (skill) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}
