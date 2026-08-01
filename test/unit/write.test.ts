import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeTool } from "../../src/tools/write.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "xharness-write-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Write tool", () => {
  it("新建文件并自动创建父目录，返回字节数与路径", async () => {
    const file = join(dir, "a", "b", "c.txt");
    const result = await writeTool.execute({ file_path: file, content: "hello" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("5 bytes");
    expect(result.content).toContain(file);
    expect(await readFile(file, "utf8")).toBe("hello");
  });

  it("覆盖已有文件", async () => {
    const file = join(dir, "existing.txt");
    await writeFile(file, "old content", "utf8");
    const result = await writeTool.execute({ file_path: file, content: "new" });
    expect(result.isError).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe("new");
  });

  it("缺少 content 参数返回错误", async () => {
    const result = await writeTool.execute({ file_path: join(dir, "x.txt") });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("content");
  });
});
