import { app, BrowserWindow, ipcMain, dialog, nativeImage } from "electron";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { marked } from "marked";
import * as store from "./store.js";
import * as engine from "./engine.js";

const here = dirname(fileURLToPath(import.meta.url));
let win = null;

app.setName("xharness");

marked.setOptions({ breaks: true });

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  createWindow();
});

app.on("window-all-closed", () => app.quit());

// ---------- IPC ----------

ipcMain.handle("state:get", () => ({
  username: userInfo().username,
  sidebar: store.sidebarData(),
  providers: store.getProviders(),
  efforts: engine.EFFORTS,
  envKeyPresent: !!(process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY),
}));

ipcMain.handle("settings:get", () => ({
  providers: store.getProviders(),
  envKeyPresent: !!(process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY),
}));

ipcMain.handle("settings:upsert", (_e, provider) => {
  if (!provider?.id || !provider?.name || !provider?.baseUrl) {
    return { ok: false, error: "名称与 Base URL 必填" };
  }
  store.upsertProvider(provider);
  return { ok: true, providers: store.getProviders() };
});

ipcMain.handle("settings:delete", (_e, id) => {
  store.deleteProvider(id);
  return { providers: store.getProviders() };
});

ipcMain.handle("project:add", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
  });
  if (!r.canceled && r.filePaths[0]) store.addProject(r.filePaths[0]);
  return store.sidebarData();
});

ipcMain.handle("conv:new", (_e, projectDir) => {
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

ipcMain.handle("conv:setModelChoice", (_e, { id, projectDir, providerId, model }) => {
  engine.getSession(id, projectDir, store.getConversation(id)?.blocks);
  engine.setModelChoice(id, providerId, model);
  return engine.sessionMeta(id);
});

ipcMain.handle("conv:setEffort", (_e, { id, projectDir, effort }) => {
  engine.getSession(id, projectDir, store.getConversation(id)?.blocks);
  engine.setEffort(id, effort);
  return engine.sessionMeta(id);
});

ipcMain.handle("skills:list", (_e, projectDir) => engine.listSkills(projectDir));

ipcMain.handle("files:search", (_e, { projectDir, q }) =>
  engine.searchFiles(projectDir, q)
);

ipcMain.handle("ctx:get", (_e, projectDir) => engine.projectContext(projectDir));

ipcMain.handle("md:render", (_e, text) => marked.parse(text ?? ""));

ipcMain.handle("chat:answer", (_e, { id, text }) => engine.answer(id, text));

ipcMain.handle("chat:stop", (_e, id) => engine.stop(id));

ipcMain.handle("block:append", (_e, { id, block }) => store.appendBlock(id, block));

ipcMain.handle("attach:pick", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (r.canceled) return [];
  return r.filePaths.map((p) => ({ path: p, name: p.split("/").pop() }));
});

const IMAGE_MEDIA = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif",
};

function loadAttachments(paths) {
  const out = [];
  for (const p of paths ?? []) {
    try {
      const ext = p.split(".").pop().toLowerCase();
      const media = IMAGE_MEDIA[ext];
      const data = readFileSync(p);
      if (media) {
        out.push({ kind: "image", name: p.split("/").pop(), mediaType: media, base64: data.toString("base64") });
      } else {
        // 非图片附件：以文本形式注入（截断保护）
        out.push({ kind: "text", name: p.split("/").pop(), text: data.toString("utf8").slice(0, 30000) });
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
    store.appendBlock(id, { kind: "attachment", name: a.name, type: a.kind });
  }
  store.appendBlock(id, { kind: "user", text });
  const emit = (event) => {
    if (event.type === "cleared") store.clearBlocks(id);
    win?.webContents.send("agent:event", { id, event });
  };
  await engine.send(id, c.projectDir, text, c.blocks, emit, attachments);
});

ipcMain.handle("user:escape", (_e, text) => escapeHtml(text ?? ""));
