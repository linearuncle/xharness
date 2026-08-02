import { app, BrowserWindow, ipcMain, dialog, nativeImage, protocol, shell } from "electron";
import {
  readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, resolve } from "node:path";
import { userInfo } from "node:os";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js";
import * as store from "./store.js";
import * as engine from "./engine.js";
import { loadPlugins } from "../dist/plugins/loader.js";
import {
  installFromGitHub, installFromLocalDir, removePlugin,
  setPluginEnabled, readManifest, writeManifest,
} from "../dist/plugins/install.js";

const here = dirname(fileURLToPath(import.meta.url));
const ATT_DIR = join(store.DATA_DIR, "attachments");
const ACK_FILE = join(store.DATA_DIR, "yolo-ack");
let win = null;

app.setName("xharness");

// Finder 启动的 GUI 不继承 shell PATH：优先用打包内置的 bin（含 rg），
// 再兜底补上 Homebrew 常见路径，最后才是系统默认 PATH
process.env.PATH = [
  join(process.resourcesPath ?? "", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH ?? "",
].filter(Boolean).join(":");

// 代码块经 highlight.js 上色（始终返回已转义 HTML，之后仍过 DOMPurify）。
// 双实例：流式渲染只高亮声明了语言的块（省 CPU、避免自动检测中途换色）；
// 最终渲染对未知语言开启自动检测。
function makeMarked(autoDetect) {
  const m = new Marked(
    markedHighlight({
      langPrefix: "hljs language-",
      highlight(code, lang) {
        try {
          if (lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
          }
          return autoDetect ? hljs.highlightAuto(code).value : "";
        } catch {
          return ""; // 空串让 marked 走默认转义
        }
      },
    })
  );
  m.setOptions({ breaks: true });
  return m;
}
const markedStream = makeMarked(false);
const markedFinal = makeMarked(true);

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// 仅允许操作已添加的项目目录（IPC 信任边界）
function isKnownProject(dir) {
  return typeof dir === "string" && store.getProviders && store.sidebarData()
    .projects.some((p) => p.dir === dir);
}

// 附件只允许来自受控目录（渲染进程不可指定任意路径）
function inAttachmentsDir(p) {
  return typeof p === "string" && resolve(p).startsWith(ATT_DIR + "/");
}

const appIcon = nativeImage.createFromPath(join(here, "assets", "icon.png"));

function createWindow() {
  if (process.platform === "darwin" && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }
  win = new BrowserWindow({
    icon: appIcon,
    width: 1720,
    height: 1080,
    minWidth: 1000,
    minHeight: 640,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 22 },
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.loadFile(join(here, "renderer", "index.html"));

  // markdown 里的链接：拦截窗口内导航/新窗口，改交系统浏览器（仅 http/https）
  const openExternal = (url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    e.preventDefault();
    openExternal(url);
  });
}

// 从非「应用程序」目录直接运行（如解压后的下载目录）时，提示移动过去。
// dev 判定不用 app.isPackaged（bundle 已改名为 xharness，dev 下也是 true），
// 以 Resources/app 是否存在区分打包版与 dev。
async function offerMoveToApplications() {
  if (process.platform !== "darwin") return false;
  if (!existsSync(join(process.resourcesPath ?? "", "app"))) return false; // dev 跳过
  if (app.isInApplicationsFolder()) return false;
  const { response } = await dialog.showMessageBox({
    type: "question",
    message: "移动到「应用程序」文件夹？",
    detail:
      "xharness 正从下载/临时目录运行。移动到「应用程序」后启动更方便，升级覆盖也不易出错。",
    buttons: ["移动并重新打开", "暂不"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;
  try {
    // 目标位置已有旧版时直接覆盖
    return app.moveToApplicationsFolder({ conflictHandler: () => true });
  } catch (err) {
    dialog.showErrorBox("移动失败", err.message);
    return false;
  }
}

app.whenReady().then(async () => {
  if (await offerMoveToApplications()) return; // 已搬移：新位置的实例会自动重启
  store.load();
  try {
    engine.initEngine();
  } catch (err) {
    dialog.showErrorBox("xharness 启动失败", err.message);
    app.quit();
    return;
  }
  // xatt:// 自定义协议：只从附件目录按文件名取图，杜绝任意 file:// 路径
  protocol.handle("xatt", (req) => {
    try {
      const name = basename(decodeURIComponent(new URL(req.url).pathname));
      const p = join(ATT_DIR, name);
      if (!inAttachmentsDir(p) || !existsSync(p)) return new Response("", { status: 404 });
      const ext = name.split(".").pop().toLowerCase();
      const mime = IMAGE_MEDIA[ext] ?? "application/octet-stream";
      return new Response(readFileSync(p), { headers: { "content-type": mime } });
    } catch {
      return new Response("", { status: 400 });
    }
  });
  createWindow();
});

app.on("window-all-closed", () => app.quit());

// ---------- IPC ----------

ipcMain.handle("state:get", () => ({
  username: userInfo().username,
  sidebar: store.sidebarData(),
  providers: store.getProvidersSafe(),
  efforts: engine.EFFORTS,
  yoloAcked: existsSync(ACK_FILE),
}));

ipcMain.handle("yolo:ack", () => {
  mkdirSync(dirname(ACK_FILE), { recursive: true });
  writeFileSync(ACK_FILE, String(Date.now()));
  return true;
});

ipcMain.handle("settings:get", () => ({
  providers: store.getProvidersSafe(),
}));

// 设置详情回填用：列表仍脱敏，仅按 id 取 key（主进程明文）
ipcMain.handle("settings:getProviderKey", (_e, id) => {
  if (typeof id !== "string" || !id) return "";
  return store.getProviderKey(id) || "";
});

ipcMain.handle("settings:upsert", (_e, provider) => {
  if (!provider?.id || !provider?.name || !provider?.baseUrl) {
    return { ok: false, error: "名称与 Base URL 必填" };
  }
  delete provider.hasKey;
  store.upsertProvider(provider);
  return { ok: true, providers: store.getProvidersSafe() };
});

ipcMain.handle("settings:delete", (_e, id) => {
  store.deleteProvider(id);
  return { providers: store.getProvidersSafe() };
});

// ---------- 插件管理（只管理全局目录；项目级 .agents/plugins 仅运行时生效） ----------

// 渲染层拿到的是纯数据视图；root 回传主进程时经 assertInGlobalDir 校验（信任边界）
function pluginList() {
  return loadPlugins({ projectDir: null }).map((p) => ({
    name: p.name,
    version: p.version,
    description: p.description,
    enabled: p.enabled,
    root: p.root,
    hookCount: p.preToolUse.length,
  }));
}

ipcMain.handle("plugins:list", () => pluginList());

// git clone 为同步调用（小仓库秒级）；超时 60s 由 install 层兜底
ipcMain.handle("plugins:install-github", (_e, url) => {
  try {
    const name = installFromGitHub(String(url ?? ""));
    return { ok: true, name, plugins: pluginList() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("plugins:install-local", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
  try {
    const name = installFromLocalDir(r.filePaths[0]);
    return { ok: true, name, plugins: pluginList() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("plugins:remove", (_e, root) => {
  try {
    removePlugin(String(root ?? ""));
    return { ok: true, plugins: pluginList() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("plugins:setEnabled", (_e, { root, enabled }) => {
  try {
    setPluginEnabled(String(root ?? ""), !!enabled);
    return { ok: true, plugins: pluginList() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("plugins:manifest-get", (_e, root) => {
  try {
    return { ok: true, text: readManifest(String(root ?? "")) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("plugins:manifest-save", (_e, { root, text }) => {
  try {
    writeManifest(String(root ?? ""), String(text ?? ""));
    return { ok: true, plugins: pluginList() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("project:add", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
  });
  if (!r.canceled && r.filePaths[0]) store.addProject(r.filePaths[0]);
  return store.sidebarData();
});

ipcMain.handle("conv:new", (_e, projectDir) => {
  if (!isKnownProject(projectDir)) return null;
  const id = store.newConversation(projectDir);
  return { id, sidebar: store.sidebarData() };
});

ipcMain.handle("conv:open", (_e, id) => {
  const c = store.getConversation(id);
  if (!c) return null;
  return {
    id,
    projectDir: c.projectDir,
    title: c.title,
    blocks: c.blocks,
    meta: engine.sessionMeta(id),
    context: engine.projectContext(c.projectDir),
  };
});

ipcMain.handle("conv:pin", (_e, { id, pinned }) => {
  store.setPinned(id, pinned);
  return store.sidebarData();
});

ipcMain.handle("conv:delete", (_e, id) => {
  store.deleteConversation(id);
  return store.sidebarData();
});

ipcMain.handle("conv:setModelChoice", (_e, { id, providerId, model }) => {
  const c = store.getConversation(id);
  if (c) {
    engine.getSession(id, c.projectDir, c.blocks);
    engine.setModelChoice(id, providerId, model);
  }
  return engine.sessionMeta(id);
});

ipcMain.handle("conv:setEffort", (_e, { id, effort }) => {
  const c = store.getConversation(id);
  if (c) {
    engine.getSession(id, c.projectDir, c.blocks);
    engine.setEffort(id, effort);
  }
  return engine.sessionMeta(id);
});

ipcMain.handle("skills:list", (_e, projectDir) =>
  isKnownProject(projectDir) ? engine.listSkills(projectDir) : []
);

ipcMain.handle("files:search", (_e, { projectDir, q }) =>
  isKnownProject(projectDir) ? engine.searchFiles(projectDir, q) : []
);

ipcMain.handle("ctx:get", (_e, projectDir) =>
  isKnownProject(projectDir)
    ? engine.projectContext(projectDir)
    : { folder: "—", branch: null, changes: [] }
);

// markdown 渲染 + 消毒在渲染层（DOMPurify）完成；这里只做解析
ipcMain.handle("md:render", (_e, { text, final }) =>
  (final ? markedFinal : markedStream).parse(text ?? "")
);

ipcMain.handle("chat:answer", (_e, { id, text }) => engine.answer(id, text));

ipcMain.handle("chat:stop", (_e, id) => engine.stop(id));

ipcMain.handle("block:append", (_e, { id, block }) => store.appendBlock(id, block));

// 剪贴板粘贴的图片：落盘到受控附件目录
ipcMain.handle("attach:save-clipboard", (_e, { base64, ext }) => {
  const safeExt = ["png", "jpg", "jpeg", "webp", "gif"].includes(ext) ? ext : "png";
  mkdirSync(ATT_DIR, { recursive: true });
  const name = `paste-${Date.now()}.${safeExt}`;
  const path = join(ATT_DIR, name);
  writeFileSync(path, Buffer.from(base64, "base64"));
  return { path, name };
});

// 文件选择器选中的附件：统一拷贝进受控附件目录后再使用
ipcMain.handle("attach:pick", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (r.canceled) return [];
  mkdirSync(ATT_DIR, { recursive: true });
  const out = [];
  for (const p of r.filePaths) {
    const name = `${Date.now()}-${basename(p)}`;
    const dest = join(ATT_DIR, name);
    try {
      copyFileSync(p, dest);
      out.push({ path: dest, name: basename(p), fileName: name });
    } catch { /* 单个失败跳过 */ }
  }
  return out;
});

const IMAGE_MEDIA = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif",
};

function loadAttachments(paths) {
  const out = [];
  for (const p of paths ?? []) {
    if (!inAttachmentsDir(p)) continue; // 只接受受控目录内的附件
    try {
      const ext = p.split(".").pop().toLowerCase();
      const media = IMAGE_MEDIA[ext];
      const data = readFileSync(p);
      if (media) {
        out.push({ kind: "image", path: p, name: basename(p), mediaType: media, base64: data.toString("base64") });
      } else {
        // 非图片附件：以文本形式注入（截断保护）
        out.push({ kind: "text", path: p, name: basename(p), text: data.toString("utf8").slice(0, 30000) });
      }
    } catch (err) {
      out.push({ kind: "error", name: p, text: err.message });
    }
  }
  return out;
}

ipcMain.handle("chat:send", async (_e, { id, text, attachmentPaths }) => {
  const c = store.getConversation(id);
  if (!c) return;
  if (store.setTitle(id, text.replace(/\s+/g, " ").slice(0, 16))) {
    win?.webContents.send("sidebar:update", store.sidebarData());
  }
  const attachments = loadAttachments(attachmentPaths);
  for (const a of attachments) {
    store.appendBlock(id, {
      kind: "attachment", name: a.name, type: a.kind,
      fileName: a.path ? basename(a.path) : undefined,
    });
  }
  store.appendBlock(id, { kind: "user", text });
  const emit = (event) => {
    if (event.type === "cleared") store.clearBlocks(id);
    win?.webContents.send("agent:event", { id, event });
  };
  await engine.send(id, c.projectDir, text, c.blocks, emit, attachments);
});
