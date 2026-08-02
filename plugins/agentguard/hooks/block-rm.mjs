#!/usr/bin/env node
// AgentGuard for xharness —— 移植自 codex-agentguard 的 block_rm.py（MIT）
// https://github.com/linearuncle/codex-agentguard
//
// 威胁模型是"粗心的 agent"而非"恶意的人"：agent 误删时删除命令一定是明文写出的
// （rm -rf、DROP TABLE），所以检测就是对命令原文做模式匹配。误报（注释或字符串里
// 出现删除关键词）是有意接受的：拦错的代价只是 agent 停下来问用户一句。
// Hook 输入异常时按 fail-closed 策略直接拒绝。
//
// xharness 适配：只挂 Bash 工具（xharness 的 Edit/Write 无删除语义、无 MCP/apply_patch），
// 文件删除与 SQL 删除规则原样保留。

const FILE_DELETE_RULES = [
  ["rm/unlink/rmdir", /(?<![A-Za-z0-9_])(?:rm|unlink|rmdir)(?![A-Za-z0-9_])/],
  ["find -delete", /(?<![A-Za-z0-9_])find(?![A-Za-z0-9_])[^\n;|&]*\s-delete(?:\s|$)/],
  ["git clean", /(?<![A-Za-z0-9_])git(?:\s+\S+){0,3}?\s+clean(?![A-Za-z0-9_])/],
  [
    "Python file-deletion API",
    /(?:os\.(?:remove|unlink|rmdir)|shutil\.rmtree|Path\([^\n)]*\)\.(?:unlink|rmdir))\s*\(/,
  ],
  [
    "Node.js file-deletion API",
    /fs(?:\.promises)?\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/,
  ],
];

const SQL_DELETE_RULES = [
  ["SQL DROP", /\bDROP\s+(?:DATABASE|SCHEMA|TABLE|VIEW|COLLECTION)\b/i],
  ["SQL TRUNCATE", /\bTRUNCATE\b/i],
  ["SQL DELETE FROM", /\bDELETE\s+FROM\b/i],
];

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
}

function denyDeletion(rules, text) {
  deny(
    "AgentGuard blocked a deletion operation. Nothing was executed.\n" +
      "Matched rules:\n" +
      rules.map((rule) => `- ${rule}`).join("\n") +
      "\n" +
      "Full blocked input:\n" +
      `${text}\n` +
      "Deletion by the agent is not allowed. Do not retry or work around this " +
      "block. If this deletion is really needed, the user must run it manually.\n" +
      "[中文] AgentGuard 已拦截删除操作，未执行任何命令。命中规则和被拦截的" +
      "完整命令见上。不允许 agent 执行删除操作，请勿重试或绕过；如确认需要" +
      "删除，请用户自己手工执行。"
  );
}

function matchedRules(text, rules) {
  return rules.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch (error) {
    deny(
      `AgentGuard could not inspect the command safely (${error.message}); blocked by fail-closed policy.\n` +
        "[中文] AgentGuard 无法安全解析本次输入，已按 fail-closed 策略拦截。"
    );
    return;
  }

  const toolInput = payload?.tool_input;
  if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput)) {
    return;
  }
  if (payload?.tool_name !== "Bash") return;

  const command = toolInput.command ?? "";
  if (typeof command !== "string") {
    deny(
      "AgentGuard received a non-text shell command; blocked by fail-closed policy.\n" +
        "[中文] AgentGuard 收到非文本的 shell 命令，已按 fail-closed 策略拦截。"
    );
    return;
  }
  const rules = matchedRules(command, [...FILE_DELETE_RULES, ...SQL_DELETE_RULES]);
  if (rules.length > 0) denyDeletion(rules, command);
}

main();
