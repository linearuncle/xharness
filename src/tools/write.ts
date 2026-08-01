import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { asRecord, toolError, type Tool, type ToolResult } from "../types/tools.js";

export const writeTool: Tool = {
  name: "Write",
  description:
    "Writes a file to the local filesystem, creating it if it does not exist and overwriting it if it does. " +
    "The required `file_path` parameter is the destination path and `content` is the full text to write. " +
    "Parent directories are created automatically (mkdir -p). " +
    "Returns the number of bytes written and the destination path.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The destination file path",
      },
      content: {
        type: "string",
        description: "The full content to write to the file",
      },
    },
    required: ["file_path", "content"],
  },
  async execute(input: unknown): Promise<ToolResult> {
    const args = asRecord(input);
    const filePath = args.file_path;
    if (typeof filePath !== "string" || filePath.length === 0) {
      return toolError("Write: `file_path` is required and must be a non-empty string");
    }
    const content = args.content;
    if (typeof content !== "string") {
      return toolError("Write: `content` is required and must be a string");
    }

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
    } catch (err) {
      return toolError(`Write: failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const bytes = Buffer.byteLength(content, "utf8");
    return { content: `Wrote ${bytes} bytes to ${filePath}` };
  },
};
