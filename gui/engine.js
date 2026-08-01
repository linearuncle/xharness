// 引擎层：把 xharness（../dist）包装成 GUI 会话。
// 每个会话持有独立的 History/Registry/Config（模型与推理强度可覆盖）。
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { loadConfig } from "../dist/config.js";
import { createApiClient } from "../dist/api/client.js";
import { createDefaultRegistry } from "../dist/tools/registry.js";
import {
  buildSystemPrompt,
  collectEnv,
  loadProjectInstructions,
} from "../dist/agent/prompts.js";
import { runTurn } from "../dist/agent/loop.js";
import { maybeCompact, forceCompact } from "../dist/agent/compact.js";
import { History } from "../dist/session/history.js";
import { loadSkills } from "../dist/skills/loader.js";
import { createSkillTool } from "../dist/tools/skill.js";
import { createTodoWriteTool } from "../dist/tools/todoWrite.js";
import { dispatchSlash } from "../dist/ui/slashCommands.js";

let baseConfig = null;

export function initConfig() {
  if (!process.env.ANTHROPIC_API_KEY && process.env.DEEPSEEK_API_KEY) {
    process.env.ANTHROPIC_API_KEY = process.env.DEEPSEEK_API_KEY;
  }
  baseConfig = loadConfig();
  return baseConfig;
}

export const MODELS = ["deepseek-v4-pro", "deepseek-v4-flash"];
export const EFFORTS = [
  { value: "", label: "默认(高)" },
  { value: "none", label: "关闭" },
  { value: "low", label: "低" },
  { value: "high", label: "高" },
  { value: "max", label: "极高" },
];

function contextWindowFor(model) {
  return model.startsWith("deepseek-v4-") ? 1_000_000 : 200_000;
}

const sessions = new Map();

function seedHistory(history, blocks) {
  for (const b of blocks) {
    if (b.kind === "user") {
      history.push({ role: "user", content: [{ type: "text", text: b.text }] });
    } else if (b.kind === "assistant" && b.text) {
      history.push({
        role: "assistant",
        content: [{ type: "text", text: b.text }],
      });
    }
  }
}

export function getSession(convId, projectDir, savedBlocks) {
  let s = sessions.get(convId);
  if (s) return s;

  const skills = loadSkills({ cwd: projectDir });
  const registry = createDefaultRegistry();
  const todoStore = { todos: [] };

  s = {
    convId,
    projectDir,
    model: baseConfig.model,
    effort: baseConfig.effort,
    history: new History(),
    registry,
    skills,
    todoStore,
    running: false,
    abort: null,
    pendingAsk: null,
    emit: () => {},
  };

  registry.register(
    createTodoWriteTool(todoStore, (todos) =>
      s.emit({ type: "todos", todos })
    )
  );
  registry.register(createAskTool(s));
  if (skills.length > 0) registry.register(createSkillTool(skills));

  if (savedBlocks?.length) seedHistory(s.history, savedBlocks);
  sessions.set(convId, s);
  return s;
}

function createAskTool(s) {
  return {
    name: "AskUserQuestion",
    description:
      "Ask the user a multiple-choice question when you need a decision you cannot make yourself. " +
      "Provide 2-4 options, each with a short label and a one-line description. " +
      "The user may also type a free-form answer. Blocks until the user responds.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask." },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              description: { type: "string" },
            },
            required: ["label", "description"],
          },
        },
      },
      required: ["question", "options"],
    },
    async execute(input, ctx) {
      const question = typeof input?.question === "string" ? input.question : "";
      const options = Array.isArray(input?.options) ? input.options : [];
      if (!question || options.length < 2 || options.length > 4) {
        return {
          content: "AskUserQuestion: question 必填，options 须为 2-4 项",
          isError: true,
        };
      }
      return await new Promise((resolve) => {
        const onAbort = () =>
          finish({ content: "[未作答——回合被中断]", isError: true });
        const finish = (result) => {
          ctx?.signal?.removeEventListener("abort", onAbort);
          s.pendingAsk = null;
          resolve(result);
        };
        if (ctx?.signal?.aborted) return onAbort();
        ctx?.signal?.addEventListener("abort", onAbort, { once: true });
        s.pendingAsk = (answer) => {
          const picked = options.find((o) => o.label === answer);
          finish({
            content: picked ? `用户选择: ${picked.label}` : `用户输入: ${answer}`,
          });
        };
        s.emit({ type: "ask", question, options });
      });
    },
  };
}

