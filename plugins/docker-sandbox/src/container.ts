/**
 * Docker container manager — handles container lifecycle, image building,
 * and command execution inside sandboxed containers.
 *
 * Uses the Docker CLI directly (no SDK dependency) for portability.
 */

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

// ── Types ─────────────────────────────────────────────────────

export interface ContainerConfig {
  /** Docker image to use (default: "harness-sandbox:latest") */
  image: string;
  /** Memory limit (default: "512m") */
  memoryLimit: string;
  /** CPU limit as a fraction of one core (default: "1.0") */
  cpuLimit: string;
  /** Network access mode (default: "none") */
  networkMode: string;
  /** Enable read-only root filesystem (default: true) */
  readonlyRoot: boolean;
  /** Directories to bind-mount from host (read-only by default) */
  mounts: MountConfig[];
  /** Writable workspace path inside the container */
  workspacePath: string;
  /** Command execution timeout in ms (default: 55000) */
  execTimeout: number;
  /** Max output size in bytes (default: 1MB) */
  maxOutputBytes: number;
  /** Whether to auto-build the sandbox image if missing (default: true) */
  autoBuildImage: boolean;
  /** Additional security options (e.g., seccomp profile) */
  securityOpts: string[];
  /** Capabilities to drop (default: ALL) */
  dropCapabilities: string[];
  /** PID limit (default: 256) */
  pidsLimit: number;
  /** tmpfs mounts for writable areas (e.g., /tmp) */
  tmpfsMounts: Record<string, string>;
}

export interface MountConfig {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ContainerInfo {
  id: string;
  name: string;
  status: "running" | "stopped" | "error";
  createdAt: number;
  execCount: number;
}

// ── Defaults ──────────────────────────────────────────────────

const DEFAULT_CONFIG: ContainerConfig = {
  image: "harness-sandbox:latest",
  memoryLimit: "512m",
  cpuLimit: "1.0",
  networkMode: "none",
  readonlyRoot: true,
  mounts: [],
  workspacePath: "/workspace",
  execTimeout: 55_000,
  maxOutputBytes: 1024 * 1024,
  autoBuildImage: true,
  securityOpts: ["no-new-privileges"],
  dropCapabilities: ["ALL"],
  pidsLimit: 256,
  tmpfsMounts: {
    "/tmp": "size=64m",
    "/run": "size=16m",
  },
};

// Minimal Dockerfile for the sandbox image
const SANDBOX_DOCKERFILE = `
FROM debian:bookworm-slim

RUN apt-get update && \\
    apt-get install -y --no-install-recommends \\
      coreutils bash findutils grep sed gawk \\
      curl wget git \\
      python3 python3-pip \\
      nodejs npm \\
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash -u 1000 sandbox
WORKDIR /workspace
USER sandbox

LABEL harness.sandbox="true"
`.trim();

// ── Container Manager ─────────────────────────────────────────

export class ContainerManager {
  private config: ContainerConfig;
  private container: ContainerInfo | null = null;
  private logFn: (msg: string) => void;

  constructor(config: Partial<ContainerConfig> = {}, logFn?: (msg: string) => void) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logFn = logFn ?? ((msg) => console.log(`[DockerSandbox] ${msg}`));
  }

  /** Get the current container info, if running */
  getContainerInfo(): ContainerInfo | null {
    return this.container;
  }

  /** Get the resolved config */
  getConfig(): Readonly<ContainerConfig> {
    return this.config;
  }

  // ── Image management ──────────────────────────────────────

  /** Check if the sandbox image exists locally */
  async imageExists(): Promise<boolean> {
    try {
      await this.dockerCmd(["image", "inspect", this.config.image]);
      return true;
    } catch {
      return false;
    }
  }

  /** Build the sandbox image from the embedded Dockerfile */
  async buildImage(): Promise<void> {
    this.log("Building sandbox image...");

    const tmpDir = `/tmp/harness-sandbox-build-${randomBytes(4).toString("hex")}`;

    try {
      // Write Dockerfile to temp location
      await this.shellExec("mkdir", ["-p", tmpDir]);

      const dockerfilePath = path.join(tmpDir, "Dockerfile");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(dockerfilePath, SANDBOX_DOCKERFILE, "utf-8");

      // Build the image
      await this.dockerCmd(
        ["build", "-t", this.config.image, "-f", dockerfilePath, tmpDir],
        120_000 // 2 min timeout for image build
      );

      this.log("Sandbox image built successfully");
    } finally {
      // Cleanup temp dir
      try {
        await this.shellExec("rm", ["-rf", tmpDir]);
      } catch { /* ignore cleanup errors */ }
    }
  }

