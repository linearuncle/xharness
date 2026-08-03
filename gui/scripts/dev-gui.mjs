#!/usr/bin/env node
// 管理 dev 版 xharness GUI。默认使用真实数据目录：
//   ~/Library/Application Support/xharness
// 用法：
//   node gui/scripts/dev-gui.mjs start
//   node gui/scripts/dev-gui.mjs stop
//   node gui/scripts/dev-gui.mjs status
//   node gui/scripts/dev-gui.mjs restart
// 可选：
//   --data-dir <path>  显式使用隔离目录
//   --port <n>         CDP 端口，默认 0（自动端口）
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const guiDir = resolve(here, "..");
const appPath = join(guiDir, "node_modules", "electron", "dist", "xharness.app");
const defaultDataDir =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "xharness")
    : join(homedir(), ".xharness", "gui");

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "status";
let dataDir = defaultDataDir;
let port = 0;

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--data-dir") dataDir = resolve(argv[++i]);
  else if (argv[i] === "--port") port = Number(argv[++i]);
  else usage(`未知参数: ${argv[i]}`);
}

if (!["start", "stop", "status", "restart"].includes(command)) {
  usage(`未知命令: ${command}`);
}
if (!Number.isInteger(port) || port < 0) usage("--port 必须是非负整数");

function usage(message) {
  if (message) console.error(message);
  console.error("用法: node gui/scripts/dev-gui.mjs start|stop|status|restart [--data-dir <path>] [--port <n>]");
  process.exit(1);
}

function psRows() {
  const out = execFileSync("/bin/ps", ["-axo", "pid,ppid,stat,command"], { encoding: "utf8" });
  return out
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+\S+\s+(.*)$/);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] } : null;
    })
    .filter(Boolean);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile() {
  try {
    const pid = Number(readFileSync(join(dataDir, "dev-gui.pid"), "utf8").trim());
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function findMainPids() {
  const rows = psRows();
  const pids = new Set();
  for (const row of rows) {
    if (row.command.includes(`--user-data-dir=${dataDir}`)) pids.add(row.ppid);
  }
  const pidFile = readPidFile();
  if (pidFile && isAlive(pidFile)) {
    const row = rows.find((x) => x.pid === pidFile);
    if (row?.command.includes("xharness.app/Contents/MacOS/xharness")) pids.add(pidFile);
  }
  return [...pids].filter((pid) => isAlive(pid)).sort((a, b) => a - b);
}

async function readCdpInfo() {
  const file = join(dataDir, "DevToolsActivePort");
  if (!existsSync(file)) return null;
  const [portLine, pathLine] = readFileSync(file, "utf8").split(/\r?\n/);
  const cdpPort = Number(portLine);
  if (!Number.isInteger(cdpPort) || cdpPort <= 0 || !pathLine) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    if (!res.ok) return null;
  } catch {
    return null;
  }
  return {
    port: cdpPort,
    path: pathLine,
    ws: `ws://127.0.0.1:${cdpPort}${pathLine}`,
  };
}

async function waitForReady(startedAt) {
  for (let i = 0; i < 40; i++) {
    const pids = findMainPids();
    const activeFile = join(dataDir, "DevToolsActivePort");
    const fresh =
      existsSync(activeFile) && statSync(activeFile).mtimeMs >= startedAt - 1000;
    const cdp = fresh ? await readCdpInfo() : null;
    if (pids.length && cdp) return { pids, cdp };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { pids: findMainPids(), cdp: await readCdpInfo() };
}

function writeCdpLog(cdp) {
  if (!cdp) return;
  writeFileSync(join(dataDir, "cdp.log"), `DevTools listening on ${cdp.ws}\n`);
}

async function status() {
  const pids = findMainPids();
  const cdp = await readCdpInfo();
  console.log(`dataDir: ${dataDir}`);
  console.log(`running: ${pids.length ? "yes" : "no"}`);
  if (pids.length) console.log(`pids: ${pids.join(", ")}`);
  if (cdp) {
    writeCdpLog(cdp);
    console.log(`cdp: ${cdp.ws}`);
    console.log(`cdpEval: node gui/scripts/cdp-eval.mjs --data-dir "${dataDir}" 'document.title'`);
  }
  return 0;
}

async function start() {
  mkdirSync(dataDir, { recursive: true });
  const existing = findMainPids();
  if (existing.length) {
    console.log("dev GUI 已在运行。");
    return status();
  }
  if (!existsSync(appPath)) {
    console.error(`找不到 Electron app: ${appPath}`);
    console.error("请先在 gui/ 安装依赖。");
    return 1;
  }

  writeFileSync(join(dataDir, "cdp.out.log"), "");
  writeFileSync(join(dataDir, "cdp.err.log"), "");
  const startedAt = Date.now();
  const args = [
    "-n",
    "-F",
    "-i",
    "/dev/null",
    "-o",
    join(dataDir, "cdp.out.log"),
    "--stderr",
    join(dataDir, "cdp.err.log"),
  ];
  if (resolve(dataDir) !== resolve(defaultDataDir)) {
    args.push("--env", `XH_DATA_DIR=${dataDir}`);
  }
  args.push(appPath, "--args", guiDir, `--remote-debugging-port=${port}`);

  execFileSync("/usr/bin/open", args, { stdio: "ignore" });
  const ready = await waitForReady(startedAt);
  if (!ready.pids.length || !ready.cdp) {
    console.error("dev GUI 启动后未就绪。");
    console.error(`stderr: ${join(dataDir, "cdp.err.log")}`);
    return 1;
  }
  writeFileSync(join(dataDir, "dev-gui.pid"), `${ready.pids[0]}\n`);
  writeCdpLog(ready.cdp);
  try {
    execFileSync("/usr/bin/osascript", ["-e", 'tell application "xharness" to activate'], {
      stdio: "ignore",
    });
  } catch {
    // 激活失败不影响 dev GUI 本身
  }
  console.log("dev GUI 已启动。");
  console.log(`dataDir: ${dataDir}`);
  console.log(`pids: ${ready.pids.join(", ")}`);
  console.log(`cdp: ${ready.cdp.ws}`);
  return 0;
}

async function stop() {
  const pids = findMainPids();
  if (!pids.length) {
    console.log("dev GUI 未运行。");
    return 0;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 已退出
    }
  }
  for (let i = 0; i < 20; i++) {
    if (!findMainPids().length) {
      console.log("dev GUI 已关闭。");
      return 0;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`dev GUI 未完全退出，残留 pids: ${findMainPids().join(", ")}`);
  return 1;
}

let exitCode = 0;
if (command === "status") exitCode = await status();
else if (command === "start") exitCode = await start();
else if (command === "stop") exitCode = await stop();
else if (command === "restart") {
  const stopped = await stop();
  exitCode = stopped === 0 ? await start() : stopped;
}
process.exit(exitCode);
