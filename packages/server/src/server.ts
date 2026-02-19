/**
 * Harness Server - HTTP/WebSocket server for headless operation.
 *
 * Provides two interfaces:
 * 1. REST API  - POST /api/run (blocking, returns full result)
 * 2. WebSocket - ws://host:port/ws (streaming, real-time events)
 *
 * The WebSocket interface streams all agent events (LLM chunks, tool
 * executions, feedback requests, etc.) to connected clients in real time.
 */

import * as http from "node:http";
import { WebSocketServer } from "ws";
import { createAgent, loadConfig } from "@harness/core";
import { attachWebSocket } from "./ws.js";

const PORT = parseInt(process.env.PORT || "3000", 10);

async function main() {
  const config = loadConfig();
  const agent = await createAgent(config);

  // ── HTTP server ─────────────────────────────────────────────────

  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          version: "0.1.0",
          connections: sessions.size,
        })
      );
      return;
    }

    if (req.method === "POST" && req.url === "/api/run") {
      let body = "";
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", async () => {
        try {
          const { task } = JSON.parse(body);
          if (!task) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing 'task' field" }));
            return;
          }

          const result = await agent.run(task);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  // ── WebSocket server ────────────────────────────────────────────

  const wss = new WebSocketServer({ noServer: true });
  const sessions = attachWebSocket(wss, agent);

  // Handle HTTP upgrade requests on the /ws path
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });

  // ── Start ───────────────────────────────────────────────────────

  server.listen(PORT, () => {
    console.log(`[harness-server] Listening on port ${PORT}`);
    console.log(`[harness-server] REST API: http://localhost:${PORT}/api/run`);
    console.log(`[harness-server] WebSocket: ws://localhost:${PORT}/ws`);
  });
}

main().catch((err) => {
  console.error("[harness-server] Fatal:", err);
  process.exit(1);
});
