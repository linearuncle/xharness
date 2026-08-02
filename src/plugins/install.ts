import { execFileSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GLOBAL_PLUGINS_DIR, parsePluginDir } from "./loader.js";

/** root 必须位于全局插件目录内（IPC/管理操作的信任边界） */
export function assertInGlobalDir(root: string, globalDir = GLOBAL_PLUGINS_DIR): string {
  const r = resolve(root);
  if (!r.startsWith(resolve(globalDir) + "/")) {
    throw new Error("非法插件路径：只能管理全局插件目录内的插件");
  }
  return r;
}

/** 校验 dir 是合法插件目录并返回解析结果（名称冲突检查用） */
function parseAt(dir: string): { name: string; version: string } {
  const errors: string[] = [];
  const plugin = parsePluginDir(
    resolve(dir, ".."),
    resolve(dir).split("/").pop() ?? "",
    (m) => errors.push(m)
  );
  if (!plugin) {
    throw new Error(errors[0] ?? `${dir} 不是插件目录（缺少合法的 plugin.json）`);
  }
  return plugin;
}

/** 从本地目录安装（复制）到全局插件目录，返回插件目录名 */
export function installFromLocalDir(
  srcDir: string,
  globalDir = GLOBAL_PLUGINS_DIR
): string {
  const plugin = parseAt(srcDir);
  const target = join(globalDir, plugin.name);
  if (existsSync(target)) {
    throw new Error(`已存在同名插件「${plugin.name}」，请先删除旧插件`);
  }
  mkdirSync(globalDir, { recursive: true });
  cpSync(srcDir, target, { recursive: true });
  return plugin.name;
}

/**
 * 从 GitHub 安装：接受 https://github.com/owner/repo(.git) 或 owner/repo 简写。
 * 布局兼容：仓库根 plugin.json，或 codex 风格的 plugins/<name>/plugin.json（取第一个合法项）。
 */
export function installFromGitHub(
  input: string,
  globalDir = GLOBAL_PLUGINS_DIR
): string {
  const trimmed = input.trim().replace(/\.git$/, "");
  let url: string;
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    url = `https://github.com/${trimmed}.git`;
  } else if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    url = `${trimmed}.git`;
  } else {
    throw new Error("仅支持 GitHub 仓库地址（https://github.com/owner/repo 或 owner/repo）");
  }

  const tmp = mkdtempSync(join(tmpdir(), "xharness-plugin-"));
  try {
    execFileSync("git", ["clone", "--depth", "1", url, tmp], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 60_000,
    });
    let srcDir: string | null = null;
    if (existsSync(join(tmp, "plugin.json"))) {
      srcDir = tmp;
    } else {
      const sub = join(tmp, "plugins");
      try {
        for (const e of readdirSync(sub, { withFileTypes: true })) {
          if (e.isDirectory() && existsSync(join(sub, e.name, "plugin.json"))) {
            srcDir = join(sub, e.name);
            break;
          }
        }
      } catch {
        /* 无 plugins/ 子目录 */
      }
    }
    if (!srcDir) {
      throw new Error("仓库中未找到 plugin.json（根目录或 plugins/<name>/ 下）");
    }
    return installFromLocalDir(srcDir, globalDir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function removePlugin(root: string, globalDir = GLOBAL_PLUGINS_DIR): void {
  rmSync(assertInGlobalDir(root, globalDir), { recursive: true, force: true });
}

export function setPluginEnabled(
  root: string,
  enabled: boolean,
  globalDir = GLOBAL_PLUGINS_DIR
): void {
  const file = join(assertInGlobalDir(root, globalDir), "plugin.json");
  const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  data.enabled = enabled;
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

export function readManifest(root: string, globalDir = GLOBAL_PLUGINS_DIR): string {
  return readFileSync(join(assertInGlobalDir(root, globalDir), "plugin.json"), "utf8");
}

export function writeManifest(
  root: string,
  text: string,
  globalDir = GLOBAL_PLUGINS_DIR
): void {
  const dir = assertInGlobalDir(root, globalDir);
  const parsed: unknown = JSON.parse(text); // 非法 JSON 直接抛给调用方
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("plugin.json 必须是 JSON 对象");
  }
  writeFileSync(join(dir, "plugin.json"), text.endsWith("\n") ? text : text + "\n");
}

export interface EnsureDefaultsOptions {
  /** 仓库/安装包内置插件目录（每个子目录一个插件） */
  bundledRoot: string;
  globalDir?: string;
  warn?: (message: string) => void;
}

/**
 * 首启种子安装内置插件：只在「从未种过」且全局目录无同名时复制；
 * 种过即记入 .seeded.json，用户删除后不会复装。失败只警告不阻断启动。
 */
export function ensureDefaultPlugins(opts: EnsureDefaultsOptions): void {
  const warn = opts.warn ?? ((m) => console.warn(m));
  const globalDir = opts.globalDir ?? GLOBAL_PLUGINS_DIR;
  const markerFile = join(globalDir, ".seeded.json");
  try {
    let names: string[] = [];
    try {
      names = readdirSync(opts.bundledRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return; // 无内置插件目录（如源码未随包分发）
    }

    let seeded: Record<string, string> = {};
    try {
      seeded = JSON.parse(readFileSync(markerFile, "utf8")) as Record<string, string>;
    } catch {
      /* 首次或标记损坏：按空处理 */
    }

    let changed = false;
    for (const name of names) {
      const src = join(opts.bundledRoot, name);
      if (!existsSync(join(src, "plugin.json"))) continue;
      const plugin = parseAt(src);
      if (seeded[plugin.name] !== undefined) continue;
      const target = join(globalDir, plugin.name);
      if (!existsSync(target)) {
        mkdirSync(globalDir, { recursive: true });
        cpSync(src, target, { recursive: true });
      }
      seeded[plugin.name] = plugin.version; // 值仅供人读，判定只看键是否存在
      changed = true;
    }
    if (changed) {
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(markerFile, JSON.stringify(seeded, null, 2) + "\n");
    }
  } catch (err) {
    warn(
      `[插件] 默认插件安装失败：${err instanceof Error ? err.message : String(err)}`
    );
  }
}
