/**
 * Extended REST API routes for the Harness server.
 *
 * Provides endpoints for tools, skills, plugins, sessions, soul files,
 * settings, telemetry, and state management — matching the full feature
 * set exposed by the Electron desktop IPC bridge.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import type { HarnessAgent, HarnessConfig, SoulDocument } from "@harness/core";
import { loadSoul, loadConfig } from "@harness/core";

// ── Helpers ──────────────────────────────────────────────────────────

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  json(res, { error: message }, status);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getSoulsDir(config: HarnessConfig): string {
  const home =
    config.harnessHome ||
    process.env.HARNESS_HOME ||
    path.join(process.env.HOME || "~", ".harness");
  return path.join(home, "souls");
}

function soulToPromptContent(soul: SoulDocument): string {
  // Reconstruct YAML for editing — inline to avoid YAML dep here
  return JSON.stringify(
    { id: soul.id, name: soul.name, version: soul.version, layers: soul.layers },
    null,
    2
  );
}

// ── Route handler ────────────────────────────────────────────────────

/**
 * Handle an extended API request. Returns true if the route was matched,
 * false if it should fall through to the existing handler.
 */
export function handleApiRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agent: HarnessAgent,
  config: HarnessConfig
): boolean {
  const method = req.method || "GET";
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // ─── Tools ─────────────────────────────────────────────────────

  if (method === "GET" && pathname === "/api/tools") {
    const tools = agent.tools.all().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      timeout: t.timeout,
      requiresConfirmation: t.requiresConfirmation,
    }));
    json(res, { ok: true, data: tools });
    return true;
  }

  if (method === "DELETE" && pathname.startsWith("/api/tools/")) {
    const name = decodeURIComponent(pathname.slice("/api/tools/".length));
    const removed = agent.tools.unregister(name);
    json(res, { ok: true, data: removed });
    return true;
  }

  // ─── Skills ────────────────────────────────────────────────────

  if (method === "GET" && pathname === "/api/skills") {
    const activeIds = new Set(agent.state.get("activeSkills"));
    // Skills aren't tracked on the agent directly — return active skill IDs
    // The server doesn't load skill documents from disk like desktop does,
    // so we expose what the agent state knows.
    const skills = Array.from(activeIds).map((id) => ({
      id,
      name: id,
      active: true,
    }));
    json(res, { ok: true, data: skills });
    return true;
  }

  if (method === "POST" && pathname.match(/^\/api\/skills\/[^/]+\/activate$/)) {
    const id = decodeURIComponent(pathname.split("/")[3]);
    const current = agent.state.get("activeSkills");
    if (!current.includes(id)) {
      agent.state.set("activeSkills", [...current, id]);
      agent.bus.emit("skill:activate", { skillId: id });
    }
    json(res, { ok: true });
    return true;
  }

  if (method === "POST" && pathname.match(/^\/api\/skills\/[^/]+\/deactivate$/)) {
    const id = decodeURIComponent(pathname.split("/")[3]);
    const current = agent.state.get("activeSkills");
    agent.state.set("activeSkills", current.filter((s) => s !== id));
    agent.bus.emit("skill:deactivate", { skillId: id });
    json(res, { ok: true });
    return true;
  }

  // ─── Plugins ───────────────────────────────────────────────────

  if (method === "GET" && pathname === "/api/plugins") {
    // Plugins are loaded at startup; expose minimal info
    json(res, { ok: true, data: [] });
    return true;
  }

  // ─── Sessions ──────────────────────────────────────────────────

  if (method === "GET" && pathname === "/api/sessions") {
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const sessions = agent.store.listSessions(limit);
    json(res, { ok: true, data: sessions });
    return true;
  }

  if (method === "GET" && pathname.match(/^\/api\/sessions\/[^/]+\/events$/)) {
    const id = decodeURIComponent(pathname.split("/")[3]);
    const limit = parseInt(url.searchParams.get("limit") || "200", 10);
    const events = agent.store.getEvents(id, limit);
    json(res, { ok: true, data: events });
    return true;
  }

  if (method === "GET" && pathname.match(/^\/api\/sessions\/[^/]+$/) && !pathname.includes("/events")) {
    const id = decodeURIComponent(pathname.split("/")[3]);
    const session = agent.store.getSession(id);
    if (!session) {
      error(res, "Session not found", 404);
    } else {
      json(res, { ok: true, data: session });
    }
    return true;
  }

  // ─── State ─────────────────────────────────────────────────────

  if (method === "GET" && pathname === "/api/state") {
    json(res, { ok: true, data: agent.state.snapshot() });
    return true;
  }

  // ─── Config ────────────────────────────────────────────────────

  if (method === "GET" && pathname === "/api/config") {
    json(res, { ok: true, data: agent.state.get("config") });
    return true;
  }

  if (method === "PATCH" && pathname === "/api/config") {
    handleAsync(req, res, async () => {
      const body = await readBody(req);
      const partial = parseJson(body);
      if (!partial) {
        error(res, "Invalid JSON body");
        return;
      }
      const current = agent.state.get("config");
      agent.state.set("config", { ...current, ...partial } as typeof current);
      json(res, { ok: true });
    });
    return true;
  }

  // ─── Settings ──────────────────────────────────────────────────

  if (method === "GET" && pathname === "/api/settings") {
    json(res, { ok: true, data: config });
    return true;
  }

  if (method === "PUT" && pathname === "/api/settings") {
    handleAsync(req, res, async () => {
      const body = await readBody(req);
      const settings = parseJson(body);
      if (!settings) {
        error(res, "Invalid JSON body");
        return;
      }
      // Settings persistence requires YAML — for now return the config as-is
      // Full persistence would mirror AgentManager.saveSettings
      json(res, { ok: true, data: config });
    });
    return true;
  }

  // ─── Messages ──────────────────────────────────────────────────

  if (method === "GET" && pathname === "/api/messages") {
    const messages = agent.state.get("messages").map((m) => ({
      role: m.role,
      content: m.content,
      name: (m as any).name,
    }));
    json(res, { ok: true, data: messages });
    return true;
  }

  // ─── Telemetry ─────────────────────────────────────────────────

  if (method === "GET" && pathname === "/api/telemetry") {
    const cfg = agent.state.get("config");
    json(res, {
      ok: true,
      data: {
        tokenUsage: agent.state.get("tokenUsage"),
        iterations: agent.state.get("iteration"),
        status: agent.state.get("status"),
        sessionId: agent.state.get("sessionId"),
        model: cfg.model,
        provider: cfg.provider,
        startedAt: agent.state.get("startedAt"),
        activeSoul: agent.state.get("activeSoul"),
        activeSkills: agent.state.get("activeSkills"),
        availableTools: agent.state.get("availableTools"),
      },
    });
    return true;
  }

  // ─── Running status ────────────────────────────────────────────

  if (method === "GET" && pathname === "/api/running") {
    const status = agent.state.get("status");
    json(res, { ok: true, data: status === "running" });
    return true;
  }

  // ─── Soul Files ────────────────────────────────────────────────

  if (method === "GET" && pathname === "/api/souls") {
    const soulsDir = getSoulsDir(config);
    if (!fs.existsSync(soulsDir)) {
      json(res, { ok: true, data: [] });
      return true;
    }
    const activeSoul = agent.state.get("activeSoul");
    const entries = fs.readdirSync(soulsDir);
    const files = entries
      .filter((e) => e.endsWith(".yaml") || e.endsWith(".yml"))
      .map((e) => {
        const name = e.replace(/\.(yaml|yml)$/, "");
        return { name, active: name === activeSoul || e === activeSoul };
      });
    json(res, { ok: true, data: files });
    return true;
  }

  if (method === "GET" && pathname.match(/^\/api\/souls\/[^/]+$/) && !pathname.includes("/activate")) {
    const name = decodeURIComponent(pathname.split("/")[3]);
    const soulsDir = getSoulsDir(config);
    const filePath = path.join(soulsDir, `${name}.yaml`);
    const altPath = path.join(soulsDir, `${name}.yml`);
    const resolved = fs.existsSync(filePath) ? filePath : fs.existsSync(altPath) ? altPath : null;
    if (!resolved) {
      error(res, "Soul file not found", 404);
      return true;
    }
    try {
      const soul = loadSoul(resolved);
      const activeSoul = agent.state.get("activeSoul");
      json(res, {
        ok: true,
        data: {
          name: soul.name,
          description: soul.layers?.context?.domain || "",
          modelHint: "",
          systemPrompt: soulToPromptContent(soul),
          active: soul.id === activeSoul,
        },
      });
    } catch {
      const raw = fs.readFileSync(resolved, "utf-8");
      json(res, {
        ok: true,
        data: { name, description: "", modelHint: "", systemPrompt: raw, active: false },
      });
    }
    return true;
  }

  if (method === "PUT" && pathname.match(/^\/api\/souls\/[^/]+$/) && !pathname.includes("/activate")) {
    const name = decodeURIComponent(pathname.split("/")[3]);
    handleAsync(req, res, async () => {
      const body = await readBody(req);
      const data = parseJson(body);
      if (!data) {
        error(res, "Invalid JSON body");
        return;
      }
      const soulsDir = getSoulsDir(config);
      if (!fs.existsSync(soulsDir)) fs.mkdirSync(soulsDir, { recursive: true });
      const filePath = path.join(soulsDir, `${name}.yaml`);
      // Write raw content
      const content = (data.systemPrompt as string) || "";
      fs.writeFileSync(filePath, content, "utf-8");
      json(res, { ok: true });
    });
    return true;
  }

  if (method === "DELETE" && pathname.match(/^\/api\/souls\/[^/]+$/)) {
    const name = decodeURIComponent(pathname.split("/")[3]);
    const soulsDir = getSoulsDir(config);
    const filePath = path.join(soulsDir, `${name}.yaml`);
    const altPath = path.join(soulsDir, `${name}.yml`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    else if (fs.existsSync(altPath)) fs.unlinkSync(altPath);
    json(res, { ok: true });
    return true;
  }

  if (method === "POST" && pathname.match(/^\/api\/souls\/[^/]+\/activate$/)) {
    const name = decodeURIComponent(pathname.split("/")[3]);
    agent.state.set("activeSoul", name);
    json(res, { ok: true });
    return true;
  }

  // ─── Feedback ──────────────────────────────────────────────────

  if (method === "GET" && pathname === "/api/feedback/pending") {
    const pending = agent.feedback.getPendingRequests();
    json(res, { ok: true, data: pending });
    return true;
  }

  // Route not matched
  return false;
}

/**
 * Helper to handle async route handlers within the sync request callback.
 */
function handleAsync(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handler: () => Promise<void>
): void {
  handler().catch((err: Error) => {
    error(res, err.message, 500);
  });
}