  /** Ensure image is available, building if needed */
  async ensureImage(): Promise<void> {
    if (await this.imageExists()) {
      this.log(`Image ${this.config.image} found`);
      return;
    }

    if (!this.config.autoBuildImage) {
      throw new Error(
        `Sandbox image '${this.config.image}' not found and autoBuildImage is disabled. ` +
        `Build it manually: docker build -t ${this.config.image} <context-dir>`
      );
    }

    await this.buildImage();
  }

  // ── Container lifecycle ───────────────────────────────────

  /** Start a new sandbox container */
  async start(hostWorkdir?: string): Promise<string> {
    // Clean up any existing container
    if (this.container) {
      await this.stop();
    }

    await this.ensureImage();

    const name = `harness-sandbox-${randomBytes(4).toString("hex")}`;
    const args = this.buildRunArgs(name, hostWorkdir);

    this.log(`Starting container '${name}'...`);
    const result = await this.dockerCmd(args);
    const containerId = result.stdout.trim();

    this.container = {
      id: containerId,
      name,
      status: "running",
      createdAt: Date.now(),
      execCount: 0,
    };

    // Verify the container is actually running
    const isRunning = await this.isContainerRunning();
    if (!isRunning) {
      this.container.status = "error";
      const logs = await this.getContainerLogs();
      throw new Error(`Container failed to start. Logs:\n${logs}`);
    }

    this.log(`Container '${name}' started (${containerId.slice(0, 12)})`);
    return containerId;
  }

  /** Stop and remove the sandbox container */
  async stop(): Promise<void> {
    if (!this.container) return;

    const { name, id } = this.container;
    this.log(`Stopping container '${name}'...`);

    try {
      // Force-remove (stop + rm) in one shot
      await this.dockerCmd(["rm", "-f", id], 15_000);
    } catch (err) {
      this.log(`Warning: failed to remove container '${name}': ${err}`);
    }

    this.container = null;
    this.log(`Container '${name}' stopped and removed`);
  }

  /** Check if container is running */
  async isContainerRunning(): Promise<boolean> {
    if (!this.container) return false;

    try {
      const result = await this.dockerCmd([
        "inspect",
        "-f",
        "{{.State.Running}}",
        this.container.id,
      ]);
      return result.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  /** Get container logs */
  async getContainerLogs(tail: number = 50): Promise<string> {
    if (!this.container) return "(no container)";

    try {
      const result = await this.dockerCmd([
        "logs",
        "--tail",
        String(tail),
        this.container.id,
      ]);
      return (result.stdout + result.stderr).trim();
    } catch {
      return "(failed to fetch logs)";
    }
  }

  // ── Command execution inside container ────────────────────

  /** Execute a shell command inside the container */
  async exec(command: string, workdir?: string): Promise<ExecResult> {
    if (!this.container || this.container.status !== "running") {
      throw new Error("No running sandbox container. Call start() first.");
    }

    const cwd = workdir || this.config.workspacePath;

    const args = [
      "exec",
      "--user", "sandbox",
      "--workdir", cwd,
      this.container.id,
      "/bin/bash", "-c", command,
    ];

    this.container.execCount++;

    try {
      const result = await this.dockerCmd(args, this.config.execTimeout);
      return {
        exitCode: 0,
        stdout: this.truncate(result.stdout),
        stderr: this.truncate(result.stderr),
      };
    } catch (err: any) {
      return {
        exitCode: err.exitCode ?? 1,
        stdout: this.truncate(err.stdout ?? ""),
        stderr: this.truncate(err.stderr ?? err.message ?? ""),
      };
    }
  }

  /** Copy a file into the container */
  async copyToContainer(hostPath: string, containerPath: string): Promise<void> {
    if (!this.container) throw new Error("No running container");

    await this.dockerCmd([
      "cp",
      hostPath,
      `${this.container.id}:${containerPath}`,
    ]);
  }

  /** Copy a file out of the container */
  async copyFromContainer(containerPath: string, hostPath: string): Promise<void> {
    if (!this.container) throw new Error("No running container");

    await this.dockerCmd([
      "cp",
      `${this.container.id}:${containerPath}`,
      hostPath,
    ]);
  }

  /** Read a file from inside the container */
  async readFile(containerPath: string): Promise<string> {
    const result = await this.exec(`cat ${this.shellEscape(containerPath)}`);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file '${containerPath}': ${result.stderr}`);
    }
    return result.stdout;
  }

  /** Write a file inside the container */
  async writeFile(containerPath: string, content: string): Promise<void> {
    // Use base64 to safely transfer content with special characters
    const b64 = Buffer.from(content, "utf-8").toString("base64");
    const dir = path.dirname(containerPath);
    const result = await this.exec(
      `mkdir -p ${this.shellEscape(dir)} && echo '${b64}' | base64 -d > ${this.shellEscape(containerPath)}`
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to write file '${containerPath}': ${result.stderr}`);
    }
  }

