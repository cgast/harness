/**
 * Harness Desktop - Electron main process.
 *
 * Creates the application window, initializes the agent manager,
 * and wires up IPC handlers so the renderer can control the harness.
 */

import * as path from "node:path";

// Electron imports - resolved at runtime
let app: Electron.App;
let BrowserWindow: typeof Electron.BrowserWindow;
let ipcMain: Electron.IpcMain;
let Menu: typeof Electron.Menu;

async function bootstrap() {
  const electron = require("electron");
  app = electron.app;
  BrowserWindow = electron.BrowserWindow;
  ipcMain = electron.ipcMain;
  Menu = electron.Menu;

  const { AgentManager } = require("./agent-manager");
  const { registerIpcHandlers } = require("./ipc-handlers");

  // Prevent multiple instances
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  await app.whenReady();

  // Initialize agent manager
  const agentManager = new AgentManager();
  await agentManager.initialize();

  // Create the main window
  const mainWindow = createMainWindow();

  // Register all IPC handlers
  registerIpcHandlers(ipcMain, agentManager, mainWindow);

  // Build application menu
  buildMenu(mainWindow);

  // Forward agent events to renderer
  agentManager.onEvent((event: string, data: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("harness:event", { event, data });
    }
  });

  // Handle second-instance (focus existing window)
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // macOS: re-create window on dock click
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createMainWindow();
      registerIpcHandlers(ipcMain, agentManager, win);
    }
  });

  // Clean up on quit
  app.on("before-quit", async () => {
    await agentManager.shutdown();
  });
}

function createMainWindow(): Electron.BrowserWindow {
  const preloadPath = path.join(__dirname, "..", "preload", "index.js");
  const rendererPath = path.join(__dirname, "..", "renderer", "index.html");

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Harness Desktop",
    backgroundColor: "#0f1117",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(rendererPath);

  // Quit app when all windows closed (non-macOS)
  win.on("closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  return win;
}

function buildMenu(mainWindow: Electron.BrowserWindow): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "New Session",
          accelerator: "CmdOrCtrl+N",
          click: () => mainWindow.webContents.send("menu:new-session"),
        },
        { type: "separator" },
        {
          label: "Settings",
          accelerator: "CmdOrCtrl+,",
          click: () => mainWindow.webContents.send("menu:settings"),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Agent",
      submenu: [
        {
          label: "Interrupt",
          accelerator: "CmdOrCtrl+C",
          click: () => mainWindow.webContents.send("menu:interrupt"),
        },
        {
          label: "Clear History",
          accelerator: "CmdOrCtrl+K",
          click: () => mainWindow.webContents.send("menu:clear-history"),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

bootstrap().catch((err) => {
  console.error("[harness-desktop] Fatal:", err);
  process.exit(1);
});
