/**
 * REST API definitions for server mode.
 * Placeholder for Phase 4.
 */

export interface RunTaskRequest {
  task: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxIterations?: number;
}

export interface RunTaskResponse {
  success: boolean;
  response: string;
  iterations: number;
  tokenUsage: { input: number; output: number };
  aborted: boolean;
}

export interface HealthResponse {
  status: "ok" | "error";
  version: string;
}
