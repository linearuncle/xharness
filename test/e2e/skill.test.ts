import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  assertNoDestructiveCommands,
  cleanSandbox,
  describeE2E,
  makeSandbox,
  runXharness,
} from "./helpers.js";

const SKILL_MD = `---
name: greeter
description: 按指定文件名生成一个问候文件
---
使用 Write 工具在当前工作目录创建一个文本文件，文件内容为一行：hello-from-skill
文件名规则：如果用户附加参数给出了文件名，就使用该文件名；否则使用 greeting.txt。
创建完成后用一句话确认即可，不要做任何其他事情。
`;

describeE2E("e2e: 技能触发", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = makeSandbox();
    const skillDir = join(sandbox, ".xharness", "skills", "greeter");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), SKILL_MD);
  });

  afterEach(() => {
    cleanSandbox(sandbox);
  });

  it("斜杠命令与 Skill 工具两种触发方式各产出产物", async () => {
    const result = await runXharness({
      cwd: sandbox,
      stdinLines: [
        "/greeter via-slash.txt",
        "请使用 Skill 工具调用名为 greeter 的技能，按其返回的指示创建文件，文件名使用 via-tool.txt。",
      ],
      timeoutMs: 240_000,
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);

    expect(result.stdout).toContain("[触发技能 greeter]");
    expect(result.output).toContain("⏺ Skill(");

    const slashFile = join(sandbox, "via-slash.txt");
    const toolFile = join(sandbox, "via-tool.txt");
    expect(existsSync(slashFile)).toBe(true);
    expect(existsSync(toolFile)).toBe(true);
    expect(readFileSync(slashFile, "utf8")).toContain("hello-from-skill");
    expect(readFileSync(toolFile, "utf8")).toContain("hello-from-skill");
    assertNoDestructiveCommands(result.output);
  }, 260_000);
});
