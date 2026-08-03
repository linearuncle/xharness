import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import {
  asRecord,
  toolError,
  type Tool,
  type ToolExecuteContext,
  type ToolResult,
} from "../types/tools.js";

const MAX_RESULT_LINES = 200;
const MAX_LINE_CHARS = 1_000;
const MAX_RESULT_BYTES = 40_000;
const RESULT_NOTICE_RESERVE_BYTES = 512;
const MAX_BODY_BYTES = MAX_RESULT_BYTES - RESULT_NOTICE_RESERVE_BYTES;
const MAX_RAW_STDOUT_BYTES = 5_000_000;
const MAX_STDERR_CHARS = 64_000;
const DEFAULT_TIMEOUT_MS = 20_000;

interface TruncationState {
  lines: boolean;
  lineChars: boolean;
  resultBytes: boolean;
  rawBytes: boolean;
}

type StopReason = "lines" | "result_bytes" | "raw_bytes" | "timeout" | "interrupted";

function clipLine(line: string): { text: string; truncated: boolean } {
  const chars = [...line];
  if (chars.length <= MAX_LINE_CHARS) return { text: line, truncated: false };
  const suffix = `… [line truncated; original ${chars.length} chars]`;
  const keep = Math.max(0, MAX_LINE_CHARS - [...suffix].length);
  return { text: chars.slice(0, keep).join("") + suffix, truncated: true };
}

function clipUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const chars: string[] = [];
  let used = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (used + bytes > maxBytes) break;
    chars.push(char);
    used += bytes;
  }
  return chars.join("");
}

function truncationNotice(state: TruncationState): string {
  const reasons: string[] = [];
  if (state.lines) reasons.push(`${MAX_RESULT_LINES}-line result limit reached`);
  if (state.lineChars) reasons.push(`one or more lines exceeded ${MAX_LINE_CHARS} characters`);
  if (state.resultBytes) reasons.push(`${MAX_RESULT_BYTES}-byte result limit reached`);
  if (state.rawBytes) reasons.push(`${MAX_RAW_STDOUT_BYTES}-byte raw-output limit reached`);
  if (reasons.length === 0) return "";
  return (
    `… [results truncated: ${reasons.join("; ")}. ` +
    "Refine pattern/path or use Read for a specific file.]"
  );
}

function formatResult(lines: string[], state: TruncationState): string {
  const body = lines.join("\n");
  const notice = truncationNotice(state);
  if (!notice) return body;
  const separator = body.length > 0 ? "\n" : "";
  const bodyBudget = Math.max(
    0,
    MAX_RESULT_BYTES - Buffer.byteLength(separator) - Buffer.byteLength(notice)
  );
  return clipUtf8Bytes(body, bodyBudget) + separator + notice;
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined && process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to killing the direct child when the process group is already gone.
  }
  try {
    child.kill(signal);
  } catch {
    // Process already exited.
  }
}

