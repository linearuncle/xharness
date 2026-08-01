import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  assertNoDestructiveCommands,
  cleanSandbox,
  describeE2E,
  makeSandbox,
  runXharness,
} from "./helpers.js";

describeE2E("e2e: 新建并运行脚本", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = makeSandbox();
  });

  afterEach(() => {
    cleanSandbox(sandbox);
  });

  it("创建 hello.mjs 并用 node 运行", async () => {
    const result = await runXharness({
      cwd: sandbox,
      args: [
        "-p",
        "用 Write 工具创建一个名为 hello.mjs 的脚本，功能是打印 hi。" +
          "然后用 node 运行它，把运行输出展示给我。",
      ],
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);

    const scriptPath = join(sandbox, "hello.mjs");
    expect(existsSync(scriptPath)).toBe(true);
    expect(readFileSync(scriptPath, "utf8")).toContain("hi");

    const rerun = spawnSync(process.execPath, [scriptPath], {
      cwd: sandbox,
      encoding: "utf8",
    });
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain("hi");

    const writeIdx = result.output.indexOf("⏺ Write(");
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(result.output.indexOf("⏺ Bash(", writeIdx)).toBeGreaterThan(
      writeIdx
    );
    assertNoDestructiveCommands(result.output);
  });
});
