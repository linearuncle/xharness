const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("state:get"),
  addProject: () => ipcRenderer.invoke("project:add"),
  newConversation: (projectDir) => ipcRenderer.invoke("conv:new", projectDir),
  openConversation: (id) => ipcRenderer.invoke("conv:open", id),
  pinConversation: (id, pinned) => ipcRenderer.invoke("conv:pin", { id, pinned }),
  deleteConversation: (id) => ipcRenderer.invoke("conv:delete", id),
  setModelChoice: (id, projectDir, providerId, model) =>
    ipcRenderer.invoke("conv:setModelChoice", { id, projectDir, providerId, model }),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  listPlugins: () => ipcRenderer.invoke("plugins:list"),
  installPluginFromGitHub: (url) => ipcRenderer.invoke("plugins:install-github", url),
  installPluginFromLocal: () => ipcRenderer.invoke("plugins:install-local"),
  removePlugin: (root) => ipcRenderer.invoke("plugins:remove", root),
  setPluginEnabled: (root, enabled) =>
    ipcRenderer.invoke("plugins:setEnabled", { root, enabled }),
  getPluginManifest: (root) => ipcRenderer.invoke("plugins:manifest-get", root),
  savePluginManifest: (root, text) =>
    ipcRenderer.invoke("plugins:manifest-save", { root, text }),
  getAppearance: () => ipcRenderer.invoke("appearance:get"),
  setAppearance: (a) => ipcRenderer.invoke("appearance:set", a),
  setVibrancy: (enabled) => ipcRenderer.invoke("appearance:vibrancy", enabled),
  getProviderKey: (id) => ipcRenderer.invoke("settings:getProviderKey", id),
  upsertProvider: (provider) => ipcRenderer.invoke("settings:upsert", provider),
  deleteProvider: (id) => ipcRenderer.invoke("settings:delete", id),
  setEffort: (id, projectDir, effort) =>
    ipcRenderer.invoke("conv:setEffort", { id, projectDir, effort }),
  listSkills: (projectDir) => ipcRenderer.invoke("skills:list", projectDir),
  searchFiles: (projectDir, q) =>
    ipcRenderer.invoke("files:search", { projectDir, q }),
  getContext: (projectDir) => ipcRenderer.invoke("ctx:get", projectDir),
  renderMarkdown: (text, final = true) =>
    ipcRenderer.invoke("md:render", { text, final }),
  send: (id, text, attachmentPaths) =>
    ipcRenderer.invoke("chat:send", { id, text, attachmentPaths }),
  pickAttachments: () => ipcRenderer.invoke("attach:pick"),
  savePastedImage: (base64, ext) =>
    ipcRenderer.invoke("attach:save-clipboard", { base64, ext }),
  yoloAck: () => ipcRenderer.invoke("yolo:ack"),
  stop: (id) => ipcRenderer.invoke("chat:stop", id),
  answer: (id, text) => ipcRenderer.invoke("chat:answer", { id, text }),
  appendBlock: (id, block) => ipcRenderer.invoke("block:append", { id, block }),
  onAgentEvent: (fn) =>
    ipcRenderer.on("agent:event", (_e, payload) => fn(payload)),
  onSidebarUpdate: (fn) =>
    ipcRenderer.on("sidebar:update", (_e, sidebar) => fn(sidebar)),
});
