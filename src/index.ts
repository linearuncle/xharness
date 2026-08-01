#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { createDefaultRegistry } from "./tools/registry.js";
import { createApiClient } from "./api/client.js";
import { buildSystemPrompt, collectEnv } from "./agent/prompts.js";
import { runTurn } from "./agent/loop.js";
import { History } from "./session/history.js";

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

async function runPrompt(userInput: string): Promise<void> {
  const config = loadConfig();
  const registry = createDefaultRegistry();
  const client = createApiClient(config);
  const env = collectEnv(process.cwd());
  const system = buildSystemPrompt({
    ...env,
    projectInstructions: "",
    skillSummaries: [],
  });
  const history = new History();

  await runTurn({
    userInput,
    history,
    registry,
    client,
    config,
    system,
    onEvent: (event) => {
      if (event.type === "text_delta") {
        process.stdout.write(event.text);
      } else if (event.type === "tool_start") {
        process.stderr.write(`⏺ ${event.name}\n`);
      } else if (event.type === "error") {
        process.stderr.write(`错误: ${event.message}\n`);
      }
    },
  });
  process.stdout.write("\n");
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
      console.error("用法: xharness -p \"<提示词>\"");
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

  console.log("xharness: REPL not implemented yet");
  process.exit(0);
}

void main();
