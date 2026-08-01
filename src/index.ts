#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig, type Config } from "./config.js";
import { createDefaultRegistry, type ToolRegistry } from "./tools/registry.js";
import { createApiClient, type ApiClient } from "./api/client.js";
import {
  buildSystemPrompt,
  collectEnv,
  loadProjectInstructions,
} from "./agent/prompts.js";
import { runTurn } from "./agent/loop.js";
import { forceCompact, maybeCompact } from "./agent/compact.js";
import { History } from "./session/history.js";
import { createRenderer, renderTodos, type Renderer } from "./ui/render.js";
import { createReplController } from "./ui/replController.js";
import { createAskUserQuestionTool } from "./tools/askUserQuestion.js";
import { createTodoWriteTool, type TodoStore } from "./tools/todoWrite.js";

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

interface Session {
  config: Config;
  registry: ToolRegistry;
  client: ApiClient;
  system: string;
  renderer: Renderer;
  todoStore: TodoStore;
}

function createSession(onTodosUpdate: (store: TodoStore) => void): Session {
  const config = loadConfig();
  const registry = createDefaultRegistry();
  const client = createApiClient(config);
  const env = collectEnv(process.cwd());
  const system = buildSystemPrompt({
    ...env,
    projectInstructions: loadProjectInstructions(process.cwd()),
    skillSummaries: [],
  });
  const renderer = createRenderer();
  const todoStore: TodoStore = { todos: [] };
  registry.register(
    createTodoWriteTool(todoStore, () => onTodosUpdate(todoStore))
  );
  return { config, registry, client, system, renderer, todoStore };
}

async function runPrompt(userInput: string): Promise<void> {
  const session = createSession(() => {});
  const history = new History();
  await runTurn({
    userInput,
    history,
    registry: session.registry,
    client: session.client,
    config: session.config,
    system: session.system,
    onEvent: session.renderer.onEvent,
  });
}

async function runRepl(): Promise<void> {
  const session = createSession((store) => renderTodos(store.todos));
  let history = new History();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "xharness> ",
  });

  const compactDeps = () => ({
    history,
    client: session.client,
    config: session.config,
    system: session.system,
  });

  const handleSlashCommand = async (input: string): Promise<void> => {
    if (input === "/clear") {
      history = new History();
      session.todoStore.todos = [];
      process.stdout.write("已清空会话历史与任务清单。\n");
    } else if (input === "/help" || input.startsWith("/help ")) {
      process.stdout.write(
        [
          "内置命令：",
          "  /help     显示本帮助",
          "  /clear    清空会话历史与任务清单",
          "  /compact  手动压缩会话历史",
          "  /exit     退出",
          "技能列表将在 T5 支持。",
        ].join("\n") + "\n"
      );
    } else if (input === "/compact" || input.startsWith("/compact ")) {
      const result = await forceCompact(compactDeps());
      if (result.compacted) {
        process.stdout.write(
          `已压缩会话历史：估算 token ${result.beforeTokens} → ${result.afterTokens}。\n`
        );
      } else {
        process.stdout.write(`${result.warning ?? "未执行压缩。"}\n`);
      }
    } else {
      process.stdout.write(`未知命令: ${input}\n`);
    }
  };

  const controller = createReplController({
    runTurn: async (input, signal) => {
      const compact = await maybeCompact(compactDeps());
      if (compact.compacted) {
        process.stdout.write(
          `[历史接近上下文窗口上限，已自动压缩：估算 token ${compact.beforeTokens} → ${compact.afterTokens}]\n`
        );
      } else if (compact.warning) {
        process.stdout.write(`[警告] ${compact.warning}\n`);
      }
      await runTurn({
        userInput: input,
        history,
        registry: session.registry,
        client: session.client,
        config: session.config,
        system: session.system,
        signal,
        onEvent: session.renderer.onEvent,
      });
    },
    runCommand: async (input) => {
      if (input === "/exit") return "exit";
      await handleSlashCommand(input);
      return "handled";
    },
    write: (text) => process.stdout.write(text),
    prompt: () => rl.prompt(),
    onExit: () => {
      process.stdout.write("\n再见。\n");
      process.exit(0);
    },
  });

  session.registry.register(
    controller.wrapAskUserQuestion(
      createAskUserQuestionTool((rendered) => controller.promptFn(rendered))
    )
  );

  rl.on("SIGINT", () => {
    if (controller.handleSigint()) {
      process.stdout.write("\n[正在中断当前回合…]\n");
    } else {
      process.stdout.write("\n");
      rl.write(null, { ctrl: true, name: "u" });
      rl.prompt();
    }
  });

  rl.on("line", (line) => controller.handleLine(line));
  rl.on("close", () => controller.handleClose());

  process.stdout.write(
    `xharness v${readVersion()} — 输入内容开始对话，/exit 或 Ctrl+D 退出。\n`
  );
  rl.prompt();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--version")) {
    console.log(readVersion());
    process.exit(0);
  }

  const promptFlag = args.findIndex((a) => a === "-p" || a === "--prompt");
  if (promptFlag !== -1) {
    const text = args[promptFlag + 1];
    if (!text) {
      console.error('用法: xharness -p "<提示词>"');
      process.exit(1);
    }
    try {
      await runPrompt(text);
      process.exit(0);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  try {
    await runRepl();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

void main();
