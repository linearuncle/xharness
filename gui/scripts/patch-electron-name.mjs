// 开发模式下 macOS 菜单栏显示的是 Electron.app 的 CFBundleName（"Electron"）。
// 把本地 electron 包的 Info.plist 改名为 xharness；npm install 后经 postinstall 自动重打。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const plist = join(
  here, "..", "node_modules", "electron", "dist",
  "Electron.app", "Contents", "Info.plist"
);

if (process.platform !== "darwin" || !existsSync(plist)) {
  console.log("patch-electron-name: 跳过（非 macOS 或未找到 Info.plist）");
  process.exit(0);
}

for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} xharness`, plist]);
  } catch {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string xharness`, plist]);
  }
}
console.log("patch-electron-name: 菜单栏应用名已改为 xharness");
