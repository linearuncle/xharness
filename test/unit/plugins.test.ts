import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runTurn } from "../../src/agent/loop.js";
import type {
  ApiClient,
  StreamMessageOptions,
  StreamMessageResult,
} from "../../src/api/client.js";
import type { Config } from "../../src/config.js";
import { loadPlugins, type Plugin } from "../../src/plugins/loader.js";
import { createPreToolUseHook } from "../../src/plugins/hooks.js";
import {
  assertInGlobalDir,
  ensureDefaultPlugins,
  installFromLocalDir,
  removePlugin,
  setPluginEnabled,
  writeManifest,
} from "../../src/plugins/install.js";
import { History } from "../../src/session/history.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type {
  Message,
  ToolResultBlock,
  ToolUseBlock,
} from "../../src/types/messages.js";

const here = dirname(fileURLToPath(import.meta.url));
const AGENTGUARD_SCRIPT = join(here, "..", "..", "plugins", "agentguard", "hooks", "block-rm.mjs");

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xh-plugins-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function writePlugin(
  root: string,
  dirName: string,
  manifest: Record<string, unknown>
): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

function guardManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "p1",
    version: "1.0.0",
    description: "测试插件",
    hooks: { preToolUse: [{ matcher: "^Bash$", command: "true", timeout: 5 }] },
    ...overrides,
  };
}

const noWarn = () => {};

describe("plugins/loader", () => {
  it("解析清单并应用默认值", () => {
    const g = tempDir();
    writePlugin(g, "p1", guardManifest());
    const plugins = loadPlugins({ globalDir: g, projectDir: null, warn: noWarn });
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({
      name: "p1",
      version: "1.0.0",
      enabled: true,
    });
    expect(plugins[0].preToolUse[0].timeout).toBe(5);
  });

  it("项目级覆盖全局同名插件", () => {
    const g = tempDir();
    const proj = tempDir();
    writePlugin(g, "p1", guardManifest({ version: "1.0.0" }));
    writePlugin(proj, "p1", guardManifest({ version: "2.0.0" }));
    const plugins = loadPlugins({ globalDir: g, projectDir: proj, warn: noWarn });
    expect(plugins).toHaveLength(1);
    expect(plugins[0].version).toBe("2.0.0");
  });

  it("清单 JSON 非法或 hook 非法时整个插件跳过并告警", () => {
    const g = tempDir();
    const dir = join(g, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), "{not json");
    writePlugin(g, "badhook", guardManifest({
      name: "badhook",
      hooks: { preToolUse: [{ matcher: "(", command: "true" }] },
    }));
    const warnings: string[] = [];
    const plugins = loadPlugins({
      globalDir: g,
      projectDir: null,
      warn: (m) => warnings.push(m),
    });
    expect(plugins).toHaveLength(0);
    expect(warnings).toHaveLength(2);
  });

  it("enabled:false 原样返回，由执行方过滤", () => {
    const g = tempDir();
    writePlugin(g, "p1", guardManifest({ enabled: false }));
    const plugins = loadPlugins({ globalDir: g, projectDir: null, warn: noWarn });
    expect(plugins[0].enabled).toBe(false);
  });
});

function loadOne(globalDir: string): Plugin[] {
  return loadPlugins({ globalDir, projectDir: null, warn: noWarn });
}

