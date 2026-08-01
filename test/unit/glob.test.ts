import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globTool } from "../../src/tools/glob.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "xharness-glob-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Glob tool", () => {
  it("匹配文件并按 mtime 降序排序", async () => {
    const oldFile = join(dir, "old.txt");
    const newFile = join(dir, "sub", "new.txt");
    await writeFile(oldFile, "old", "utf8");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(newFile, "new", "utf8");
    const past = new Date(Date.now() - 100_000);
    await utimes(oldFile, past, past);

    const result = await globTool.execute({ pattern: "**/*.txt", path: dir });
    expect(result.isError).toBeUndefined();
    const lines = result.content.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("new.txt");
    expect(lines[1]).toContain("old.txt");
  });

  it("忽略 node_modules 与 .git", async () => {
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", "skip.txt"), "x", "utf8");
    await writeFile(join(dir, ".git", "config.txt"), "x", "utf8");
    await writeFile(join(dir, "keep.txt"), "x", "utf8");

    const result = await globTool.execute({ pattern: "**/*.txt", path: dir });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("keep.txt");
    expect(result.content).not.toContain("skip.txt");
    expect(result.content).not.toContain("config.txt");
  });

  it("无匹配返回 no matches 且不算错误", async () => {
    const result = await globTool.execute({ pattern: "**/*.nope", path: dir });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("no matches");
  });
});
