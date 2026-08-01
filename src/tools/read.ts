import { readFile, stat } from "node:fs/promises";
import { asRecord, toolError, type Tool, type ToolResult } from "../types/tools.js";

const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;

export const readTool: Tool = {
  name: "Read",
  description:
    "Reads a file from the local filesystem and returns its content with cat -n style line numbers " +
    "(right-aligned line number followed by a tab). " +
    "The required `file_path` parameter is the path of the file to read. " +
    "The optional `offset` is the 1-based line number to start from and `limit` is the maximum number of lines to return; " +
    "by default reading starts at the beginning and returns at most 2000 lines. " +
    "Lines longer than 2000 characters are truncated with a marker. " +
    "Reading a missing file or a directory returns an explicit error.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The path of the file to read",
      },
      offset: {
        type: "number",
        description: "1-based line number to start reading from (default 1)",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to return (default 2000)",
      },
    },
    required: ["file_path"],
  },
  async execute(input: unknown): Promise<ToolResult> {
    const args = asRecord(input);
    const filePath = args.file_path;
    if (typeof filePath !== "string" || filePath.length === 0) {
      return toolError("Read: `file_path` is required and must be a non-empty string");
    }

    let offset = 1;
    if (args.offset !== undefined) {
      if (typeof args.offset !== "number" || !Number.isInteger(args.offset) || args.offset < 1) {
        return toolError("Read: `offset` must be a positive integer (1-based line number)");
      }
      offset = args.offset;
    }
    let limit = DEFAULT_LIMIT;
    if (args.limit !== undefined) {
      if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1) {
        return toolError("Read: `limit` must be a positive integer");
      }
      limit = args.limit;
    }

    let content: string;
    try {
      const st = await stat(filePath);
      if (st.isDirectory()) {
        return toolError(`Read: ${filePath} is a directory, not a file`);
      }
      content = await readFile(filePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return toolError(`Read: file does not exist: ${filePath}`);
      }
      return toolError(`Read: failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const lines = content.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

    if (offset > lines.length) {
      return toolError(`Read: offset ${offset} is beyond end of file (${lines.length} lines)`);
    }

    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const rendered = selected
      .map((line, i) => {
        const lineNo = offset + i;
        const text =
          line.length > MAX_LINE_CHARS
            ? `${line.slice(0, MAX_LINE_CHARS)}... [line truncated]`
            : line;
        return `${String(lineNo).padStart(6)}\t${text}`;
      })
      .join("\n");

    return { content: rendered };
  },
};
