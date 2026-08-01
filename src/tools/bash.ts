import { spawn } from "node:child_process";
import {
  asRecord,
  toolError,
  type Tool,
  type ToolExecuteContext,
  type ToolResult,
} from "../types/tools.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const half = Math.floor(MAX_OUTPUT_CHARS / 2);
  const omitted = text.length - half * 2;
  return (
    text.slice(0, half) +
    `\n... [${omitted} characters omitted] ...\n` +
    text.slice(text.length - half)
  );
}

export const bashTool: Tool = {
  name: "Bash",
  description:
    "Executes a shell command via bash -c and returns its combined stdout and stderr. " +
    "The required `command` parameter is the exact command line to run. " +
    "The optional `timeout` parameter is in milliseconds (default 120000, capped at 600000); " +
    "when the timeout is reached the whole process group is killed and the result is marked as timed out. " +
    "Output longer than 30000 characters is truncated in the middle, keeping the head and tail with a note of how many characters were omitted. " +
    "A non-zero exit code is reported as an error together with the captured output.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
      timeout: {
        type: "number",
        description:
          "Optional timeout in milliseconds (default 120000, max 600000)",
      },
    },
    required: ["command"],
  },
  execute(input: unknown, context?: ToolExecuteContext): Promise<ToolResult> {
    const args = asRecord(input);
    const signal = context?.signal;
    const command = args.command;
    if (typeof command !== "string" || command.length === 0) {
      return Promise.resolve(toolError("Bash: `command` is required and must be a non-empty string"));
    }
    if (signal?.aborted) {
      return Promise.resolve(toolError("Command was interrupted before execution."));
    }
    let timeout = DEFAULT_TIMEOUT_MS;
    if (args.timeout !== undefined) {
      if (typeof args.timeout !== "number" || !Number.isFinite(args.timeout) || args.timeout <= 0) {
        return Promise.resolve(toolError("Bash: `timeout` must be a positive number of milliseconds"));
      }
      timeout = Math.min(args.timeout, MAX_TIMEOUT_MS);
    }

    return new Promise<ToolResult>((resolve) => {
      let settled = false;
      const done = (result: ToolResult) => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      let child;
      try {
        child = spawn("bash", ["-c", command], { detached: true });
      } catch (err) {
        done(toolError(`Bash: failed to spawn: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }

      let output = "";
      let timedOut = false;
      let interrupted = false;
      const onAbort = () => {
        interrupted = true;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {
            // process already gone
          }
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // process already gone
          }
        }
      }, timeout);

      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        done(toolError(`Bash: failed to spawn: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const content = truncateOutput(output);
        if (interrupted) {
          done({
            content: `Command was interrupted; SIGTERM sent to process group.\n${content}`,
            isError: true,
          });
        } else if (timedOut) {
          done({
            content: `Command timed out after ${timeout}ms; process group killed.\n${content}`,
            isError: true,
          });
        } else if (code !== 0) {
          done({
            content: `${content}${content.length > 0 ? "\n" : ""}Exit code: ${code}`,
            isError: true,
          });
        } else {
          done({ content: content.length > 0 ? content : "(no output)" });
        }
      });
    });
  },
};
