const { contextBridge, ipcRenderer } = require("electron");
const path = require("path");

contextBridge.exposeInMainWorld("api", {
  openFolder: () => ipcRenderer.invoke("dialog:openFolder"),
  openFileDialog: () => ipcRenderer.invoke("dialog:openFile"),
  readDir: (dir) => ipcRenderer.invoke("fs:readDir", dir),
  readFile: (filePath) => ipcRenderer.invoke("fs:readFile", filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke("fs:writeFile", filePath, content),
  listSessions: (projectPath) => ipcRenderer.invoke("sessions:list", projectPath),
  parseEdits: (sessionPath, provider, projectRoot) =>
    ipcRenderer.invoke("sessions:parseEdits", sessionPath, provider, projectRoot),
  parseEvents: (sessionPath, provider, projectRoot) =>
    ipcRenderer.invoke("sessions:parseEvents", sessionPath, provider, projectRoot),
  gitRoot: (dir) => ipcRenderer.invoke("sessions:gitRoot", dir),
  showInFolder: (filePath) => ipcRenderer.invoke("shell:show", filePath),
  validateHighlight: (payload) =>
    ipcRenderer.invoke("laya:validateHighlight", payload),
  onProjectOpened: (cb) => {
    ipcRenderer.on("project:opened", (_e, data) => cb(data));
  },
  onOpenExternalFile: (cb) => {
    ipcRenderer.on("file:open-external", (_e, filePath) => cb(filePath));
  },
  onSave: (cb) => {
    ipcRenderer.on("menu:save", () => cb());
  },
  onReloadSessions: (cb) => {
    ipcRenderer.on("sessions:reload", () => cb());
  },
  basename: (p) => path.basename(p),
  dirname: (p) => path.dirname(p),
  extname: (p) => path.extname(p),
  join: (...parts) => path.join(...parts),
});
