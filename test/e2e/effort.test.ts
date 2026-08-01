import { afterEach, beforeEach, expect, it } from "vitest";
import {
  assertNoDestructiveCommands,
  cleanSandbox,
  describeE2E,
  makeSandbox,
  runXharness,
} from "./helpers.js";

const DIM = "\x1b[2m";
const QUESTION = "9.11 和 9.8 哪个大？只回答较大的那个数字，不要解释。";

describeE2E("e2e: thinking effort 档位", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = makeSandbox();
  });

  afterEach(() => {
    cleanSandbox(sandbox);
  });

  // Judge T7 裁决记录（2026-08-01，裁决 b）：实测端点忽略 reasoning.effort
  // （none 仍思考、非法值静默接受），故 client 层把 effort:"none" 映射为
  // Anthropic 官方参数 thinking:{type:"disabled"}（实测可真正关闭思考）且不携带
  // reasoning；low/high/max 维持 reasoning.effort 透传。GOAL §4.5 F19 已同步更新。
  it("/effort none：无暗色思考段，仍有正文答案", async () => {
    const result = await runXharness({
      cwd: sandbox,
      stdinLines: [`/effort none`, QUESTION],
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("thinking 档位已切换为 none");
    // none 档：无 ANSI dim 思考段（经 thinking:{type:"disabled"} 关闭）
    expect(result.stdout).not.toContain(DIM);
    // 正文答案存在。注意：只断言"有答案"而非"答案正确"——实测 flash 在 none 档
    // （无思考）下会答错这道陷阱题（回答 9.11），这是模型质量问题而非端点/实现问题
    expect(result.stdout).toMatch(/9\.(8|11)/);
    assertNoDestructiveCommands(result.output);
  });

  it("effort high：有暗色思考段与正文答案", async () => {
    const result = await runXharness({
      cwd: sandbox,
      args: ["-p", QUESTION],
      env: { XHARNESS_EFFORT: "high" },
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    // high 档：可见 ANSI dim 思考段
    expect(result.stdout).toContain(DIM);
    // 正文答案存在
    expect(result.output).toContain("9.8");
    assertNoDestructiveCommands(result.output);
  });
});
