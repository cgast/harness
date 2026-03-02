/**
 * IPC Handlers - Maps Electron IPC channels to AgentManager methods.
 *
 * All channels use the "harness:" prefix for namespacing.
 * Uses invoke/handle pattern for request-response, send/on for push events.
 */

import type { IpcMain, BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { AgentManager } from "./agent-manager";

export function registerIpcHandlers(
  ipcMain: IpcMain,
  manager: AgentManager,
  mainWindow: BrowserWindow
): void {
  // ─── Task Execution ──────────────────────────────────────

  ipcMain.handle("harness:run-task", async (_event: IpcMainInvokeEvent, options: any) => {
    try {
      const result = await manager.runTask(options);
      return { ok: true, data: result };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("harness:send-input", async (_event: IpcMainInvokeEvent, text: string) => {
    try {
      await manager.sendUserInput(text);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("harness:is-running", async () => {
    return { ok: true, data: manager.getRunning() };
  });

  // ─── Feedback / HITL ─────────────────────────────────────

  ipcMain.handle("harness:feedback-respond", async (_event: IpcMainInvokeEvent, requestId: string, response: any) => {
    try {
      manager.respondToFeedback(requestId, response);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("harness:feedback-pending", async () => {
    return { ok: true, data: manager.getPendingFeedback() };
  });

  // ─── Telemetry ───────────────────────────────────────────

  ipcMain.handle("harness:telemetry", async () => {
    try {
      return { ok: true, data: manager.getTelemetry() };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // ─── Tools ───────────────────────────────────────────────

  ipcMain.handle("harness:tools-list", async () => {
    return { ok: true, data: manager.getTools() };
  });

  ipcMain.handle("harness:tools-unregister", async (_event: IpcMainInvokeEvent, name: string) => {
    try {
      const removed = manager.unregisterTool(name);
      return { ok: true, data: removed };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // ─── Skills ──────────────────────────────────────────────

  ipcMain.handle("harness:skills-list", async () => {
    return { ok: true, data: manager.getSkills() };
  });

  ipcMain.handle("harness:skills-activate", async (_event: IpcMainInvokeEvent, skillId: string) => {
    try {
      manager.activateSkill(skillId);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("harness:skills-deactivate", async (_event: IpcMainInvokeEvent, skillId: string) => {
    try {
      manager.deactivateSkill(skillId);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // ─── Plugins ─────────────────────────────────────────────

  ipcMain.handle("harness:plugins-list", async () => {
    return { ok: true, data: manager.getPlugins() };
  });

  // ─── Sessions ────────────────────────────────────────────

  ipcMain.handle("harness:sessions-list", async (_event: IpcMainInvokeEvent, limit?: number) => {
    return { ok: true, data: manager.getSessions(limit) };
  });

  ipcMain.handle("harness:sessions-get", async (_event: IpcMainInvokeEvent, id: string) => {
    return { ok: true, data: manager.getSession(id) };
  });

  ipcMain.handle("harness:events-list", async (_event: IpcMainInvokeEvent, sessionId: string, limit?: number) => {
    return { ok: true, data: manager.getEvents(sessionId, limit) };
  });

  // ─── State / Config ──────────────────────────────────────

  ipcMain.handle("harness:state", async () => {
    return { ok: true, data: manager.getState() };
  });

  ipcMain.handle("harness:config-get", async () => {
    return { ok: true, data: manager.getConfig() };
  });

  ipcMain.handle("harness:config-update", async (_event: IpcMainInvokeEvent, partial: any) => {
    try {
      manager.updateConfig(partial);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // ─── Settings (persistent config) ────────────────────────

  ipcMain.handle("harness:settings-get", async () => {
    try {
      return { ok: true, data: manager.getSettings() };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("harness:settings-save", async (_event: IpcMainInvokeEvent, settings: any) => {
    try {
      manager.saveSettings(settings);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // ─── Deliverables (.harness-out/) ────────────────────────

  ipcMain.handle("harness:deliverables-list", async () => {
    try {
      return { ok: true, data: manager.getDeliverables() };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // ─── Messages / Files ────────────────────────────────────

  ipcMain.handle("harness:messages", async () => {
    return { ok: true, data: manager.getMessages() };
  });

  // ─── Soul Files (system prompts) ─────────────────────────

  ipcMain.handle("harness:soul-list", async () => {
    try {
      return { ok: true, data: manager.getSoulFiles() };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("harness:soul-get", async (_event: IpcMainInvokeEvent, name: string) => {
    try {
      return { ok: true, data: manager.getSoulFile(name) };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("harness:soul-save", async (_event: IpcMainInvokeEvent, name: string, data: any) => {
    try {
      manager.saveSoulFile(name, data);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("harness:soul-delete", async (_event: IpcMainInvokeEvent, name: string) => {
    try {
      manager.deleteSoulFile(name);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("harness:soul-set-active", async (_event: IpcMainInvokeEvent, name: string) => {
    try {
      manager.setActiveSoul(name);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // ─── Heartbeat ──────────────────────────────────────────

  ipcMain.handle("harness:heartbeat-status", async () => {
    try {
      return { ok: true, data: manager.getHeartbeatStatus() };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("harness:heartbeat-config", async (_event: IpcMainInvokeEvent, updates: any) => {
    try {
      manager.updateHeartbeatConfig(updates);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("harness:heartbeat-trigger", async () => {
    try {
      await manager.triggerHeartbeat();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("harness:heartbeat-history", async () => {
    try {
      return { ok: true, data: manager.getHeartbeatHistory() };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });
}
