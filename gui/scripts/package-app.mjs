// 打包自包含的 xharness.app（macOS 本地安装用）：
//   1. 组装 staging：应用代码（gui/ + dist/）+ 仅生产依赖的 node_modules
//   2. 复制已改名的 Electron 骨架（xharness.app，含图标与 Info.plist）
//   3. staging 放入 Contents/Resources/app（Electron 优先加载此目录）
//   4. ad-hoc 重签
// 产物：<repo>/release/xharness.app —— 拖入 /Applications 即可。
// 注意：Finder 启动的 GUI 不继承 shell 环境变量；打包版建议在设置中"手动填写"
// API Key（safeStorage 加密），或用 launchctl setenv 注入环境变量。
import { execFileSync, execSync } from "node:child_process";
import {
  existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync,
  readdirSync, realpathSync, chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const GUI = join(here, "..");
const ROOT = join(GUI, "..");
const RELEASE = join(ROOT, "release");
const STAGING = join(RELEASE, "staging");
const APP_SRC = join(GUI, "node_modules", "electron", "dist", "xharness.app");
const APP_OUT = join(RELEASE, "xharness.app");

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });

if (!existsSync(join(ROOT, "dist", "index.js"))) {
  console.error("先构建引擎：npm run build（仓库根目录）");
  process.exit(1);
}
if (!existsSync(APP_SRC)) {
  console.error("未找到改名后的 Electron 骨架，先运行 scripts/patch-electron-name.mjs");
  process.exit(1);
}

console.log("1/5 组装 staging …");
rmSync(RELEASE, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });

const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const guiPkg = JSON.parse(readFileSync(join(GUI, "package.json"), "utf8"));
writeFileSync(
  join(STAGING, "package.json"),
  JSON.stringify(
    {
      name: "xharness",
      version: guiPkg.version,
      type: "module",
      main: "gui/main.js",
      license: "MIT",
      // 引擎依赖 + GUI 全部运行时依赖（整体继承，避免新增依赖漏进包）
      dependencies: { ...rootPkg.dependencies, ...guiPkg.dependencies },
    },
    null,
    2
  )
);

cpSync(join(ROOT, "dist"), join(STAGING, "dist"), { recursive: true });
// 内置插件整目录复制（engine 以 gui/../plugins 定位，dev 与打包版布局一致）
cpSync(join(ROOT, "plugins"), join(STAGING, "plugins"), { recursive: true });
mkdirSync(join(STAGING, "gui"), { recursive: true });
// gui 顶层主进程模块整体复制（清单禁止手写枚举——曾漏 oauth-xai/model-catalog
// 导致 v0.0.6 首包启动即崩；新增文件自动纳入）
for (const f of readdirSync(GUI)) {
  if (/\.(js|cjs)$/.test(f)) cpSync(join(GUI, f), join(STAGING, "gui", f));
}
cpSync(join(GUI, "renderer"), join(STAGING, "gui", "renderer"), { recursive: true });
cpSync(join(GUI, "assets"), join(STAGING, "gui", "assets"), { recursive: true });

console.log("2/5 安装生产依赖 …");
run("npm install --omit=dev --no-audit --no-fund --loglevel=error", STAGING);
rmSync(join(STAGING, "package-lock.json"), { force: true });

console.log("3/5 复制应用骨架 …");
// 用 ditto 保留框架内的符号链接结构（cpSync 会破坏，导致 codesign 报 unsealed contents）
execFileSync("ditto", [APP_SRC, APP_OUT]);
rmSync(join(APP_OUT, "Contents", "Resources", "default_app.asar"), { force: true });

console.log("4/5 注入应用代码 …");
cpSync(STAGING, join(APP_OUT, "Contents", "Resources", "app"), { recursive: true });
rmSync(STAGING, { recursive: true, force: true });

console.log("4.5/6 内置 ripgrep …");
// rg 是 Grep 工具的硬依赖；打进 Resources/bin 让用户零依赖（ripgrep: MIT/Unlicense 双协议，可分发）
try {
  const rgPath = realpathSync(execSync("command -v rg", { encoding: "utf8" }).trim());
  const binDir = join(APP_OUT, "Contents", "Resources", "bin");
  mkdirSync(binDir, { recursive: true });
  cpSync(rgPath, join(binDir, "rg"), { dereference: true });
  chmodSync(join(binDir, "rg"), 0o755);
  writeFileSync(
    join(binDir, "NOTICE-ripgrep.txt"),
    "Bundled ripgrep (rg) is dual-licensed under MIT / Unlicense.\nhttps://github.com/BurntSushi/ripgrep\n"
  );
} catch {
  console.warn("警告：本机未找到 rg，产物将依赖用户自装 ripgrep");
}

console.log("5/6 ad-hoc 签名 …");
execFileSync("codesign", ["--force", "--deep", "--sign", "-", APP_OUT], { stdio: "ignore" });

console.log("6/6 压缩分发包 …");
// ditto -c -k 保留符号链接与签名（普通 zip 会解引用框架 symlink 破坏签名）
const arch = process.arch === "arm64" ? "arm64" : process.arch;
const ZIP_OUT = join(RELEASE, `xharness-mac-${arch}.zip`);
execFileSync("ditto", ["-c", "-k", "--keepParent", APP_OUT, ZIP_OUT]);

console.log(`完成：${APP_OUT}`);
console.log(`分发包：${ZIP_OUT}`);
console.log("安装：拖入 /Applications；首次打开若被 Gatekeeper 拦截，右键 → 打开。");
