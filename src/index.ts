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
import { createSkillTool } from "./tools/skill.js";
import { loadSkills, type Skill } from "./skills/loader.js";
import { loadPlugins } from "./plugins/loader.js";
import { createPreToolUseHook } from "./plugins/hooks.js";
import { ensureDefaultPlugins } from "./plugins/install.js";
import type { PreToolUseHook } from "./types/hooks.js";
import {
  buildEffortStatusText,
  buildHelpText,
  buildUnknownCommandText,
  dispatchSlash,
  parseEffortArg,
} from "./ui/slashCommands.js";

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
  skills: Skill[];
  preToolUse: PreToolUseHook;
}

function createSession(onTodosUpdate: (store: TodoStore) => void): Session {
  const config = loadConfig();
  const registry = createDefaultRegistry();
  const client = createApiClient(config);
  const env = collectEnv(process.cwd());
  const skills = loadSkills({ cwd: process.cwd() });
  const system = buildSystemPrompt({
    ...env,
    projectInstructions: loadProjectInstructions(process.cwd()),
    skillSummaries: skills.map((s) => ({
      name: s.name,
      description: s.description,
    })),
  });
  const renderer = createRenderer();
  const todoStore: TodoStore = { todos: [] };
  registry.register(
    createTodoWriteTool(todoStore, () => onTodosUpdate(todoStore))
  );
  if (skills.length > 0) {
    registry.register(createSkillTool(skills));
  }
  // 内置插件首启种子安装（用户删除后不复装），随后装载全局+项目插件的 hooks
  const here = dirname(fileURLToPath(import.meta.url));
  ensureDefaultPlugins({ bundledRoot: join(here, "..", "plugins") });
  const preToolUse = createPreToolUseHook(loadPlugins({ cwd: process.cwd() }));
  return { config, registry, client, system, renderer, todoStore, skills, preToolUse };
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
    preToolUse: session.preToolUse,
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

  const handleBuiltin = async (
    command: string,
    args: string
  ): Promise<"exit" | "handled"> => {
    if (command === "exit") return "exit";
    if (command === "clear") {
      history = new History();
      session.todoStore.todos = [];
      process.stdout.write("已清空会话历史与任务清单。\n");
    } else if (command === "help") {
      process.stdout.write(buildHelpText(session.skills));
    } else if (command === "effort") {
      if (!args) {
        process.stdout.write(buildEffortStatusText(session.config.effort));
      } else {
        const parsed = parseEffortArg(args);
        if (parsed.ok) {
          // 会话级 effort：存 session 层，runTurn 每回合取当前 config.effort，下一回合生效
          session.config = { ...session.config, effort: parsed.value };
          process.stdout.write(
            `thinking 档位已切换为 ${parsed.value}（下一回合生效）。\n`
          );
        } else {
          process.stdout.write(parsed.error);
        }
      }
    } else if (command === "compact") {
      const result = await forceCompact(compactDeps());
      if (result.compacted) {
        process.stdout.write(
          `已压缩会话历史：估算 token ${result.beforeTokens} → ${result.afterTokens}。\n`
        );
      } else {
        process.stdout.write(`${result.warning ?? "未执行压缩。"}\n`);
      }
    }
    return "handled";
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
        preToolUse: session.preToolUse,
        onEvent: session.renderer.onEvent,
      });
    },
    runCommand: async (input) => {
      const dispatch = dispatchSlash(input, session.skills);
      if (dispatch.kind === "builtin") {
        return handleBuiltin(dispatch.command, dispatch.args);
      }
      if (dispatch.kind === "skill") {
        process.stdout.write(`[触发技能 ${dispatch.skill.name}]\n`);
        return { turn: dispatch.message };
      }
      process.stdout.write(
        buildUnknownCommandText(dispatch.command, session.skills)
      );
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
