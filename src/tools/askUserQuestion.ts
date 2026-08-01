import {
  asRecord,
  toolError,
  type Tool,
  type ToolExecuteContext,
  type ToolResult,
} from "../types/tools.js";

export type PromptFn = (rendered: string) => Promise<string>;

interface QuestionOption {
  label: string;
  description: string;
}

function parseOptions(raw: unknown): QuestionOption[] | string {
  if (!Array.isArray(raw)) {
    return "AskUserQuestion: `options` is required and must be an array";
  }
  if (raw.length < 2 || raw.length > 4) {
    return `AskUserQuestion: \`options\` must contain 2 to 4 items, got ${raw.length}`;
  }
  const options: QuestionOption[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (typeof rec.label !== "string" || rec.label.length === 0) {
      return "AskUserQuestion: each option requires a non-empty string `label`";
    }
    if (typeof rec.description !== "string") {
      return "AskUserQuestion: each option requires a string `description`";
    }
    options.push({ label: rec.label, description: rec.description });
  }
  return options;
}

function renderPrompt(question: string, options: QuestionOption[]): string {
  const lines = [question];
  options.forEach((opt, i) => {
    lines.push(`  ${i + 1}) ${opt.label} — ${opt.description}`);
  });
  lines.push("请输入编号选择，或直接输入其他回答: ");
  return lines.join("\n");
}

const INTERRUPTED_RESULT = "[等待用户作答时被中断]";

function waitForAnswer(
  promptFn: PromptFn,
  rendered: string,
  signal?: AbortSignal
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (!settled) {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      }
    };
    const onAbort = () => finish(null);
    signal?.addEventListener("abort", onAbort, { once: true });
    promptFn(rendered).then(
      (answer) => finish(answer),
      () => finish(null)
    );
  });
}

export function createAskUserQuestionTool(promptFn: PromptFn): Tool {
  return {
    name: "AskUserQuestion",
    description:
      "Asks the user a multiple-choice question and blocks until they answer. " +
      "Use this when you need a decision from the user before continuing, such as choosing between " +
      "implementation approaches, confirming a destructive change, or clarifying ambiguous requirements. " +
      "Provide a clear `question` and 2 to 4 `options`, each with a short `label` and a one-line `description` " +
      "explaining the tradeoff. The options are shown as a numbered list; the user picks a number or types " +
      "free-form text instead (equivalent to answering \"Other\"). The user's choice or text is returned as " +
      "the tool result. Do not use this tool for questions that can be answered by reading files or running commands.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to present to the user",
        },
        options: {
          type: "array",
          description:
            "2 to 4 answer options; each item has a `label` (short answer text) and a `description` (one-line explanation)",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short answer text shown to the user" },
              description: { type: "string", description: "One-line explanation of this option" },
            },
            required: ["label", "description"],
          },
        },
      },
      required: ["question", "options"],
    },
    async execute(input: unknown, context?: ToolExecuteContext): Promise<ToolResult> {
      const args = asRecord(input);
      const signal = context?.signal;
      if (typeof args.question !== "string" || args.question.length === 0) {
        return toolError("AskUserQuestion: `question` is required and must be a non-empty string");
      }
      const options = parseOptions(args.options);
      if (typeof options === "string") {
        return toolError(options);
      }
      const rendered = renderPrompt(args.question, options);

      for (;;) {
        if (signal?.aborted) {
          return toolError(INTERRUPTED_RESULT);
        }
        const answer = await waitForAnswer(promptFn, rendered, signal);
        if (answer === null) {
          return toolError(INTERRUPTED_RESULT);
        }
        const trimmed = answer.trim();
        if (trimmed.length === 0) continue;
        if (/^\d+$/.test(trimmed)) {
          const index = Number.parseInt(trimmed, 10);
          if (index >= 1 && index <= options.length) {
            return { content: `用户选择: ${options[index - 1].label}` };
          }
        }
        return { content: `用户输入: ${trimmed}` };
      }
    },
  };
}
