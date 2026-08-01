import { describe, expect, it } from "vitest";
import { bashTool } from "../../src/tools/bash.js";

describe("Bash tool", () => {
  it("正常执行并合并 stdout/stderr", async () => {
    const result = await bashTool.execute({ command: "echo out; echo err 1>&2" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("out");
    expect(result.content).toContain("err");
  });

  it("超时会杀进程组并在结果中标注", async () => {
    const start = Date.now();
    const result = await bashTool.execute({ command: "sleep 3", timeout: 500 });
    expect(Date.now() - start).toBeLessThan(2500);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/timed out after 500ms/);
  }, 10_000);

  it("大输出截断中间并标注省略字符数", async () => {
    const result = await bashTool.execute({
      command: `node -e 'process.stdout.write("a".repeat(20000) + "b".repeat(20000))'`,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/\[\d+ characters omitted\]/);
    expect(result.content.startsWith("a")).toBe(true);
    expect(result.content.endsWith("b")).toBe(true);
    expect(result.content.length).toBeLessThan(31_000);
  }, 15_000);

  it("非零退出码返回 isError 且包含退出码", async () => {
    const result = await bashTool.execute({ command: "exit 3" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Exit code: 3");
  });

  it("缺少 command 参数返回错误而不抛异常", async () => {
    const result = await bashTool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("command");
  });
});
