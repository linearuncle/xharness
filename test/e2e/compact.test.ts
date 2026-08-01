import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  assertNoDestructiveCommands,
  cleanSandbox,
  describeE2E,
  makeSandbox,
  runXharness,
} from "./helpers.js";

function fillerText(topic: string): string {
  const paragraph =
    `这是一份关于${topic}的说明文档。它详细描述了项目的背景、目标与实施步骤，` +
    "内容包括需求分析、方案设计、开发排期、验收标准与后续维护计划。" +
    "文档强调团队协作与文档沉淀的重要性，要求每个阶段结束后进行回顾总结。";
  return Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 段：${paragraph}`).join(
    "\n"
  );
}

describeE2E("e2e: 自动 compact", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = makeSandbox();
    writeFileSync(join(sandbox, "notes-a.txt"), fillerText("春季规划"));
    writeFileSync(join(sandbox, "notes-b.txt"), fillerText("秋季规划"));
  });

  afterEach(() => {
    cleanSandbox(sandbox);
  });

  it("小上下文窗口触发自动压缩，压缩后仍保留早期决策", async () => {
    const result = await runXharness({
      cwd: sandbox,
      env: { XHARNESS_CONTEXT_WINDOW: "800" },
      stdinLines: [
        "请记住这个重要决策并简短确认：本项目的秘密代号是 papaya。",
        "读取 notes-a.txt，用一句话概括其内容。",
        "读取 notes-b.txt，用一句话概括其内容。",
        "用一句话说明什么是单元测试。",
        "用一句话说明什么是集成测试。",
        "我们之前定下的项目秘密代号是什么？只回答代号本身。",
      ],
      timeoutMs: 300_000,
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);

    const compactIdx = result.stdout.indexOf("已自动压缩");
    expect(compactIdx).toBeGreaterThanOrEqual(0);
    // 压缩发生后的回合仍能正常回答，且早期决策（代号 papaya）被摘要保留
    expect(result.stdout.slice(compactIdx)).toMatch(/papaya/i);
    assertNoDestructiveCommands(result.output);
  }, 320_000);
});
