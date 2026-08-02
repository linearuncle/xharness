import { spawn } from "node:child_process";
import type { ToolUseBlock } from "../types/messages.js";
import type { PreToolUseDecision, PreToolUseHook } from "../types/hooks.js";
import type { Plugin, PluginHookSpec } from "./loader.js";

const MAX_OUTPUT = 1024 * 1024;

/**
 * Hook 协议（兼容 codex/Claude Code 风格）：
 *   stdin  <- {"hook_event_name":"PreToolUse","tool_name":...,"tool_input":...,"cwd":...}
 *   stdout -> {"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"..."}}
 * 显式 deny、非零退出、超时、spawn 失败 → 拒绝（守护类插件按 fail-closed 处理自身故障）；
 * 正常退出且无 deny 输出 → 放行。
 */
function runHookCommand(
  plugin: Plugin,
  spec: PluginHookSpec,
  toolUse: ToolUseBlock
): Promise<PreToolUseDecision> {
  return new Promise((resolve) => {
    const deny = (reason: string): void =>
      resolve({ behavior: "deny", reason });

    let child;
    try {
      child = spawn("/bin/sh", ["-c", spec.command], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PLUGIN_ROOT: plugin.root,
          NODE: process.execPath,
          // 打包版 GUI 里 process.execPath 是 Electron；置此变量让 ${NODE} 以纯 node 模式运行脚本
          ELECTRON_RUN_AS_NODE: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      deny(
        `[插件 ${plugin.name}] hook 启动失败（${err instanceof Error ? err.message : String(err)}），按 fail-closed 拦截`
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        deny(`[插件 ${plugin.name}] hook 超时（${spec.timeout}s），按 fail-closed 拦截`)
      );
    }, spec.timeout * 1000);

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      finish(() =>
        deny(`[插件 ${plugin.name}] hook 执行出错（${err.message}），按 fail-closed 拦截`)
      );
    });
    child.on("close", (code) => {
      finish(() => {
        if (code !== 0) {
          deny(
            `[插件 ${plugin.name}] hook 异常退出（code ${code}）` +
              (stderr.trim() ? `：${stderr.trim().slice(0, 500)}` : "") +
              "，按 fail-closed 拦截"
          );
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          const out = (parsed as { hookSpecificOutput?: Record<string, unknown> })
            .hookSpecificOutput;
          if (out?.permissionDecision === "deny") {
            const reason =
              typeof out.permissionDecisionReason === "string"
                ? out.permissionDecisionReason
                : "(插件未提供原因)";
            deny(`[插件 ${plugin.name}] ${reason}`);
            return;
          }
        } catch {
          // 无输出/非 JSON 输出且正常退出：hook 未表达裁决，放行
        }
        resolve({ behavior: "allow" });
      });
    });

    child.stdin.on("error", () => {
      /* hook 可能不读 stdin 就退出（EPIPE）：裁决以退出码/输出为准 */
    });
    child.stdin.end(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: toolUse.name,
        tool_input: toolUse.input,
        cwd: process.cwd(),
      })
    );
  });
}

/**
 * 把已启用插件的 preToolUse hooks 组装成 loop 可挂载的回调。
 * 按插件声明顺序串行执行匹配的 hook，首个 deny 即返回。
 */
export function createPreToolUseHook(plugins: Plugin[]): PreToolUseHook {
  const active = plugins.filter((p) => p.enabled && p.preToolUse.length > 0);
  return async (toolUse) => {
    for (const plugin of active) {
      for (const spec of plugin.preToolUse) {
        if (!new RegExp(spec.matcher).test(toolUse.name)) continue;
        const decision = await runHookCommand(plugin, spec, toolUse);
        if (decision.behavior === "deny") return decision;
      }
    }
    return { behavior: "allow" };
  };
}
