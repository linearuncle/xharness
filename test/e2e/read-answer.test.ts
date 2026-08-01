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

describeE2E("e2e: 读文件回答", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = makeSandbox();
  });

  afterEach(() => {
    cleanSandbox(sandbox);
  });

  it("读取 data.json 并回答 version 字段值", async () => {
    writeFileSync(
      join(sandbox, "data.json"),
      JSON.stringify({ name: "demo-project", version: "3.14.159" }, null, 2)
    );

    const result = await runXharness({
      cwd: sandbox,
      args: ["-p", "读取 data.json，告诉我其中 version 字段的值。"],
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("⏺ Read(");
    expect(result.output).toContain("3.14.159");
    assertNoDestructiveCommands(result.output);
  });
});