describe("plugins/hooks", () => {
  const toolUse: ToolUseBlock = {
    type: "tool_use",
    id: "t1",
    name: "Bash",
    input: { command: "ls" },
  };

  it("hook 输出 deny 时拒绝并带原因", async () => {
    const g = tempDir();
    writePlugin(g, "p1", guardManifest({
      hooks: {
        preToolUse: [{
          matcher: "^Bash$",
          command: `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"不行"}}'`,
        }],
      },
    }));
    const hook = createPreToolUseHook(loadOne(g));
    const d = await hook(toolUse);
    expect(d.behavior).toBe("deny");
    expect(d.reason).toContain("不行");
    expect(d.reason).toContain("p1");
  });

  it("正常退出且无裁决输出时放行", async () => {
    const g = tempDir();
    writePlugin(g, "p1", guardManifest());
    const hook = createPreToolUseHook(loadOne(g));
    expect((await hook(toolUse)).behavior).toBe("allow");
  });

  it("matcher 不匹配的工具不执行 hook", async () => {
    const g = tempDir();
    writePlugin(g, "p1", guardManifest({
      hooks: { preToolUse: [{ matcher: "^Bash$", command: "exit 1" }] },
    }));
    const hook = createPreToolUseHook(loadOne(g));
    const d = await hook({ ...toolUse, name: "Read" });
    expect(d.behavior).toBe("allow");
  });

  it("非零退出按 fail-closed 拒绝", async () => {
    const g = tempDir();
    writePlugin(g, "p1", guardManifest({
      hooks: { preToolUse: [{ matcher: "^Bash$", command: "echo broken >&2; exit 3" }] },
    }));
    const hook = createPreToolUseHook(loadOne(g));
    const d = await hook(toolUse);
    expect(d.behavior).toBe("deny");
    expect(d.reason).toContain("code 3");
    expect(d.reason).toContain("broken");
  });

  it("超时按 fail-closed 拒绝", async () => {
    const g = tempDir();
    writePlugin(g, "p1", guardManifest({
      hooks: { preToolUse: [{ matcher: "^Bash$", command: "sleep 10", timeout: 1 }] },
    }));
    const hook = createPreToolUseHook(loadOne(g));
    const d = await hook(toolUse);
    expect(d.behavior).toBe("deny");
    expect(d.reason).toContain("超时");
  }, 10_000);

  it("禁用的插件不参与裁决", async () => {
    const g = tempDir();
    writePlugin(g, "p1", guardManifest({
      enabled: false,
      hooks: { preToolUse: [{ matcher: "^Bash$", command: "exit 1" }] },
    }));
    const hook = createPreToolUseHook(loadOne(g));
    expect((await hook(toolUse)).behavior).toBe("allow");
  });

  it("hook 可通过 ${PLUGIN_ROOT} 与 ${NODE} 环境变量定位自身与 node", async () => {
    const g = tempDir();
    const dir = writePlugin(g, "p1", guardManifest({
      hooks: {
        preToolUse: [{ matcher: "^Bash$", command: `"$NODE" "$PLUGIN_ROOT/check.mjs"` }],
      },
    }));
    writeFileSync(
      join(dir, "check.mjs"),
      `process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:"deny",permissionDecisionReason:"from "+process.env.PLUGIN_ROOT}}));`
    );
    const hook = createPreToolUseHook(loadOne(g));
    const d = await hook(toolUse);
    expect(d.behavior).toBe("deny");
    expect(d.reason).toContain(dir);
  });
});

describe("plugins/install", () => {
  it("本地安装成功、同名冲突报错", () => {
    const g = tempDir();
    const src = tempDir();
    const srcDir = writePlugin(src, "whatever", guardManifest({ name: "guard" }));
    expect(installFromLocalDir(srcDir, g)).toBe("guard");
    expect(loadOne(g)[0].name).toBe("guard");
    expect(() => installFromLocalDir(srcDir, g)).toThrow(/同名/);
  });

  it("非插件目录安装报错", () => {
    const g = tempDir();
    const src = tempDir();
    expect(() => installFromLocalDir(src, g)).toThrow();
  });

  it("管理操作拒绝全局目录之外的路径", () => {
    const g = tempDir();
    const outside = tempDir();
    expect(() => assertInGlobalDir(outside, g)).toThrow(/非法插件路径/);
    expect(() => removePlugin(outside, g)).toThrow(/非法插件路径/);
  });

  it("setEnabled 与 writeManifest 落盘生效，非法 JSON 拒绝", () => {
    const g = tempDir();
    const dir = writePlugin(g, "p1", guardManifest());
    setPluginEnabled(dir, false, g);
    expect(loadOne(g)[0].enabled).toBe(false);
    writeManifest(dir, JSON.stringify(guardManifest({ description: "改过" })), g);
    expect(loadOne(g)[0].description).toBe("改过");
    expect(() => writeManifest(dir, "{bad", g)).toThrow();
    expect(() => writeManifest(dir, "[1]", g)).toThrow(/JSON 对象/);
  });

  it("默认插件首启种子安装；删除后不复装", () => {
    const g = tempDir();
    const bundled = tempDir();
    writePlugin(bundled, "guard", guardManifest({ name: "guard" }));

    ensureDefaultPlugins({ bundledRoot: bundled, globalDir: g, warn: noWarn });
    expect(loadOne(g).map((p) => p.name)).toEqual(["guard"]);
    const marker = JSON.parse(readFileSync(join(g, ".seeded.json"), "utf8"));
    expect(Object.keys(marker)).toEqual(["guard"]);

    // 用户删除后再次启动：不复装
    rmSync(join(g, "guard"), { recursive: true });
    ensureDefaultPlugins({ bundledRoot: bundled, globalDir: g, warn: noWarn });
    expect(loadOne(g)).toHaveLength(0);
  });

  it("内置目录不存在时静默跳过", () => {
    const g = tempDir();
    ensureDefaultPlugins({ bundledRoot: join(g, "nope"), globalDir: g, warn: noWarn });
    expect(loadOne(g)).toHaveLength(0);
  });
});

