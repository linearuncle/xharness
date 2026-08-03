import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepTool, grepTool } from "../../src/tools/grep.js";

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

  it("压缩文件的超长单行最多返回 1000 字符并明确标注", async () => {
    await writeFile(join(dir, "minified.js"), `needle:${"x".repeat(10_000)}\n`, "utf8");

    const result = await grepTool.execute({ pattern: "needle", path: dir });

    expect(result.isError).toBeUndefined();
    expect([...result.content.split("\n")[0]].length).toBeLessThanOrEqual(1000);
    expect(result.content).toContain("line truncated");
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(40_000);
  });

  it("超过 200 条匹配时提前停止并返回可见的截断提示", async () => {
    await writeFile(
      join(dir, "many.txt"),
      Array.from({ length: 250 }, (_, index) => `needle ${index}`).join("\n") + "\n",
      "utf8"
    );

    const result = await grepTool.execute({ pattern: "needle", path: join(dir, "many.txt") });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("200-line result limit reached");
    expect(result.content.split("\n").filter((line) => /^\d+:needle /.test(line))).toHaveLength(200);
  });

  it("最终结果不超过 40000 UTF-8 bytes 并提示字节预算触顶", async () => {
    await writeFile(
      join(dir, "wide.txt"),
      Array.from({ length: 100 }, (_, index) => `needle ${index} ${"界".repeat(450)}`).join("\n") +
        "\n",
      "utf8"
    );

    const result = await grepTool.execute({ pattern: "needle", path: join(dir, "wide.txt") });

    expect(result.isError).toBeUndefined();
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(40_000);
    expect(result.content).toContain("40000-byte result limit reached");
  });

  it("跳过大于 5MB 的文件", async () => {
    await writeFile(join(dir, "large.txt"), `needle\n${"x".repeat(5 * 1024 * 1024)}\n`, "utf8");

    const result = await grepTool.execute({ pattern: "needle", path: dir });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("no matches");
  });

  it("超时后终止 rg 进程组并返回错误", async () => {
    const fakeRg = join(dir, "slow-rg");
    await writeFile(fakeRg, "#!/bin/sh\nsleep 5\n", "utf8");
    await chmod(fakeRg, 0o755);
    const tool = createGrepTool({ rgCommand: fakeRg, timeoutMs: 100 });
    const startedAt = Date.now();

    const result = await tool.execute({ pattern: "needle", path: dir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out after 100ms");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("收到 AbortSignal 后终止搜索并返回错误", async () => {
    const fakeRg = join(dir, "abortable-rg");
    await writeFile(fakeRg, "#!/bin/sh\nsleep 5\n", "utf8");
    await chmod(fakeRg, 0o755);
    const tool = createGrepTool({ rgCommand: fakeRg });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const startedAt = Date.now();

    const result = await tool.execute(
      { pattern: "needle", path: dir },
      { signal: controller.signal }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("search was interrupted");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