export function createGrepTool(options: { rgCommand?: string; timeoutMs?: number } = {}): Tool {
  const rgCommand = options.rgCommand ?? "rg";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    name: "Grep",
    description:
      "Searches file contents with a regular expression using ripgrep (rg). " +
      "The required `pattern` parameter is a ripgrep regex; the optional `path` parameter is the file or directory to search " +
      "(defaults to the current working directory); the optional `glob` parameter filters files by a glob pattern such as *.ts. " +
      "Results are returned as file:line:content lines and respect ripgrep ignore rules. " +
      "When searching a directory, files larger than 5MB are skipped. Searches time out after 20 seconds. " +
      "Results are capped at 200 matching lines, 1000 characters per line, and 40000 UTF-8 bytes total; " +
      "when truncated, the result says why and should be refined or followed with Read. " +
      "When nothing matches, the result is the string \"no matches\" (not an error).",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The regular expression to search for (ripgrep syntax)",
        },
        path: {
          type: "string",
          description: "File or directory to search in (defaults to cwd)",
        },
        glob: {
          type: "string",
          description: "Glob pattern to filter files (e.g. *.ts), passed to rg --glob",
        },
      },
      required: ["pattern"],
    },
    execute(input: unknown, context?: ToolExecuteContext): Promise<ToolResult> {
      const args = asRecord(input);
      const pattern = args.pattern;
      if (typeof pattern !== "string" || pattern.length === 0) {
        return Promise.resolve(toolError("Grep: `pattern` is required and must be a non-empty string"));
      }
      if (args.path !== undefined && typeof args.path !== "string") {
        return Promise.resolve(toolError("Grep: `path` must be a string"));
      }
      if (args.glob !== undefined && typeof args.glob !== "string") {
        return Promise.resolve(toolError("Grep: `glob` must be a string"));
      }
      const signal = context?.signal;
      if (signal?.aborted) {
        return Promise.resolve(toolError("Grep: search was interrupted before execution."));
      }

      const rgArgs = [
        "--line-number",
        "--no-heading",
        "--max-columns",
        String(MAX_LINE_CHARS),
        "--max-columns-preview",
        "--max-filesize",
        "5M",
      ];
      if (typeof args.glob === "string" && args.glob.length > 0) {
        rgArgs.push("--glob", args.glob);
      }
      rgArgs.push(
        "--",
        pattern,
        typeof args.path === "string" && args.path.length > 0 ? args.path : "."
      );

      return new Promise<ToolResult>((resolve) => {
        let child: ChildProcess;
        try {
          child = spawn(rgCommand, rgArgs, {
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (err) {
          resolve(
            toolError(
              `Grep: failed to run rg: ${err instanceof Error ? err.message : String(err)}`
            )
          );
          return;
        }

        const lines: string[] = [];
        const truncation: TruncationState = {
          lines: false,
          lineChars: false,
          resultBytes: false,
          rawBytes: false,
        };
        let bodyBytes = 0;
        let rawBytes = 0;
        let stderr = "";
        let stopReason: StopReason | undefined;
        let settled = false;
        let reader: Interface | undefined;

        const stop = (reason: StopReason, processSignal: NodeJS.Signals) => {
          if (stopReason !== undefined) return;
          stopReason = reason;
          killProcessGroup(child, processSignal);
        };
        const onAbort = () => stop("interrupted", "SIGTERM");
        signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => stop("timeout", "SIGKILL"), timeoutMs);

        const done = (result: ToolResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reader?.close();
          resolve(result);
        };

        if (child.stdout) {
          reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
          reader.on("line", (line) => {
            if (stopReason !== undefined) return;
            rawBytes += Buffer.byteLength(line) + 1;
            if (rawBytes > MAX_RAW_STDOUT_BYTES) {
              truncation.rawBytes = true;
              stop("raw_bytes", "SIGTERM");
              return;
            }
            if (line.length === 0) return;
            if (lines.length >= MAX_RESULT_LINES) {
              truncation.lines = true;
              stop("lines", "SIGTERM");
              return;
            }

            const clipped = clipLine(line);
            if (clipped.truncated) truncation.lineChars = true;
            const addedBytes = Buffer.byteLength(clipped.text) + (lines.length > 0 ? 1 : 0);
            if (bodyBytes + addedBytes > MAX_BODY_BYTES) {
              truncation.resultBytes = true;
              stop("result_bytes", "SIGTERM");
              return;
            }
            lines.push(clipped.text);
            bodyBytes += addedBytes;
          });
        }
        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderr.length >= MAX_STDERR_CHARS) return;
          stderr += chunk.toString("utf8").slice(0, MAX_STDERR_CHARS - stderr.length);
        });
        child.on("error", (err) => {
          done(toolError(`Grep: failed to run rg: ${err.message}`));
        });
        child.on("close", (code, closeSignal) => {
          if (stopReason === "interrupted") {
            done(toolError("Grep: search was interrupted; SIGTERM sent to process group."));
            return;
          }
          if (stopReason === "timeout") {
            done(toolError(`Grep: search timed out after ${timeoutMs}ms; process group killed.`));
            return;
          }

          const stoppedAtLimit =
            stopReason === "lines" || stopReason === "result_bytes" || stopReason === "raw_bytes";
          if (!stoppedAtLimit && code !== 0 && code !== 1) {
            const detail = stderr.trim();
            const status = code === null ? `signal ${closeSignal ?? "unknown"}` : `exit code ${code}`;
            done(toolError(`Grep: rg failed (${status})${detail ? `: ${detail}` : ""}`));
            return;
          }
          if (lines.length === 0 && !stoppedAtLimit) {
            done({ content: "no matches" });
            return;
          }
          done({ content: formatResult(lines, truncation) });
        });
      });
    },
  };
}

export const grepTool: Tool = createGrepTool();
