import { app, BrowserWindow, ipcMain, dialog, nativeImage } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { marked } from "marked";
import * as store from "./store.js";
import * as engine from "./engine.js";

const here = dirname(fileURLToPath(import.meta.url));
let win = null;

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
    engine.initConfig();
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
  models: engine.MODELS,
  efforts: engine.EFFORTS,
}));

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

ipcMain.handle("conv:setModel", (_e, { id, projectDir, model }) => {
  engine.getSession(id, projectDir, store.getConversation(id)?.blocks);
  engine.setModel(id, model);
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

ipcMain.handle("chat:send", async (_e, { id, text }) => {
  const c = store.getConversation(id);
  if (!c) return;
  if (store.setTitle(id, text.replace(/\s+/g, " ").slice(0, 16))) {
    win?.webContents.send("sidebar:update", store.sidebarData());
  }
  store.appendBlock(id, { kind: "user", text });
  const emit = (event) => {
    if (event.type === "cleared") store.clearBlocks(id);
    win?.webContents.send("agent:event", { id, event });
  };
  await engine.send(id, c.projectDir, text, c.blocks, emit);
});

ipcMain.handle("user:escape", (_e, text) => escapeHtml(text ?? ""));
