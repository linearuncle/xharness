import { spawnSync } from "node:child_process";
import { asRecord, toolError, type Tool, type ToolResult } from "../types/tools.js";

const MAX_RESULT_LINES = 200;

export const grepTool: Tool = {
  name: "Grep",
  description:
    "Searches file contents with a regular expression using ripgrep (rg). " +
    "The required `pattern` parameter is a ripgrep regex; the optional `path` parameter is the file or directory to search " +
    "(defaults to the current working directory); the optional `glob` parameter filters files by a glob pattern such as *.ts. " +
    "Results are returned as file:line:content lines. " +
    "When nothing matches, the result is the string \"no matches\" (not an error). " +
    "Only the first 200 matching lines are returned; the rest are noted as omitted.",
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
  async execute(input: unknown): Promise<ToolResult> {
    const args = asRecord(input);
    const pattern = args.pattern;
    if (typeof pattern !== "string" || pattern.length === 0) {
      return toolError("Grep: `pattern` is required and must be a non-empty string");
    }
    if (args.path !== undefined && typeof args.path !== "string") {
      return toolError("Grep: `path` must be a string");
    }
    if (args.glob !== undefined && typeof args.glob !== "string") {
      return toolError("Grep: `glob` must be a string");
    }

    const rgArgs = ["--line-number", "--no-heading"];
    if (typeof args.glob === "string" && args.glob.length > 0) {
      rgArgs.push("--glob", args.glob);
    }
    rgArgs.push("--", pattern, typeof args.path === "string" && args.path.length > 0 ? args.path : ".");

    let result;
    try {
      result = spawnSync("rg", rgArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      return toolError(`Grep: failed to run rg: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (result.error) {
      return toolError(`Grep: failed to run rg: ${result.error.message}`);
    }
    if (result.status === 1) {
      return { content: "no matches" };
    }
    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").trim();
      return toolError(`Grep: rg failed (exit code ${result.status})${stderr ? `: ${stderr}` : ""}`);
    }

    const lines = result.stdout.split("\n").filter((line) => line.length > 0);
    if (lines.length === 0) {
      return { content: "no matches" };
    }
    if (lines.length > MAX_RESULT_LINES) {
      const shown = lines.slice(0, MAX_RESULT_LINES);
      shown.push(`... [${lines.length - MAX_RESULT_LINES} more lines omitted]`);
      return { content: shown.join("\n") };
    }
    return { content: lines.join("\n") };
  },
};
