import { glob as fsGlob, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { asRecord, toolError, type Tool, type ToolResult } from "../types/tools.js";

export const globTool: Tool = {
  name: "Glob",
  description:
    "Finds files whose paths match a glob pattern, such as **/*.ts or src/**/*.test.ts. " +
    "The required `pattern` parameter is the glob pattern; the optional `path` parameter is the base directory to search " +
    "(defaults to the current working directory). " +
    "Matching file paths are returned one per line, sorted by modification time (newest first). " +
    "node_modules and .git directories are always ignored. " +
    "When nothing matches, the result is the string \"no matches\" (not an error).",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The glob pattern to match file paths against",
      },
      path: {
        type: "string",
        description: "Base directory to search in (defaults to cwd)",
      },
    },
    required: ["pattern"],
  },
  async execute(input: unknown): Promise<ToolResult> {
    const args = asRecord(input);
    const pattern = args.pattern;
    if (typeof pattern !== "string" || pattern.length === 0) {
      return toolError("Glob: `pattern` is required and must be a non-empty string");
    }
    if (args.path !== undefined && typeof args.path !== "string") {
      return toolError("Glob: `path` must be a string");
    }
    const base = resolve(typeof args.path === "string" && args.path.length > 0 ? args.path : ".");

    const matches: { path: string; mtimeMs: number }[] = [];
    try {
      for await (const entry of fsGlob(pattern, {
        cwd: base,
        exclude: ["**/node_modules/**", "**/.git/**"],
      })) {
        const full = resolve(base, entry);
        try {
          const st = await stat(full);
          if (st.isFile()) {
            matches.push({ path: full, mtimeMs: st.mtimeMs });
          }
        } catch {
          // entry disappeared between glob and stat; skip
        }
      }
    } catch (err) {
      return toolError(`Glob: failed to match pattern: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (matches.length === 0) {
      return { content: "no matches" };
    }
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { content: matches.map((m) => m.path).join("\n") };
  },
};
