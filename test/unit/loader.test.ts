import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkills, scanSkillsDir } from "../../src/skills/loader.js";

let root: string;
let globalDir: string;
let projectDir: string;
let warnings: string[];

function writeSkill(base: string, dirName: string, content: string): void {
  const dir = join(base, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xharness-skills-"));
  globalDir = join(root, "global");
  projectDir = join(root, "project");
  warnings = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function load() {
  return loadSkills({
    globalDir,
    projectDir,
    warn: (m) => warnings.push(m),
  });
}

describe("loadSkills", () => {
  it("正常加载：解析 frontmatter 并提取 body", () => {
    writeSkill(
      globalDir,
      "commit",
      [
        "---",
        "name: commit",
        "description: 生成规范的 git 提交",
        "---",
        "",
        "# 提交步骤",
        "先 git status，再 git diff。",
      ].join("\n")
    );
    const skills = load();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("commit");
    expect(skills[0].description).toBe("生成规范的 git 提交");
    expect(skills[0].body).toBe("# 提交步骤\n先 git status，再 git diff。");
    expect(warnings).toEqual([]);
  });

  it("项目级覆盖全局同名技能", () => {
    writeSkill(
      globalDir,
      "deploy",
      "---\nname: deploy\ndescription: 全局部署\n---\n全局版本指令"
    );
    writeSkill(
      projectDir,
      "deploy",
      "---\nname: deploy\ndescription: 项目部署\n---\n项目版本指令"
    );
    const skills = load();
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe("项目部署");
    expect(skills[0].body).toBe("项目版本指令");
  });

  it("两级目录中的不同技能都被加载", () => {
    writeSkill(globalDir, "a", "---\ndescription: 技能A\n---\nA体");
    writeSkill(projectDir, "b", "---\ndescription: 技能B\n---\nB体");
    const skills = load();
    expect(skills.map((s) => s.name).sort()).toEqual(["a", "b"]);
  });

  it("目录不存在时静默返回空列表", () => {
    const skills = load();
    expect(skills).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("损坏的 frontmatter 打警告跳过、不影响其他技能", () => {
    writeSkill(globalDir, "broken", "---\nname: [未闭合\n---\n正文");
    writeSkill(globalDir, "good", "---\ndescription: 正常技能\n---\n正常体");
    const skills = load();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("good");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("broken");
    expect(warnings[0]).toContain("frontmatter 解析失败");
  });

  it("name 缺失时用目录名兜底", () => {
    writeSkill(globalDir, "review", "---\ndescription: 代码审查\n---\n审查指令");
    const skills = load();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("review");
  });

  it("description 缺失时打警告跳过", () => {
    writeSkill(globalDir, "nodesc", "---\nname: nodesc\n---\n正文");
    const skills = load();
    expect(skills).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("description");
  });

  it("无 SKILL.md 的目录被忽略", () => {
    mkdirSync(join(globalDir, "empty"), { recursive: true });
    writeFileSync(join(globalDir, "stray.md"), "not a skill dir");
    const skills = load();
    expect(skills).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("scanSkillsDir", () => {
  it("返回技能（含 file 路径）与警告，不做同名合并", () => {
    writeSkill(globalDir, "good", "---\ndescription: 正常技能\n---\n正常体");
    writeSkill(globalDir, "nodesc", "---\nname: nodesc\n---\n正文");
    const r = scanSkillsDir(globalDir);
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].name).toBe("good");
    expect(r.skills[0].file).toBe(join(globalDir, "good", "SKILL.md"));
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("description");
  });

  it("目录不存在时返回空结果", () => {
    expect(scanSkillsDir(join(root, "missing"))).toEqual({ skills: [], warnings: [] });
  });
});
