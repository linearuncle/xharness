// 开发模式下 macOS 菜单栏与 Dock 显示的是 Electron.app 的名字。
// 彻底改名：bundle 目录、可执行文件、Info.plist、electron 的 path.txt 全部指向 xharness，
// 最后 ad-hoc 重签。npm install 后经 postinstall 自动重打；幂等。
import { execFileSync } from "node:child_process";
import { existsSync, renameSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "node_modules", "electron", "dist");
const pathTxt = join(here, "..", "node_modules", "electron", "path.txt");
const oldApp = join(dist, "Electron.app");
const newApp = join(dist, "xharness.app");

if (process.platform !== "darwin") {
  console.log("patch-electron-name: 跳过（非 macOS）");
  process.exit(0);
}

if (existsSync(oldApp) && !existsSync(newApp)) {
  renameSync(oldApp, newApp);
}
if (!existsSync(newApp)) {
  console.log("patch-electron-name: 未找到 Electron bundle，跳过");
  process.exit(0);
}

const oldBin = join(newApp, "Contents", "MacOS", "Electron");
const newBin = join(newApp, "Contents", "MacOS", "xharness");
if (existsSync(oldBin) && !existsSync(newBin)) {
  renameSync(oldBin, newBin);
}

const plist = join(newApp, "Contents", "Info.plist");
const setKey = (key, value) => {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
  } catch {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist]);
  }
};
setKey("CFBundleName", "xharness");
setKey("CFBundleDisplayName", "xharness");
setKey("CFBundleExecutable", "xharness");
setKey("CFBundleIdentifier", "com.linearuncle.xharness");

// 应用图标：把我们的 icon 转成 icns 塞进 bundle（Dock 常驻/启动早期也用它）
try {
  const iconPng = join(here, "..", "assets", "icon.png");
  const iconset = join(dist, "xharness.iconset");
  if (existsSync(iconPng)) {
    cpSync(iconPng, join(dist, "icon-1024.png"));
    execFileSync("rm", ["-rf", iconset]);
    execFileSync("mkdir", ["-p", iconset]);
    for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
      execFileSync("sips", ["-z", String(size), String(size), iconPng, "--out", join(iconset, `icon_${size}x${size}.png`)], { stdio: "ignore" });
    }
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(newApp, "Contents", "Resources", "electron.icns")]);
    execFileSync("rm", ["-rf", iconset, join(dist, "icon-1024.png")]);
  }
} catch (err) {
  console.log("patch-electron-name: icns 生成跳过:", err.message);
}

writeFileSync(pathTxt, "xharness.app/Contents/MacOS/xharness");

// 改动后 ad-hoc 重签，避免签名校验拒启
try {
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", newApp], { stdio: "ignore" });
} catch {
  console.log("patch-electron-name: codesign 重签失败（可能仍可运行）");
}

console.log("patch-electron-name: bundle 已改名为 xharness.app（含 Dock 名与图标）");
