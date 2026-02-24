/**
 * Harness Sandbox Plugin
 *
 * Intercepts tool execution (shell, file_read, file_write, file_list) and
 * redirects commands into an isolated Docker container. This provides a
 * sandboxed execution environment with Python, Node.js, and LibreOffice
 * without modifying the core agent loop.
 *
 * Configuration (in ~/.harness/config.yaml):
 *
 *   plugins:
 *     sandbox:
 *       enabled: true
 *       image: "harness-sandbox:latest"
 *       warmContainer: true
 *       networkDisabled: true
 *       memoryLimit: "2g"
 *       cpuLimit: 1.5
 *       timeout: 300
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { HarnessPlugin, PluginContext, Logger } from "@harness/core";
import { DockerClient } from "./docker.js";
import { createInterceptorHooks } from "./interceptor.js";
import { DEFAULT_SANDBOX_CONFIG, DELIVERABLES_DIR } from "./types.js";
import type { SandboxConfig } from "./types.js";

let log: Logger;
let docker: DockerClient;
let config: SandboxConfig;

const sandboxPlugin: HarnessPlugin = {
  id: "harness-sandbox",
  name: "Docker Sandbox",
  version: "0.1.0",

  async activate(ctx: PluginContext) {
    log = ctx.log;

    // ── Read configuration ───────────────────────────────────
    config = {
      enabled: ctx.config.get("enabled", DEFAULT_SANDBOX_CONFIG.enabled),
      image: ctx.config.get("image", DEFAULT_SANDBOX_CONFIG.image),
      warmContainer: ctx.config.get("warmContainer", DEFAULT_SANDBOX_CONFIG.warmContainer),
      networkDisabled: ctx.config.get("networkDisabled", DEFAULT_SANDBOX_CONFIG.networkDisabled),
      memoryLimit: ctx.config.get("memoryLimit", DEFAULT_SANDBOX_CONFIG.memoryLimit),
      cpuLimit: ctx.config.get("cpuLimit", DEFAULT_SANDBOX_CONFIG.cpuLimit),
      timeout: ctx.config.get("timeout", DEFAULT_SANDBOX_CONFIG.timeout),
    };

    if (!config.enabled) {
      log.info("Sandbox plugin is disabled via configuration");
      return;
    }

    // ── Determine working directory ──────────────────────────
    const workdir = process.cwd();

    // ── Ensure deliverables directory exists on host ──────────
    const deliverablesPath = path.join(workdir, DELIVERABLES_DIR);
    if (!fs.existsSync(deliverablesPath)) {
      fs.mkdirSync(deliverablesPath, { recursive: true });
      log.info(`Created deliverables directory: ${deliverablesPath}`);
    }

    // ── Initialize Docker client ─────────────────────────────
    docker = new DockerClient(config, workdir, log);

    // Check Docker availability
    const available = await docker.isAvailable();
    if (!available) {
      log.error(
        "Docker is not available. The sandbox plugin requires Docker to be installed and running. " +
        "Tool execution will fall through to host."
      );
      return;
    }

    log.info("Docker is available");

    // ── Ensure sandbox image exists ──────────────────────────
    const imageReady = await docker.imageExists();
    if (!imageReady) {
      log.info(`Sandbox image '${config.image}' not found locally, attempting to build...`);

      // Look for Dockerfile in common locations
      const dockerfileCandidates = [
        path.join(workdir, "sandbox"),
        path.join(workdir, "..", "sandbox"),
        path.resolve(workdir, "sandbox"),
      ];

      let built = false;
      for (const candidate of dockerfileCandidates) {
        const dockerfilePath = path.join(candidate, "Dockerfile");
        if (fs.existsSync(dockerfilePath)) {
          try {
            await docker.buildImage(candidate);
            built = true;
            break;
          } catch (err: any) {
            log.warn(`Failed to build from ${candidate}: ${err.message}`);
          }
        }
      }

      if (!built) {
        log.error(
          `Sandbox image '${config.image}' not found and could not be built. ` +
          `Run 'docker build -t ${config.image} sandbox/' manually.`
        );
        return;
      }
    } else {
      log.info(`Sandbox image '${config.image}' found`);
    }

    // ── Start warm container if configured ───────────────────
    if (config.warmContainer) {
      try {
        await docker.startWarmContainer();
      } catch (err: any) {
        log.warn(`Failed to start warm container: ${err.message}. Will use cold starts.`);
      }
    }

    log.info("Sandbox plugin activated - tool execution will be redirected to Docker");
  },

  async deactivate() {
    if (docker) {
      await docker.stopWarmContainer();
    }
    log?.info("Sandbox plugin deactivated");
  },

  // ── Event hooks (created lazily on first access) ───────────
  get hooks() {
    // If Docker isn't initialized, return empty hooks
    if (!docker) {
      return [];
    }
    return createInterceptorHooks(docker, log);
  },
};

export default sandboxPlugin;
