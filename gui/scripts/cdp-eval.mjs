#!/usr/bin/env node
// 零依赖 CDP 驱动：直连 Electron 渲染进程执行 JS（Node >= 22，内置 fetch/WebSocket）。
// 用法:
//   node scripts/cdp-eval.mjs '<表达式>'            在 app 页面目标上求值并打印 JSON 结果
//   node scripts/cdp-eval.mjs --file check.js       求值文件内容（须为表达式/IIFE）
//   node scripts/cdp-eval.mjs --list                只列出所有 CDP 目标
// 选项:
//   --port <n>     调试端口（默认 9223）
//   --data-dir <p> 从 <p>/cdp.log 解析真实端口（--remote-debugging-port=0 时启动日志里
//                  有 "DevTools listening on ws://127.0.0.1:<port>/..."；优先于 --port）
//   --url <regex>  页面目标 url 匹配模式（默认 ^file://）
// 退出码: 0 成功；1 连接/协议错误；2 页面内抛异常。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
let port = 9223;
let dataDir = null;
let urlPattern = "^file://";
let listOnly = false;
let expr = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port") port = Number(args[++i]);
  else if (args[i] === "--data-dir") dataDir = args[++i];
  else if (args[i] === "--url") urlPattern = args[++i];
  else if (args[i] === "--list") listOnly = true;
  else if (args[i] === "--file") expr = readFileSync(args[++i], "utf8");
  else if (expr === null) expr = args[i];
  else {
    console.error(`多余参数: ${args[i]}`);
    process.exit(1);
  }
}

if (dataDir) {
  // 启动日志取最后一次出现的 DevTools 端口（同一日志可能累积多轮启动）
  let log;
  try {
    log = readFileSync(join(dataDir, "cdp.log"), "utf8");
  } catch {
    console.error(`读不到 ${join(dataDir, "cdp.log")}（启动时是否重定向了输出：> "$XH_DATA_DIR/cdp.log" 2>&1？）`);
    process.exit(1);
  }
  const matches = [...log.matchAll(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/g)];
  port = matches.length ? Number(matches.at(-1)[1]) : 0;
  if (!port) {
    console.error(`${join(dataDir, "cdp.log")} 里没有 "DevTools listening" 行（实例是否以 --remote-debugging-port=0 启动？）`);
    process.exit(1);
  }
}

const base = `http://127.0.0.1:${port}`;

async function getTargets() {
  const res = await fetch(`${base}/json/list`);
  if (!res.ok) throw new Error(`GET /json/list → HTTP ${res.status}`);
  return res.json();
}

let targets;
try {
  targets = await getTargets();
} catch (err) {
  console.error(
    `连不上 ${base}（GUI 是否以 --remote-debugging-port=${port} 启动？）: ${err.message}`
  );
  process.exit(1);
}

if (listOnly) {
  for (const t of targets) console.log(`${t.type}\t${t.url}\t${t.title}`);
  process.exit(0);
}

const page = targets.find((t) => t.type === "page" && new RegExp(urlPattern).test(t.url));
if (!page) {
  console.error(`没有匹配 /${urlPattern}/ 的 page 目标，现有目标:`);
  for (const t of targets) console.error(`  ${t.type}\t${t.url}`);
  process.exit(1);
}
if (expr === null) {
  console.error("缺少待求值表达式（或 --file/--list）");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.onopen = async () => {
  try {
    const result = await send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      console.error(`页面内异常: ${d.text} ${d.exception?.description ?? ""}`);
      process.exit(2);
    }
    console.log(JSON.stringify(result.result.value, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(`CDP 调用失败: ${err.message}`);
    process.exit(1);
  }
};
ws.onerror = () => {
  console.error("WebSocket 连接失败");
  process.exit(1);
};
