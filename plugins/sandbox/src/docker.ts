/**
 * Docker client wrapper for the sandbox plugin.
 *
 * Shells out to the `docker` CLI rather than depending on a Docker SDK,
 * keeping the dependency footprint minimal.
 */

import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "@harness/core";
import type { SandboxConfig, ExecResult } from "./types.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export class DockerClient {
  private config: SandboxConfig;
  private log: Logger;
  private warmContainerId: string | null = null;
  private workdir: string;

  constructor(config: SandboxConfig, workdir: string, log: Logger) {
    this.config = config;
    this.workdir = workdir;
    this.log = log;
  }

  // ── Docker availability ────────────────────────────────────

  /**
   * Check if Docker is available and running.
   */
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync("docker", ["info"], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  // ── Image management ───────────────────────────────────────

  /**
   * Check if the sandbox image exists locally.
   */
  async imageExists(): Promise<boolean> {
    try {
      await execFileAsync("docker", ["image", "inspect", this.config.image], {
        timeout: 10_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build the sandbox image from the Dockerfile in the sandbox/ directory.
   */
  async buildImage(dockerfilePath: string): Promise<void> {
    this.log.info(`Building sandbox image: ${this.config.image}`);
    const { stdout, stderr } = await execAsync(
      `docker build -t ${this.config.image} ${dockerfilePath}`,
      { timeout: 600_000 } // 10 minutes for image build
    );
    if (stderr) {
      this.log.debug(`Build stderr: ${stderr.slice(0, 500)}`);
    }
    this.log.info("Sandbox image built successfully");
  }

  // ── Container lifecycle ────────────────────────────────────

  /**
   * Start a warm container that stays running for subsequent exec calls.
   */
  async startWarmContainer(): Promise<void> {
    if (this.warmContainerId) {
      // Already running - verify it's still alive
      if (await this.isContainerRunning(this.warmContainerId)) {
        return;
      }
      this.warmContainerId = null;
    }

    const args = this.buildRunArgs([
      "--rm",
      "-d", // detached
      "--name", `harness-sandbox-${Date.now()}`,
      ...this.buildResourceArgs(),
      ...this.buildNetworkArgs(false),
      ...this.buildMountArgs(),
      this.config.image,
      "sleep infinity", // keep container alive
    ]);

    const { stdout } = await execFileAsync("docker", args, { timeout: 30_000 });
    this.warmContainerId = stdout.trim();
    this.log.info(`Warm container started: ${this.warmContainerId.slice(0, 12)}`);
  }

  /**
   * Stop and remove the warm container.
   */
  async stopWarmContainer(): Promise<void> {
    if (!this.warmContainerId) return;

    try {
      await execFileAsync("docker", ["rm", "-f", this.warmContainerId], {
        timeout: 15_000,
      });
      this.log.info(`Warm container stopped: ${this.warmContainerId.slice(0, 12)}`);
    } catch (err) {
      this.log.warn(`Failed to stop warm container: ${err}`);
    }
    this.warmContainerId = null;
  }

  /**
   * Check if a specific container is still running.
   */
  private async isContainerRunning(containerId: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["inspect", "-f", "{{.State.Running}}", containerId],
        { timeout: 5_000 }
      );
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  // ── Command execution ──────────────────────────────────────

  /**
   * Execute a command inside the sandbox.
   *
   * Uses `docker exec` if a warm container is running,
   * otherwise falls back to `docker run`.
   */
  async execute(
    command: string,
    options: { networkAccess?: boolean; workdir?: string } = {}
  ): Promise<ExecResult> {
    const timeoutMs = this.config.timeout * 1000;
    const containerWorkdir = options.workdir || "/workspace";

    if (this.warmContainerId && await this.isContainerRunning(this.warmContainerId)) {
      return this.execInWarmContainer(command, containerWorkdir, timeoutMs);
    }

    return this.execWithRun(command, containerWorkdir, timeoutMs, options.networkAccess ?? false);
  }

  /**
   * Execute a command in the warm container via `docker exec`.
   */
  private async execInWarmContainer(
    command: string,
    workdir: string,
    timeoutMs: number
  ): Promise<ExecResult> {
    const args = [
      "exec",
      "-w", workdir,
      this.warmContainerId!,
      "/bin/bash", "-c", command,
    ];

    return this.runDockerCommand(args, timeoutMs);
  }

  /**
   * Execute a command via a fresh `docker run` (cold start).
   */
  private async execWithRun(
    command: string,
    workdir: string,
    timeoutMs: number,
    networkAccess: boolean
  ): Promise<ExecResult> {
    const args = this.buildRunArgs([
      "--rm",
      "-w", workdir,
      ...this.buildResourceArgs(),
      ...this.buildNetworkArgs(networkAccess),
      ...this.buildMountArgs(),
      this.config.image,
      command,
    ]);

    return this.runDockerCommand(args, timeoutMs);
  }

  /**
   * Run a docker command and capture stdout/stderr/exit code.
   */
  private async runDockerCommand(args: string[], timeoutMs: number): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync("docker", args, {
        timeout: timeoutMs,
        maxBuffer: 5 * 1024 * 1024, // 5MB
      });
      return { exitCode: 0, stdout, stderr };
    } catch (err: any) {
      return {
        exitCode: err.code ?? 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
      };
    }
  }

  // ── File operations inside the container ───────────────────

  /**
   * Read a file from within the container.
   */
  async readFile(filePath: string): Promise<ExecResult> {
    return this.execute(`cat "${filePath}"`);
  }

  /**
   * Write content to a file inside the container.
   */
  async writeFile(filePath: string, content: string): Promise<ExecResult> {
    // Use a heredoc-style approach via base64 to handle arbitrary content
    const encoded = Buffer.from(content).toString("base64");
    return this.execute(
      `mkdir -p "$(dirname "${filePath}")" && echo "${encoded}" | base64 -d > "${filePath}"`
    );
  }

  /**
   * List files in a directory inside the container.
   */
  async listFiles(dirPath: string): Promise<ExecResult> {
    return this.execute(
      `ls -1p "${dirPath}" 2>/dev/null || echo "(directory not found)"`
    );
  }

  // ── Argument builders ──────────────────────────────────────

  private buildRunArgs(extra: string[]): string[] {
    return ["run", ...extra];
  }

  private buildResourceArgs(): string[] {
    const args: string[] = [];
    if (this.config.memoryLimit) {
      args.push("--memory", this.config.memoryLimit);
    }
    if (this.config.cpuLimit) {
      args.push("--cpus", String(this.config.cpuLimit));
    }
    return args;
  }

  private buildNetworkArgs(enableNetwork: boolean): string[] {
    if (this.config.networkDisabled && !enableNetwork) {
      return ["--network", "none"];
    }
    return [];
  }

  private buildMountArgs(): string[] {
    return [
      "-v", `${this.workdir}:/workspace`,
    ];
  }

  // ── Accessors ──────────────────────────────────────────────

  get isWarm(): boolean {
    return this.warmContainerId !== null;
  }

  get containerId(): string | null {
    return this.warmContainerId;
  }

  /**
   * Update the working directory (e.g., when a new task starts).
   */
  setWorkdir(workdir: string): void {
    this.workdir = workdir;
  }
}