  /** List files inside the container */
  async listDir(containerPath: string): Promise<string> {
    const result = await this.exec(
      `ls -1F ${this.shellEscape(containerPath)} 2>/dev/null || echo "(empty or not found)"`
    );
    return result.stdout;
  }

  // ── Private helpers ───────────────────────────────────────

  /** Build the `docker run` argument list */
  private buildRunArgs(name: string, hostWorkdir?: string): string[] {
    const args = [
      "run",
      "--detach",
      "--name", name,
      // Resource limits
      "--memory", this.config.memoryLimit,
      "--cpus", this.config.cpuLimit,
      "--pids-limit", String(this.config.pidsLimit),
      // Network isolation
      "--network", this.config.networkMode,
      // Security hardening
      ...this.config.dropCapabilities.flatMap((cap) => ["--cap-drop", cap]),
      ...this.config.securityOpts.flatMap((opt) => ["--security-opt", opt]),
    ];

    // Read-only root filesystem
    if (this.config.readonlyRoot) {
      args.push("--read-only");
    }

    // tmpfs mounts for writable areas
    for (const [mountPath, opts] of Object.entries(this.config.tmpfsMounts)) {
      args.push("--tmpfs", `${mountPath}:${opts}`);
    }

    // Bind-mount host workspace if provided
    if (hostWorkdir) {
      args.push(
        "--volume",
        `${hostWorkdir}:${this.config.workspacePath}:rw`
      );
    }

    // Additional configured mounts
    for (const m of this.config.mounts) {
      const mode = m.readonly ? "ro" : "rw";
      args.push("--volume", `${m.hostPath}:${m.containerPath}:${mode}`);
    }

    // Use a long-running process so the container stays alive
    args.push(this.config.image, "sleep", "infinity");

    return args;
  }

  /** Run a docker CLI command and return stdout/stderr */
  private dockerCmd(
    args: string[],
    timeout: number = 30_000
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        "docker",
        args,
        { timeout, maxBuffer: this.config.maxOutputBytes },
        (error, stdout, stderr) => {
          if (error) {
            const err: any = new Error(
              `docker ${args[0]} failed: ${error.message}`
            );
            err.exitCode = error.code;
            err.stdout = stdout;
            err.stderr = stderr;
            reject(err);
          } else {
            resolve({ stdout, stderr });
          }
        }
      );
    });
  }

  /** Run a generic command (for temp file operations during build) */
  private shellExec(
    cmd: string,
    args: string[],
    timeout: number = 10_000
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout }, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    });
  }

  /** Truncate output to max bytes */
  private truncate(str: string): string {
    if (Buffer.byteLength(str, "utf-8") <= this.config.maxOutputBytes) {
      return str;
    }
    const truncated = Buffer.from(str, "utf-8")
      .subarray(0, this.config.maxOutputBytes)
      .toString("utf-8");
    return truncated + "\n... [output truncated]";
  }

  /** Escape a string for use in shell commands */
  private shellEscape(str: string): string {
    return `'${str.replace(/'/g, "'\\''")}'`;
  }

  private log(msg: string): void {
    this.logFn(msg);
  }
}
