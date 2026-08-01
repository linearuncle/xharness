import type { Tool, ToolExecuteContext, ToolResult } from "../types/tools.js";

export const STDIN_CLOSED_RESULT = "[无法获取用户输入——输入流已关闭]";

export interface ReplControllerOptions {
  runTurn: (input: string, signal: AbortSignal) => Promise<void>;
  /** 处理 / 开头的命令；返回 "exit" 表示应退出 REPL */
  runCommand: (
    input: string
  ) => "exit" | "handled" | Promise<"exit" | "handled">;
  write: (text: string) => void;
  prompt: () => void;
  onExit: () => void;
}

export interface ReplController {
  handleLine(line: string): void;
  handleClose(): void;
  /** 回合进行中返回 true（已触发 abort）；空闲返回 false，由调用方清行 */
  handleSigint(): boolean;
  promptFn(rendered: string): Promise<string>;
  wrapAskUserQuestion(tool: Tool): Tool;
  isBusy(): boolean;
}

interface PendingAnswer {
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
}

export function createReplController(opts: ReplControllerOptions): ReplController {
  const queue: string[] = [];
  let busy = false;
  let pumping = false;
  let closing = false;
  let exited = false;
  let activeController: AbortController | null = null;
  let pendingAnswer: PendingAnswer | null = null;
  // AskUserQuestion 本次执行是否已进入"等待用户输入"阶段：
  // 参数校验失败发生在等待之前，据此区分校验类错误与输入流关闭
  let promptRequested = false;

  const exit = (): void => {
    if (!exited) {
      exited = true;
      opts.onExit();
    }
  };

  const rejectPendingAnswer = (message: string): void => {
    if (pendingAnswer) {
      const pending = pendingAnswer;
      pendingAnswer = null;
      pending.reject(new Error(message));
    }
  };

  const pump = async (): Promise<void> => {
    if (pumping || exited) return;
    pumping = true;
    try {
      while (queue.length > 0 && !exited) {
        const input = queue.shift()!.trim();
        if (input.length === 0) continue;
        if (input.startsWith("/")) {
          if ((await opts.runCommand(input)) === "exit") {
            exit();
            return;
          }
          continue;
        }
        busy = true;
        activeController = new AbortController();
        try {
          await opts.runTurn(input, activeController.signal);
        } catch (err) {
          opts.write(
            `错误: ${err instanceof Error ? err.message : String(err)}\n`
          );
        } finally {
          busy = false;
          activeController = null;
          pendingAnswer = null;
        }
      }
      if (exited) return;
      if (closing) exit();
      else opts.prompt();
    } finally {
      pumping = false;
    }
  };

  return {
    handleLine(line: string): void {
      if (exited) return;
      if (pendingAnswer) {
        const pending = pendingAnswer;
        pendingAnswer = null;
        pending.resolve(line);
        return;
      }
      queue.push(line);
      void pump();
    },

    handleClose(): void {
      if (exited) return;
      closing = true;
      rejectPendingAnswer(STDIN_CLOSED_RESULT);
      if (!pumping) {
        if (queue.length > 0) void pump();
        else exit();
      }
    },

    handleSigint(): boolean {
      if (!busy) return false;
      rejectPendingAnswer("[回合被用户中断]");
      activeController?.abort();
      return true;
    },

    promptFn(rendered: string): Promise<string> {
      promptRequested = true;
      if (closing || exited) {
        return Promise.reject(new Error(STDIN_CLOSED_RESULT));
      }
      opts.write(rendered);
      return new Promise<string>((resolve, reject) => {
        pendingAnswer = { resolve, reject };
      });
    },

    wrapAskUserQuestion(tool: Tool): Tool {
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        async execute(
          input: unknown,
          context?: ToolExecuteContext
        ): Promise<ToolResult> {
          promptRequested = false;
          const result = await tool.execute(input, context);
          // 仅改写"等待输入类"错误；参数校验失败发生在等待输入之前，保留原始内容
          if ((closing || exited) && result.isError && promptRequested) {
            return { content: STDIN_CLOSED_RESULT, isError: true };
          }
          return result;
        },
      };
    },

    isBusy(): boolean {
      return busy;
    },
  };
}
