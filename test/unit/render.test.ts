import { describe, expect, it } from "vitest";
import {
  createRenderer,
  formatTodos,
  renderTodos,
  summarizeInput,
  type OutputStream,
} from "../../src/ui/render.js";
import type { TodoItem } from "../../src/types/tools.js";

function fakeStream(): OutputStream & { text: string } {
  return {
    text: "",
    write(chunk: string) {
      this.text += chunk;
      return true;
    },
  };
}

function makeRenderer() {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const renderer = createRenderer({ stdout, stderr });
  return { renderer, stdout, stderr };
}

describe("createRenderer", () => {
  it("text_delta 流式写入 stdout", () => {
    const { renderer, stdout } = makeRenderer();
    renderer.onEvent({ type: "text_delta", text: "你好" });
    renderer.onEvent({ type: "text_delta", text: "，世界" });
    expect(stdout.text).toBe("你好，世界");
  });

  it("tool_start 输出 ⏺ 工具名(参数摘要)", () => {
    const { renderer, stdout } = makeRenderer();
    renderer.onEvent({
      type: "tool_start",
      id: "t1",
      name: "Bash",
      input: { command: "npm test" },
    });
    expect(stdout.text).toBe("⏺ Bash(command: npm test)\n");
  });

  it("tool_start 参数摘要截断至 80 字符", () => {
    const { renderer, stdout } = makeRenderer();
    renderer.onEvent({
      type: "tool_start",
      id: "t1",
      name: "Bash",
      input: { command: "x".repeat(300) },
    });
    const line = stdout.text.trim();
    const summary = line.slice("⏺ Bash(".length, -1);
    expect(summary.length).toBeLessThanOrEqual(80);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("tool_end 成功显示 ✔ 与结果首行", () => {
    const { renderer, stdout } = makeRenderer();
    renderer.onEvent({
      type: "tool_end",
      id: "t1",
      name: "Read",
      result: "第一行内容\n第二行内容",
      isError: false,
    });
    expect(stdout.text).toBe("  ✔ 第一行内容\n");
  });

  it("tool_end 失败显示 ✘ 且首行截断 80 字符", () => {
    const { renderer, stdout } = makeRenderer();
    renderer.onEvent({
      type: "tool_end",
      id: "t1",
      name: "Bash",
      result: "e".repeat(200) + "\nsecond",
      isError: true,
    });
    const line = stdout.text.trim();
    expect(line.startsWith("✘ ")).toBe(true);
    expect(line.slice(2).length).toBeLessThanOrEqual(80);
    expect(line).not.toContain("second");
  });

  it("流式文本未换行时 tool_start 前补换行", () => {
    const { renderer, stdout } = makeRenderer();
    renderer.onEvent({ type: "text_delta", text: "思考中" });
    renderer.onEvent({
      type: "tool_start",
      id: "t1",
      name: "Glob",
      input: { pattern: "*.ts" },
    });
    expect(stdout.text).toBe("思考中\n⏺ Glob(pattern: *.ts)\n");
  });

  it("error 写入 stderr", () => {
    const { renderer, stderr } = makeRenderer();
    renderer.onEvent({ type: "error", message: "网络异常" });
    expect(stderr.text).toBe("错误: 网络异常\n");
  });

  it("turn_end interrupted / max_tool_calls 有提示，end_turn 无额外输出", () => {
    const a = makeRenderer();
    a.renderer.onEvent({ type: "turn_end", reason: "interrupted" });
    expect(a.stdout.text).toContain("中断");

    const b = makeRenderer();
    b.renderer.onEvent({ type: "turn_end", reason: "max_tool_calls" });
    expect(b.stdout.text).toContain("上限");

    const c = makeRenderer();
    c.renderer.onEvent({ type: "turn_end", reason: "end_turn" });
    expect(c.stdout.text).toBe("");
  });
});

describe("summarizeInput", () => {
  it("多字段序列化并把换行折叠为空格", () => {
    const summary = summarizeInput({ file_path: "/a/b.ts", limit: 10 });
    expect(summary).toBe("file_path: /a/b.ts, limit: 10");
    expect(summarizeInput({ command: "a\nb" })).toBe("command: a b");
  });
});

describe("renderTodos / formatTodos", () => {
  const todos: TodoItem[] = [
    { content: "写测试", status: "pending" },
    { content: "改代码", status: "in_progress" },
    { content: "查文档", status: "completed" },
  ];

  it("三种状态使用 ☐ ■ ✔ 样式", () => {
    const text = formatTodos(todos);
    expect(text).toBe("☐ 写测试\n■ 改代码\n✔ 查文档");
  });

  it("renderTodos 写入注入的流并以换行结尾", () => {
    const stream = fakeStream();
    renderTodos(todos, stream);
    expect(stream.text).toBe("☐ 写测试\n■ 改代码\n✔ 查文档\n");
  });

  it("空清单有占位提示", () => {
    expect(formatTodos([])).toContain("空");
  });
});
