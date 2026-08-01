#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { loadConfig, type Config } from "./config.js";
import { createDefaultRegistry, type ToolRegistry } from "./tools/registry.js";
import { createApiClient, type ApiClient } from "./api/client.js";
import { buildSystemPrompt, collectEnv } from "./agent/prompts.js";
import { runTurn } from "./agent/loop.js";
import { History } from "./session/history.js";
import { createRenderer, renderTodos, type Renderer } from "./ui/render.js";
import { createAskUserQuestionTool, type PromptFn } from "./tools/askUserQuestion.js";
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
    projectInstructions: "",
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

  let busy = false;
  let activeController: AbortController | null = null;
  let pendingAnswer: ((answer: string) => void) | null = null;

  const promptFn: PromptFn = (rendered) =>
    new Promise((resolve) => {
      process.stdout.write(rendered);
      pendingAnswer = resolve;
    });
  session.registry.register(createAskUserQuestionTool(promptFn));

  rl.on("SIGINT", () => {
    if (busy) {
      pendingAnswer = null;
      process.stdout.write("\n[正在中断当前回合…]\n");
      activeController?.abort();
    } else {
      process.stdout.write("\n");
      rl.write(null, { ctrl: true, name: "u" });
      rl.prompt();
    }
  });

  rl.on("close", () => {
    process.stdout.write("\n再见。\n");
    process.exit(0);
  });

  const handleSlashCommand = (input: string): void => {
    if (input === "/clear") {
      history = new History();
      session.todoStore.todos = [];
      process.stdout.write("已清空会话历史与任务清单。\n");
    } else if (input === "/help" || input.startsWith("/help ")) {
      process.stdout.write("/help 将在后续版本支持。\n");
    } else if (input === "/compact" || input.startsWith("/compact ")) {
      process.stdout.write("/compact 将在后续版本支持。\n");
    } else {
      process.stdout.write(`未知命令: ${input}\n`);
    }
  };

  const handleInput = async (input: string): Promise<void> => {
    busy = true;
    activeController = new AbortController();
    try {
      await runTurn({
        userInput: input,
        history,
        registry: session.registry,
        client: session.client,
        config: session.config,
        system: session.system,
        signal: activeController.signal,
        onEvent: session.renderer.onEvent,
      });
    } catch (err) {
      process.stderr.write(
        `错误: ${err instanceof Error ? err.message : String(err)}\n`
      );
    } finally {
      busy = false;
      activeController = null;
      pendingAnswer = null;
      rl.prompt();
    }
  };

  rl.on("line", (line) => {
    if (pendingAnswer) {
      const resolve = pendingAnswer;
      pendingAnswer = null;
      resolve(line);
      return;
    }
    if (busy) return;
    const input = line.trim();
    if (input.length === 0) {
      rl.prompt();
      return;
    }
    if (input === "/exit") {
      rl.close();
      return;
    }
    if (input.startsWith("/")) {
      handleSlashCommand(input);
      rl.prompt();
      return;
    }
    void handleInput(input);
  });

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
