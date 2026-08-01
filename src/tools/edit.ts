import { readFile, writeFile } from "node:fs/promises";
import { asRecord, toolError, type Tool, type ToolResult } from "../types/tools.js";

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export const editTool: Tool = {
  name: "Edit",
  description:
    "Performs an exact string replacement in an existing file. " +
    "The required parameters are `file_path`, `old_string` (the exact text to find) and `new_string` (the replacement text). " +
    "`old_string` must occur exactly once in the file; if it occurs zero times or more than once the edit fails " +
    "and the error reports the actual match count. " +
    "Set `replace_all` to true to replace every occurrence instead. " +
    "`old_string` and `new_string` must be different.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The path of the file to edit",
      },
      old_string: {
        type: "string",
        description: "The exact text to replace (must be unique unless replace_all is true)",
      },
      new_string: {
        type: "string",
        description: "The text to replace it with",
      },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences of old_string (default false)",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  async execute(input: unknown): Promise<ToolResult> {
    const args = asRecord(input);
    const filePath = args.file_path;
    if (typeof filePath !== "string" || filePath.length === 0) {
      return toolError("Edit: `file_path` is required and must be a non-empty string");
    }
    const oldString = args.old_string;
    const newString = args.new_string;
    if (typeof oldString !== "string" || oldString.length === 0) {
      return toolError("Edit: `old_string` is required and must be a non-empty string");
    }
    if (typeof newString !== "string") {
      return toolError("Edit: `new_string` is required and must be a string");
    }
    if (oldString === newString) {
      return toolError("Edit: `old_string` and `new_string` must be different");
    }
    const replaceAll = args.replace_all === true;

    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return toolError(`Edit: file does not exist: ${filePath}`);
      }
      return toolError(`Edit: failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const count = countOccurrences(content, oldString);
    if (count === 0) {
      return toolError(`Edit: old_string not found in ${filePath} (0 matches)`);
    }
    if (count > 1 && !replaceAll) {
      return toolError(
        `Edit: old_string matched ${count} times in ${filePath}; it must match exactly once. ` +
          "Provide a larger unique context or set replace_all to true.",
      );
    }

    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    try {
      await writeFile(filePath, updated, "utf8");
    } catch (err) {
      return toolError(`Edit: failed to write ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const replaced = replaceAll ? count : 1;
    return { content: `Replaced ${replaced} occurrence${replaced === 1 ? "" : "s"} in ${filePath}` };
  },
};
