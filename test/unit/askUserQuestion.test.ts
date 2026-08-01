import { describe, expect, it } from "vitest";
import { createAskUserQuestionTool } from "../../src/tools/askUserQuestion.js";

const OPTIONS = [
  { label: "方案 A", description: "保守方案" },
  { label: "方案 B", description: "激进方案" },
  { label: "方案 C", description: "折中方案" },
];

function queuedPromptFn(answers: string[]) {
  const rendered: string[] = [];
  const fn = (text: string): Promise<string> => {
    rendered.push(text);
    const next = answers.shift();
    if (next === undefined) return new Promise(() => {});
    return Promise.resolve(next);
  };
  return { fn, rendered };
}

describe("AskUserQuestion tool", () => {
  it("渲染编号选项并接受数字选择，返回对应 label", async () => {
    const { fn, rendered } = queuedPromptFn(["2"]);
    const tool = createAskUserQuestionTool(fn);
    const result = await tool.execute({ question: "选哪个方案？", options: OPTIONS });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("用户选择: 方案 B");
    expect(rendered[0]).toContain("选哪个方案？");
    expect(rendered[0]).toContain("1) 方案 A");
    expect(rendered[0]).toContain("保守方案");
    expect(rendered[0]).toContain("3) 方案 C");
  });

  it("自由文本原样返回（等价 Other）", async () => {
    const { fn } = queuedPromptFn(["都不要，先写测试"]);
    const tool = createAskUserQuestionTool(fn);
    const result = await tool.execute({ question: "选哪个？", options: OPTIONS });
    expect(result.content).toBe("用户输入: 都不要，先写测试");
  });

  it("空输入重新提问直到有效", async () => {
    const { fn, rendered } = queuedPromptFn(["", "   ", "1"]);
    const tool = createAskUserQuestionTool(fn);
    const result = await tool.execute({ question: "Q?", options: OPTIONS });
    expect(result.content).toBe("用户选择: 方案 A");
    expect(rendered.length).toBe(3);
  });

  it("超出范围的数字按自由文本处理", async () => {
    const { fn } = queuedPromptFn(["9"]);
    const tool = createAskUserQuestionTool(fn);
    const result = await tool.execute({ question: "Q?", options: OPTIONS });
    expect(result.content).toBe("用户输入: 9");
  });

  it("options 少于 2 项或多于 4 项报错", async () => {
    const tool = createAskUserQuestionTool(queuedPromptFn([]).fn);
    const few = await tool.execute({
      question: "Q?",
      options: [{ label: "只有一个", description: "x" }],
    });
    expect(few.isError).toBe(true);
    expect(few.content).toContain("2 to 4");

    const many = await tool.execute({
      question: "Q?",
      options: Array.from({ length: 5 }, (_, i) => ({
        label: `L${i}`,
        description: "d",
      })),
    });
    expect(many.isError).toBe(true);
    expect(many.content).toContain("2 to 4");
  });

  it("缺少 question 报错", async () => {
    const tool = createAskUserQuestionTool(queuedPromptFn([]).fn);
    const result = await tool.execute({ options: OPTIONS });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("question");
  });

  it("等待作答期间 abort 立即返回中断错误", async () => {
    const tool = createAskUserQuestionTool(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = tool.execute(
      { question: "Q?", options: OPTIONS },
      { signal: controller.signal }
    );
    controller.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("中断");
  });
});
