import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 全局插件目录：与技能同级的跨 harness 通用目录 */
export const GLOBAL_PLUGINS_DIR = join(homedir(), ".agents", "plugins");

export interface PluginHookSpec {
  /** 对工具名做整串匹配的正则（清单里的原文） */
  matcher: string;
  /** 经 /bin/sh -c 执行；可用环境变量 ${PLUGIN_ROOT} 与 ${NODE} */
  command: string;
  /** 超时秒数，超时按 fail-closed 拒绝 */
  timeout: number;
}

export interface Plugin {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  /** 插件目录（含 plugin.json） */
  root: string;
  preToolUse: PluginHookSpec[];
}

export interface LoadPluginsOptions {
  /** 全局插件目录，默认 ~/.agents/plugins */
  globalDir?: string;
  /** 项目插件目录，默认 <cwd>/.agents/plugins；传 null 表示只扫全局（GUI 设置页管理用） */
  projectDir?: string | null;
  cwd?: string;
  warn?: (message: string) => void;
}

function listDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // 目录不存在等：静默跳过
  }
}

function parseHookSpec(raw: unknown): PluginHookSpec | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.matcher !== "string" || typeof r.command !== "string") return null;
  if (!r.command.trim()) return null;
  try {
    new RegExp(r.matcher);
  } catch {
    return null;
  }
  const timeout =
    typeof r.timeout === "number" && Number.isFinite(r.timeout) && r.timeout > 0
      ? r.timeout
      : 10;
  return { matcher: r.matcher, command: r.command, timeout };
}

/** 解析 <root>/<dirName>/plugin.json；无清单不是插件，清单非法整个跳过（warn） */
export function parsePluginDir(
  root: string,
  dirName: string,
  warn: (message: string) => void
): Plugin | null {
  const pluginRoot = join(root, dirName);
  const file = join(pluginRoot, "plugin.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }

  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("清单必须是 JSON 对象");
    }
    data = parsed as Record<string, unknown>;
  } catch (err) {
    warn(
      `[插件] 跳过 ${file}：解析失败（${err instanceof Error ? err.message : String(err)}）`
    );
    return null;
  }

  const name =
    typeof data.name === "string" && data.name.trim() ? data.name.trim() : dirName;
  const hooks =
    typeof data.hooks === "object" && data.hooks !== null
      ? (data.hooks as Record<string, unknown>)
      : {};
  const rawPre = Array.isArray(hooks.preToolUse) ? hooks.preToolUse : [];
  const preToolUse: PluginHookSpec[] = [];
  for (const entry of rawPre) {
    const spec = parseHookSpec(entry);
    if (!spec) {
      warn(`[插件] 跳过 ${file}：preToolUse hook 非法（需 matcher 正则与 command）`);
      return null;
    }
    preToolUse.push(spec);
  }

  return {
    name,
    version: typeof data.version === "string" ? data.version : "0.0.0",
    description: typeof data.description === "string" ? data.description.trim() : "",
    enabled: data.enabled !== false,
    root: pluginRoot,
    preToolUse,
  };
}

/**
 * 扫描全局与项目两级插件目录（<root>/<name>/plugin.json），
 * 项目级覆盖全局同名插件。返回含禁用项（执行方自行按 enabled 过滤）。
 */
export function loadPlugins(opts: LoadPluginsOptions = {}): Plugin[] {
  const warn = opts.warn ?? ((message) => console.warn(message));
  const globalDir = opts.globalDir ?? GLOBAL_PLUGINS_DIR;
  const projectDir =
    opts.projectDir === null
      ? null
      : opts.projectDir ?? join(opts.cwd ?? process.cwd(), ".agents", "plugins");

  const byName = new Map<string, Plugin>();
  for (const root of projectDir === null ? [globalDir] : [globalDir, projectDir]) {
    for (const dirName of listDirs(root)) {
      const plugin = parsePluginDir(root, dirName, warn);
      if (plugin) byName.set(plugin.name, plugin);
    }
  }
  return [...byName.values()];
}
