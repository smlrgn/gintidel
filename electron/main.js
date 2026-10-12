const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const sessions = require("./sessions");
const syntax = require("./syntax");

let mainWindow = null;
let currentProject = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0e1014",
    title: "Gintidel",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    const folder = folderFromArgv();
    if (folder) {
      currentProject = folder;
      mainWindow.webContents.send("project:opened", {
        path: folder,
        root: sessions.gitRoot(folder),
      });
    }
  });
  mainWindow.webContents.on("did-finish-load", () => {
    const folder = currentProject || folderFromArgv();
    if (folder) {
      currentProject = folder;
      mainWindow.webContents.send("project:opened", {
        path: folder,
        root: sessions.gitRoot(folder),
      });
    }
  });
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  buildMenu();
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Folder…",
          accelerator: "CmdOrCtrl+O",
          click: () => openFolder(),
        },
        {
          label: "Open File…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => openFile(),
        },
        { type: "separator" },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: () => mainWindow && mainWindow.webContents.send("menu:save"),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      label: "Sessions",
      submenu: [
        {
          label: "Reload session list",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow && mainWindow.webContents.send("sessions:reload"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function folderFromArgv() {
  const skip = new Set([".", "electron", "npx"]);
  for (const arg of process.argv.slice(1)) {
    if (!arg || arg.startsWith("-") || skip.has(path.basename(arg))) continue;
    try {
      const resolved = path.resolve(arg);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        if (resolved.includes("node_modules")) continue;
        return resolved;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function openFolder(defaultPath) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Open project folder",
    defaultPath: defaultPath || currentProject || undefined,
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  currentProject = result.filePaths[0];
  mainWindow.webContents.send("project:opened", {
    path: currentProject,
    root: sessions.gitRoot(currentProject),
  });
  return currentProject;
}

async function openFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Open file",
    defaultPath: currentProject || undefined,
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  mainWindow.webContents.send("file:open-external", filePath);
  return filePath;
}

ipcMain.handle("dialog:openFolder", () => openFolder());
ipcMain.handle("dialog:openFile", () => openFile());

ipcMain.handle("fs:readDir", (_evt, dir) => sessions.readDir(dir));
ipcMain.handle("fs:readFile", (_evt, filePath) => sessions.readTextFile(filePath));
ipcMain.handle("fs:writeFile", (_evt, filePath, content) =>
  sessions.writeTextFile(filePath, content)
);
ipcMain.handle("sessions:list", (_evt, projectPath) => {
  currentProject = projectPath;
  return sessions.listSessions(projectPath);
});
ipcMain.handle("sessions:parseEdits", (_evt, sessionPath, provider, projectRoot) =>
  sessions.parseSessionEdits(sessionPath, provider, projectRoot)
);
ipcMain.handle("sessions:parseEvents", (_evt, sessionPath, provider, projectRoot) =>
  sessions.parseSessionEvents(sessionPath, provider, projectRoot)
);
ipcMain.handle("sessions:gitRoot", (_evt, dir) => sessions.gitRoot(dir));
ipcMain.handle("shell:show", (_evt, filePath) => shell.showItemInFolder(filePath));
ipcMain.handle("laya:validateHighlight", async (_evt, payload) => {
  try {
    return await syntax.validateHighlight(payload || {});
  } catch (err) {
    console.error("validateHighlight failed", err);
    return { ok: false, error: err.message || String(err) };
  }
});
ipcMain.handle("laya:analyzeHighlightedStatement", async (_evt, payload) => {
  try {
    return await syntax.analyzeHighlightedStatement(payload || {});
  } catch (err) {
    console.error("analyzeHighlightedStatement failed", err);
    return { ok: false, error: err.message || String(err) };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