function config(s) {
  return {
    ...baseConfig,
    model: s.model,
    effort: s.effort || undefined,
    contextWindow: contextWindowFor(s.model),
  };
}

function systemPrompt(s) {
  return buildSystemPrompt({
    ...collectEnv(s.projectDir),
    projectInstructions: loadProjectInstructions(s.projectDir),
    skillSummaries: s.skills.map(({ name, description }) => ({ name, description })),
  });
}

export function answer(convId, text) {
  const s = sessions.get(convId);
  if (s?.pendingAsk) s.pendingAsk(text);
}

export function stop(convId) {
  const s = sessions.get(convId);
  if (s?.abort) s.abort.abort();
}

export function setModel(convId, model) {
  const s = sessions.get(convId);
  if (s) s.model = model;
}

export function setEffort(convId, effort) {
  const s = sessions.get(convId);
  if (s) s.effort = effort || undefined;
}

export function sessionMeta(convId) {
  const s = sessions.get(convId);
  return s
    ? { model: s.model, effort: s.effort ?? "" }
    : { model: baseConfig?.model, effort: baseConfig?.effort ?? "" };
}

export function listSkills(projectDir) {
  return loadSkills({ cwd: projectDir }).map(({ name, description }) => ({
    name,
    description,
  }));
}

export function projectContext(projectDir) {
  const run = (args) => {
    const r = spawnSync("git", args, { cwd: projectDir, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = run(["status", "--short"]);
  return {
    folder: basename(projectDir),
    branch,
    changes: status ? status.split("\n").filter(Boolean) : [],
  };
}

export function searchFiles(projectDir, query) {
  const r = spawnSync("rg", ["--files"], {
    cwd: projectDir,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0 && r.status !== 1) return [];
  const q = query.toLowerCase();
  return (r.stdout || "")
    .split("\n")
    .filter((f) => f && f.toLowerCase().includes(q))
    .slice(0, 8);
}

// 发送一条用户输入。事件经 s.emit 流出（含合成事件 notice/ask/todos）。
export async function send(convId, projectDir, text, savedBlocks, emit) {
  const s = getSession(convId, projectDir, savedBlocks);
  s.emit = emit;
  if (s.running) {
    emit({ type: "notice", text: "当前回合仍在进行中" });
    return;
  }

  // 斜杠命令（GUI 支持 /compact /clear 与技能名；其余内置在 GUI 中无意义）
  let turnInput = text;
  if (text.startsWith("/")) {
    const d = dispatchSlash(text, s.skills);
    if (d.kind === "builtin") {
      if (d.command === "compact") {
        const r = await forceCompact({
          history: s.history,
          client: createApiClient(config(s)),
          config: config(s),
        });
        emit({
          type: "notice",
          text: r.compacted
            ? `已压缩：估算 token ${r.beforeTokens} → ${r.afterTokens}`
            : (r.warning ?? "会话历史太短，无需压缩"),
        });
      } else if (d.command === "clear") {
        s.history = new History();
        s.todoStore.todos = [];
        emit({ type: "cleared" });
      } else {
        emit({ type: "notice", text: `GUI 暂不支持 /${d.command}` });
      }
      return;
    }
    if (d.kind === "skill") {
      turnInput = d.turn;
      emit({ type: "notice", text: `[触发技能 ${d.name}]` });
    }
    // unknown 斜杠按普通文本发送
  }

  s.running = true;
  s.abort = new AbortController();
  const cfg = config(s);
  const client = createApiClient(cfg);

  try {
    const r = await maybeCompact({ history: s.history, client, config: cfg });
    if (r.compacted) {
      emit({
        type: "notice",
        text: `历史接近上下文窗口上限，已自动压缩：${r.beforeTokens} → ${r.afterTokens}`,
      });
    } else if (r.warning) {
      emit({ type: "notice", text: `[压缩警告] ${r.warning}` });
    }
    await runTurn({
      userInput: turnInput,
      history: s.history,
      registry: s.registry,
      client,
      config: cfg,
      system: systemPrompt(s),
      signal: s.abort.signal,
      onEvent: emit,
    });
  } catch (err) {
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    emit({ type: "turn_end", reason: "end_turn" });
  } finally {
    s.running = false;
    s.abort = null;
    s.pendingAsk = null;
  }
}
