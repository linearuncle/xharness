import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTool } from "../../src/tools/read.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "xharness-read-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Read tool", () => {
  it("正常读取并输出 cat -n 风格行号", async () => {
    const file = join(dir, "sample.txt");
    await writeFile(file, "one\ntwo\nthree\n", "utf8");
    const result = await readTool.execute({ file_path: file });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("     1\tone\n     2\ttwo\n     3\tthree");
  });

  it("文件不存在返回明确错误", async () => {
    const result = await readTool.execute({ file_path: join(dir, "missing.txt") });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/does not exist/);
  });

  it("路径是目录返回明确错误", async () => {
    const result = await readTool.execute({ file_path: dir });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/is a directory/);
  });

  it("offset/limit 生效且行号对应原文件", async () => {
    const file = join(dir, "many.txt");
    await writeFile(file, ["l1", "l2", "l3", "l4"].join("\n"), "utf8");
    const result = await readTool.execute({ file_path: file, offset: 2, limit: 2 });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("     2\tl2\n     3\tl3");
  });

  it("单行超过 2000 字符被截断并标注", async () => {
    const file = join(dir, "long.txt");
    await writeFile(file, `${"x".repeat(2500)}\nshort`, "utf8");
    const result = await readTool.execute({ file_path: file });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("[line truncated]");
    const firstLine = result.content.split("\n")[0];
    expect(firstLine.length).toBeLessThan(2100);
  });
});
