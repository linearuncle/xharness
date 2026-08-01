import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grepTool } from "../../src/tools/grep.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "xharness-grep-"));
  await writeFile(join(dir, "a.ts"), "const greeting = 'hello world';\n", "utf8");
  await writeFile(join(dir, "b.js"), "// hello from js\n", "utf8");
  await writeFile(join(dir, "c.txt"), "nothing here\n", "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Grep tool", () => {
  it("有匹配时返回 文件:行号:内容", async () => {
    const result = await grepTool.execute({ pattern: "hello", path: dir });
    expect(result.isError).toBeUndefined();
    const lines = result.content.split("\n");
    expect(lines).toHaveLength(2);
    expect(result.content).toMatch(/a\.ts:1:.*hello world/);
    expect(result.content).toMatch(/b\.js:1:.*hello from js/);
  });

  it("无匹配返回 no matches 且不算错误", async () => {
    const result = await grepTool.execute({ pattern: "definitely-absent", path: dir });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("no matches");
  });

  it("glob 参数过滤文件类型", async () => {
    const result = await grepTool.execute({ pattern: "hello", path: dir, glob: "*.ts" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("a.ts:1:");
    expect(result.content).not.toContain("b.js");
  });

  it("非法正则（rg 退出码 2）返回错误", async () => {
    const result = await grepTool.execute({ pattern: "([unclosed", path: dir });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/rg failed/);
  });
});