describe("内置 agentguard 插件", () => {
  function runGuard(payload: unknown): {
    decision: "allow" | "deny";
    reason: string;
  } {
    const stdout = execFileSync(process.execPath, [AGENTGUARD_SCRIPT], {
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf8",
    });
    if (!stdout) return { decision: "allow", reason: "" };
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    return {
      decision: parsed.hookSpecificOutput.permissionDecision as "deny",
      reason: parsed.hookSpecificOutput.permissionDecisionReason,
    };
  }

  const bash = (command: unknown) => ({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });

  it.each([
    "rm -rf ./build",
    "cd /tmp && unlink a.txt",
    "find . -name '*.log' -delete",
    "git clean -fdx",
    "python -c \"import shutil; shutil.rmtree('x')\"",
    "node -e \"fs.rmSync('x', {recursive: true})\"",
    "psql -c 'DROP TABLE users'",
    "mysql -e 'TRUNCATE logs'",
    "sqlite3 db 'DELETE FROM users'",
  ])("拦截删除命令：%s", (cmd) => {
    const r = runGuard(bash(cmd));
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("AgentGuard");
  });

  it.each(["ls -la", "arm --version", "rm_file=1 env", "echo unlinkable", "git status"])(
    "放行普通命令：%s",
    (cmd) => {
      expect(runGuard(bash(cmd)).decision).toBe("allow");
    }
  );

  it("非 Bash 工具直接放行", () => {
    const r = runGuard({ tool_name: "Read", tool_input: { file_path: "rm.txt" } });
    expect(r.decision).toBe("allow");
  });

  it("stdin 非 JSON 时 fail-closed 拒绝", () => {
    const r = runGuard("not json");
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("fail-closed");
  });

  it("command 非文本时 fail-closed 拒绝", () => {
    expect(runGuard(bash(["rm", "-rf"])).decision).toBe("deny");
  });
});

describe("loop 集成：preToolUse deny", () => {
  const config: Config = {
    apiKey: "k",
    baseUrl: "http://localhost",
    model: "m",
    contextWindow: 200_000,
  };

  function fakeClient(responses: StreamMessageResult[]): ApiClient {
    return {
      async streamMessage(opts: StreamMessageOptions): Promise<StreamMessageResult> {
        const r = responses.shift();
        if (!r) throw new Error("no more responses");
        void opts;
        return r;
      },
    };
  }

  function expectAllToolUsesPaired(messages: Message[]): void {
    const useIds = messages.flatMap((m) =>
      m.content.filter((b): b is ToolUseBlock => b.type === "tool_use").map((b) => b.id)
    );
    const resultIds = messages.flatMap((m) =>
      m.content
        .filter((b): b is ToolResultBlock => b.type === "tool_result")
        .map((b) => b.tool_use_id)
    );
    for (const id of useIds) expect(resultIds).toContain(id);
  }

  it("deny 的工具不执行，以 is_error tool_result 落位，配对完整", async () => {
    let executed = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "Bash",
      description: "fake",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        executed++;
        return { content: "ran" };
      },
    });
    const history = new History();
    const client = fakeClient([
      {
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "rm -rf /" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
        ],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);

    await runTurn({
      userInput: "hi",
      history,
      registry,
      client,
      config,
      system: "sys",
      preToolUse: async (toolUse) =>
        String((toolUse.input as { command?: string }).command).includes("rm")
          ? { behavior: "deny", reason: "guard 拦截" }
          : { behavior: "allow" },
      onEvent: () => {},
    });

    expect(executed).toBe(1); // 只有 ls 真正执行
    const messages = history.getMessages();
    expectAllToolUsesPaired(messages);
    const results = messages.flatMap((m) =>
      m.content.filter((b): b is ToolResultBlock => b.type === "tool_result")
    );
    const denied = results.find((r) => r.tool_use_id === "t1");
    expect(denied?.is_error).toBe(true);
    expect(denied?.content).toContain("guard 拦截");
    const allowed = results.find((r) => r.tool_use_id === "t2");
    expect(allowed?.is_error).toBeUndefined();
  });

  it("hook 自身异常按 fail-closed 拦截且不中断回合", async () => {
    const registry = new ToolRegistry();
    let executed = 0;
    registry.register({
      name: "Bash",
      description: "fake",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        executed++;
        return { content: "ran" };
      },
    });
    const history = new History();
    const client = fakeClient([
      {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
        stopReason: "tool_use",
      },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
    ]);
    await runTurn({
      userInput: "hi",
      history,
      registry,
      client,
      config,
      system: "sys",
      preToolUse: async () => {
        throw new Error("hook 爆了");
      },
      onEvent: () => {},
    });
    expect(executed).toBe(0);
    const messages = history.getMessages();
    expectAllToolUsesPaired(messages);
    const result = messages
      .flatMap((m) => m.content)
      .find((b): b is ToolResultBlock => b.type === "tool_result");
    expect(result?.is_error).toBe(true);
    expect(result?.content).toContain("fail-closed");
  });
});
