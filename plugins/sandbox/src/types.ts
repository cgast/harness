/**
 * Configuration and type definitions for the sandbox plugin.
 */

export interface SandboxConfig {
  /** Whether the sandbox plugin is active. */
  enabled: boolean;
  /** Docker image to use. Default: "harness-sandbox:latest" */
  image: string;
  /** Keep a warm container running between tasks. Default: true */
  warmContainer: boolean;
  /** Disable networking inside the container. Default: true (no network) */
  networkDisabled: boolean;
  /** Container memory limit (Docker format). Default: "2g" */
  memoryLimit: string;
  /** CPU limit (number of CPUs). Default: 1.5 */
  cpuLimit: number;
  /** Per-command timeout in seconds. Default: 300 */
  timeout: number;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: true,
  image: "harness-sandbox:latest",
  warmContainer: true,
  networkDisabled: true,
  memoryLimit: "2g",
  cpuLimit: 1.5,
  timeout: 300,
};

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Tools that should be intercepted and run inside the sandbox container. */
export const SANDBOXED_TOOLS = ["shell", "file_write", "file_read", "file_list"] as const;

/** The output directory inside the container for deliverables. */
export const DELIVERABLES_DIR = ".harness-out";
