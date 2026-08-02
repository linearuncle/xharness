import { app, BrowserWindow, ipcMain, dialog, nativeImage, protocol } from "electron";
import {
  readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, resolve } from "node:path";
import { userInfo } from "node:os";
import { marked } from "marked";
import * as store from "./store.js";
import * as engine from "./engine.js";

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

marked.setOptions({ breaks: true });

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
}

app.whenReady().then(() => {
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
ipcMain.handle("md:render", (_e, text) => marked.parse(text ?? ""));

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
