import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  collectEnv,
  loadProjectInstructions,
} from "../../src/agent/prompts.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("buildSystemPrompt", () => {
  const base = {
    cwd: "/work/project",
    platform: "darwin",
    date: "2026-08-01",
    gitStatus: "分支: main\n工作区干净",
  };

  it("完整注入时包含各段落", () => {
    const prompt = buildSystemPrompt({
      ...base,
      projectInstructions: "永远用中文回复",
      skillSummaries: [{ name: "commit", description: "生成规范提交信息" }],
    });

    expect(prompt).toContain("coding agent");
    expect(prompt).toContain("# 环境信息");
    expect(prompt).toContain("/work/project");
    expect(prompt).toContain("darwin");
    expect(prompt).toContain("2026-08-01");
    expect(prompt).toContain("分支: main");
    expect(prompt).toContain("# 项目指令");
    expect(prompt).toContain("永远用中文回复");
    expect(prompt).toContain("# 可用技能");
    expect(prompt).toContain("- commit: 生成规范提交信息");
  });

  it("空注入时省略项目指令与技能段", () => {
    const prompt = buildSystemPrompt({
      ...base,
      gitStatus: "",
      projectInstructions: "",
      skillSummaries: [],
    });

    expect(prompt).not.toContain("# 项目指令");
    expect(prompt).not.toContain("# 可用技能");
    expect(prompt).not.toContain("git 状态");
    expect(prompt).toContain("# 环境信息");
  });
});

describe("loadProjectInstructions", () => {
  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "xharness-instr-"));
    tempDirs.push(dir);
    return dir;
  }

  it("AGENTS.md 优先于 CLAUDE.md", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "AGENTS.md"), "agents 指令");
    writeFileSync(join(dir, "CLAUDE.md"), "claude 指令");
    expect(loadProjectInstructions(dir)).toBe("agents 指令");
  });

  it("无 AGENTS.md 时回退读 CLAUDE.md", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "CLAUDE.md"), "claude 指令");
    expect(loadProjectInstructions(dir)).toBe("claude 指令");
  });

  it("两者都不存在时返回空串", () => {
    expect(loadProjectInstructions(makeDir())).toBe("");
  });

  it("目录本身不存在（读取失败）时静默返回空串", () => {
    expect(loadProjectInstructions(join(makeDir(), "不存在的子目录"))).toBe("");
  });
});

describe("collectEnv", () => {
  it("返回 cwd/platform/date", () => {
    const dir = mkdtempSync(join(tmpdir(), "xharness-env-"));
    tempDirs.push(dir);
    const env = collectEnv(dir);
    expect(env.cwd).toBe(dir);
    expect(env.platform).toBe(process.platform);
    expect(env.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("非 git 目录时 gitStatus 静默为空", () => {
    const dir = mkdtempSync(join(tmpdir(), "xharness-nogit-"));
    tempDirs.push(dir);
    const env = collectEnv(dir);
    expect(env.gitStatus).toBe("");
  });
});
