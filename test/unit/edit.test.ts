import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editTool } from "../../src/tools/edit.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "xharness-edit-"));
  file = join(dir, "target.txt");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Edit tool", () => {
  it("唯一匹配时正常替换", async () => {
    await writeFile(file, "const a = 1;\nconst b = 2;\n", "utf8");
    const result = await editTool.execute({
      file_path: file,
      old_string: "const b = 2;",
      new_string: "const b = 42;",
    });
    expect(result.isError).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe("const a = 1;\nconst b = 42;\n");
  });

  it("0 次匹配报错且错误信息包含次数", async () => {
    await writeFile(file, "hello world\n", "utf8");
    const result = await editTool.execute({
      file_path: file,
      old_string: "not-there",
      new_string: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("0 matches");
  });

  it("多次匹配报错且错误信息包含实际次数", async () => {
    await writeFile(file, "dup dup dup\n", "utf8");
    const result = await editTool.execute({
      file_path: file,
      old_string: "dup",
      new_string: "one",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("3");
    expect(await readFile(file, "utf8")).toBe("dup dup dup\n");
  });

  it("replace_all 为 true 时替换全部", async () => {
    await writeFile(file, "dup dup dup\n", "utf8");
    const result = await editTool.execute({
      file_path: file,
      old_string: "dup",
      new_string: "one",
      replace_all: true,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("3 occurrences");
    expect(await readFile(file, "utf8")).toBe("one one one\n");
  });

  it("old_string 与 new_string 相同报错", async () => {
    await writeFile(file, "same\n", "utf8");
    const result = await editTool.execute({
      file_path: file,
      old_string: "same",
      new_string: "same",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/must be different/);
  });
});
