import { spawnSync } from "node:child_process";
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

describeE2E("e2e: 修复函数后跑测试", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = makeSandbox();
    writeFileSync(
      join(sandbox, "calc.mjs"),
      "export function add(a, b) {\n  return a - b;\n}\n"
    );
    writeFileSync(
      join(sandbox, "test.mjs"),
      [
        'import assert from "node:assert";',
        'import { add } from "./calc.mjs";',
        "assert.strictEqual(add(2, 3), 5);",
        'console.log("CALC_TEST_PASS");',
        "",
      ].join("\n")
    );
  });

  afterEach(() => {
    cleanSandbox(sandbox);
  });

  it("发现 test.mjs 失败后修复 calc.mjs 并跑到通过", async () => {
    const result = await runXharness({
      cwd: sandbox,
      args: [
        "-p",
        "先用 node 运行 test.mjs，你会看到测试失败。" +
          "然后阅读 calc.mjs，用 Edit 工具修复其中的 bug，" +
          "再次用 node 运行 test.mjs，直到测试通过为止。",
      ],
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);

    const rerun = spawnSync(process.execPath, [join(sandbox, "test.mjs")], {
      cwd: sandbox,
      encoding: "utf8",
    });
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain("CALC_TEST_PASS");

    const edited =
      result.output.includes("⏺ Edit(") || result.output.includes("⏺ Write(");
    expect(edited).toBe(true);
    assertNoDestructiveCommands(result.output);
  });
});
