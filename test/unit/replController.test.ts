import { describe, expect, it } from "vitest";
import {
  createReplController,
  STDIN_CLOSED_RESULT,
  type ReplControllerOptions,
} from "../../src/ui/replController.js";
import { createAskUserQuestionTool } from "../../src/tools/askUserQuestion.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Harness {
  controller: ReturnType<typeof createReplController>;
  turns: string[];
  commands: string[];
  written: string[];
  prompts: number;
  exits: number;
  finishTurn: () => void;
}

function setup(overrides: Partial<ReplControllerOptions> = {}): Harness {
  const turns: string[] = [];
  const commands: string[] = [];
  const written: string[] = [];
  const resolvers: Array<() => void> = [];
  const harness = {
    turns,
    commands,
    written,
    prompts: 0,
    exits: 0,
    finishTurn: () => {
      const resolve = resolvers.shift();
      if (!resolve) throw new Error("no active turn to finish");
      resolve();
    },
  } as Harness;

  harness.controller = createReplController({
    runTurn: (input) =>
      new Promise<void>((resolve) => {
        turns.push(input);
        resolvers.push(resolve);
      }),
    runCommand: (input) => {
      commands.push(input);
      return input === "/exit" ? "exit" : "handled";
    },
    write: (text) => written.push(text),
    prompt: () => {
      harness.prompts += 1;
    },
    onExit: () => {
      harness.exits += 1;
    },
    ...overrides,
  });
  return harness;
}

describe("REPL controller 输入排队", () => {
  it("busy 期间到达的两行排队并依序处理", async () => {
    const h = setup();
    h.controller.handleLine("第一回合");
    expect(h.turns).toEqual(["第一回合"]);

    h.controller.handleLine("第二回合");
    h.controller.handleLine("第三回合");
    expect(h.turns).toEqual(["第一回合"]);
    expect(h.prompts).toBe(0);

    h.finishTurn();
    await tick();
    expect(h.turns).toEqual(["第一回合", "第二回合"]);

    h.finishTurn();
    await tick();
    expect(h.turns).toEqual(["第一回合", "第二回合", "第三回合"]);
    expect(h.prompts).toBe(0);

    h.finishTurn();
    await tick();
    expect(h.prompts).toBe(1);
    expect(h.exits).toBe(0);
  });

  it("/exit 排在任务后：任务完成后才退出", async () => {
    const h = setup();
    h.controller.handleLine("先干活");
    h.controller.handleLine("/exit");
    await tick();
    expect(h.exits).toBe(0);
    expect(h.commands).toEqual([]);

    h.finishTurn();
    await tick();
    expect(h.commands).toEqual(["/exit"]);
    expect(h.exits).toBe(1);
    expect(h.prompts).toBe(0);
  });

  it("runCommand 返回 { turn } 时以该文本走正常回合（技能触发路径）", async () => {
    const h = setup({
      runCommand: (input) =>
        input === "/myskill" ? { turn: "技能指令体" } : "handled",
    });
    h.controller.handleLine("/myskill");
    await tick();
    expect(h.turns).toEqual(["技能指令体"]);
    expect(h.controller.isBusy()).toBe(true);
    h.finishTurn();
    await tick();
    expect(h.prompts).toBe(1);
  });

  it("排队中的斜杠命令与普通输入统一按序处理", async () => {
    const h = setup();
    h.controller.handleLine("回合A");
    h.controller.handleLine("/clear");
    h.controller.handleLine("回合B");
    h.finishTurn();
    await tick();
    expect(h.commands).toEqual(["/clear"]);
    expect(h.turns).toEqual(["回合A", "回合B"]);
    h.finishTurn();
    await tick();
    expect(h.prompts).toBe(1);
  });
});

describe("REPL controller 优雅关闭", () => {
  it("空闲时 close 立即退出", () => {
    const h = setup();
    h.controller.handleClose();
    expect(h.exits).toBe(1);
  });

  it("busy 时 close 等回合与队列清空后再退出", async () => {
    const h = setup();
    h.controller.handleLine("回合A");
    h.controller.handleLine("回合B");
    h.controller.handleClose();
    expect(h.exits).toBe(0);

    h.finishTurn();
    await tick();
    expect(h.turns).toEqual(["回合A", "回合B"]);
    expect(h.exits).toBe(0);

    h.finishTurn();
    await tick();
    expect(h.exits).toBe(1);
    expect(h.prompts).toBe(0);
  });

  it("closing 时 AskUserQuestion 以输入流已关闭的 is_error 回填", async () => {
    const h = setup();
    const tool = h.controller.wrapAskUserQuestion(
      createAskUserQuestionTool((rendered) => h.controller.promptFn(rendered))
    );

    h.controller.handleLine("触发提问的回合");
    const pendingResult = tool.execute({
      question: "怎么办？",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    });
    await tick();

    h.controller.handleClose();
    const result = await pendingResult;
    expect(result.isError).toBe(true);
    expect(result.content).toBe(STDIN_CLOSED_RESULT);

    h.finishTurn();
    await tick();
    expect(h.exits).toBe(1);
  });

  it("closing 时参数校验类错误保留原始内容、不被改写为输入流已关闭", async () => {
    const h = setup();
    const tool = h.controller.wrapAskUserQuestion(
      createAskUserQuestionTool((rendered) => h.controller.promptFn(rendered))
    );
    h.controller.handleLine("回合");
    h.controller.handleClose();
    const result = await tool.execute({
      question: "Q?",
      options: [{ label: "只有一个选项", description: "非法" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content).not.toBe(STDIN_CLOSED_RESULT);
    expect(result.content).toContain("2 to 4");
  });

  it("close 之后再发起的 AskUserQuestion 直接返回输入流已关闭", async () => {
    const h = setup();
    const tool = h.controller.wrapAskUserQuestion(
      createAskUserQuestionTool((rendered) => h.controller.promptFn(rendered))
    );
    h.controller.handleLine("回合");
    h.controller.handleClose();
    const result = await tool.execute({
      question: "Q?",
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    });
    expect(result).toEqual({ content: STDIN_CLOSED_RESULT, isError: true });
  });
});

describe("REPL controller SIGINT 与作答", () => {
  it("busy 时 SIGINT 触发 abort 并返回 true，空闲时返回 false", async () => {
    let observedSignal: AbortSignal | undefined;
    const resolvers: Array<() => void> = [];
    const h = setup({
      runTurn: (input, signal) =>
        new Promise<void>((resolve) => {
          observedSignal = signal;
          resolvers.push(resolve);
        }),
    });
    expect(h.controller.handleSigint()).toBe(false);

    h.controller.handleLine("回合");
    expect(h.controller.isBusy()).toBe(true);
    expect(h.controller.handleSigint()).toBe(true);
    expect(observedSignal?.aborted).toBe(true);

    resolvers.shift()!();
    await tick();
    expect(h.prompts).toBe(1);
    expect(h.exits).toBe(0);
  });

  it("pendingAnswer 存在时输入行作为答案而非新回合", async () => {
    const h = setup();
    const tool = h.controller.wrapAskUserQuestion(
      createAskUserQuestionTool((rendered) => h.controller.promptFn(rendered))
    );
    h.controller.handleLine("回合");
    const pendingResult = tool.execute({
      question: "选哪个？",
      options: [
        { label: "甲", description: "a" },
        { label: "乙", description: "b" },
      ],
    });
    await tick();

    h.controller.handleLine("2");
    const result = await pendingResult;
    expect(result.content).toBe("用户选择: 乙");
    expect(h.turns).toEqual(["回合"]);
  });
});
