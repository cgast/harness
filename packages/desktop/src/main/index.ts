/**
 * Harness Desktop - Electron main process.
 *
 * Creates the application window, initializes the agent manager,
 * and wires up IPC handlers so the renderer can control the harness.
 */

import * as path from "node:path";
import type {
  App,
  BrowserWindow as BrowserWindowType,
  IpcMain,
  Menu as MenuType,
  MenuItemConstructorOptions,
} from "electron";

// Electron imports - resolved at runtime
let app: App;
let BrowserWindow: typeof BrowserWindowType;
let ipcMain: IpcMain;
let Menu: typeof MenuType;

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

  // Load and wire heartbeat plugin
  try {
    const heartbeat = require("@harness/plugin-heartbeat");
    const heartbeatPlugin = heartbeat.default?.default || heartbeat.default || heartbeat;
    const {
      getHeartbeatStatus,
      updateHeartbeatConfig,
      triggerHeartbeatNow,
      getHeartbeatHistory,
    } = heartbeat;

    // Provide runTask and isRunning callbacks via plugin config
    const { PluginLoader, createPluginConfig, createLogger } = require("@harness/core");
    const pluginConfig = createPluginConfig({
      runTask: (opts: any) => agentManager.runTask(opts),
      isRunning: () => agentManager.getRunning(),
    });
    const pluginCtx = {
      state: (agentManager as any).agent.state,
      store: (agentManager as any).agent.store,
      bus: (agentManager as any).agent.bus,
      config: pluginConfig,
      log: createLogger("harness-heartbeat"),
    };

    await heartbeatPlugin.activate(pluginCtx);

    // Register heartbeat tools with the agent
    if (heartbeatPlugin.tools) {
      for (const tool of heartbeatPlugin.tools) {
        (agentManager as any).agent.tools.register(tool);
      }
    }

    // Register heartbeat hooks with the event bus
    if (heartbeatPlugin.hooks) {
      for (const hook of heartbeatPlugin.hooks) {
        (agentManager as any).agent.bus.on(hook.event, hook.handler, hook.priority);
      }
    }

    // Wire control functions into AgentManager
    agentManager.initHeartbeat({
      getStatus: getHeartbeatStatus,
      updateConfig: updateHeartbeatConfig,
      trigger: triggerHeartbeatNow,
      getHistory: getHeartbeatHistory,
    });

    console.log("[harness-desktop] Heartbeat plugin loaded");
  } catch (err) {
    console.warn("[harness-desktop] Heartbeat plugin not available:", (err as Error).message);
  }

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

function createMainWindow(): BrowserWindowType {
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

function buildMenu(mainWindow: BrowserWindowType): void {
  const template: MenuItemConstructorOptions[] = [
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
