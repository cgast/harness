/**
 * Harness Server - HTTP/WebSocket server for headless operation.
 * Placeholder for Phase 4 implementation.
 */

import * as http from "node:http";
import { createAgent, loadConfig } from "@harness/core";

const PORT = parseInt(process.env.PORT || "3000", 10);

async function main() {
  const config = loadConfig();
  const agent = await createAgent(config);

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
      res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/run") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
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

  server.listen(PORT, () => {
    console.log(`[harness-server] Listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("[harness-server] Fatal:", err);
  process.exit(1);
});
