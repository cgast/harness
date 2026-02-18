/**
 * TaskChain - Multi-step workflow orchestration with HITL checkpoints.
 *
 * Solves the problem: "one task follows another and we need state and
 * results to move from one to the other, with human feedback gates
 * between steps."
 *
 * A chain is a sequence of steps. Each step can be:
 *   - An agent task (run the LLM loop)
 *   - A feedback gate (wait for human input)
 *   - A transform (programmatic state transformation)
 *
 * State flows through the chain via a shared context object. Each step
 * can read previous results and write its own.
 *
 * Usage:
 *   const chain = new TaskChain(agent, feedbackManager);
 *
 *   const result = await chain
 *     .step("draft", { task: "Write a blog post about TypeScript" })
 *     .gate("review", {
 *       type: "review",
 *       prompt: "Review this draft",
 *       artifactFrom: "draft",  // automatically populates artifact from previous step
 *     })
 *     .step("revise", {
 *       task: (ctx) => `Revise the draft based on feedback: ${ctx.feedback("review").comments}`,
 *     })
 *     .gate("final-approval", {
 *       type: "confirm",
 *       prompt: "Approve the final version?",
 *       action: "Publish blog post",
 *     })
 *     .step("publish", {
 *       task: (ctx) => `Publish: ${ctx.result("revise")}`,
 *     })
 *     .run();
 */

import type { EventBus } from "../events/bus.js";
import type { FeedbackManager } from "./manager.js";
import type {
  FeedbackRequest,
  FeedbackResponse,
  FeedbackType,
  ReviewVerdict,
  FormField,
} from "./types.js";

// ── Chain context: carries state between steps ────────────────────

export interface ChainContext {
  /** Get the result of a previous agent step by name. */
  result(stepName: string): string;

  /** Get the feedback response from a previous gate by name. */
  feedback(gateName: string): FeedbackResponse;

  /** Get arbitrary data stored by a previous step. */
  get(key: string): unknown;

  /** Store arbitrary data for downstream steps. */
  set(key: string, value: unknown): void;

  /** All step results so far, keyed by step name. */
  readonly results: ReadonlyMap<string, StepOutcome>;
}

export interface StepOutcome {
  type: "task" | "gate" | "transform";
  name: string;
  /** For task steps: the agent's text response. */
  response?: string;
  /** For gate steps: the human's feedback response. */
  feedbackResponse?: FeedbackResponse;
  /** For transform steps: whatever the transform returned. */
  data?: unknown;
  /** Was this step successful? */
  success: boolean;
  /** Error message if failed. */
  error?: string;
}

// ── Step definitions ──────────────────────────────────────────────

/** A task step that runs the agent loop. */
export interface TaskStepDef {
  kind: "task";
  name: string;
  /** Static task string or function that builds the task from context. */
  task: string | ((ctx: ChainContext) => string);
  /** Optional: skip this step based on context. */
  skipIf?: (ctx: ChainContext) => boolean;
}

/** A feedback gate that waits for human input. */
export interface GateStepDef {
  kind: "gate";
  name: string;
  type: FeedbackType;
  prompt: string | ((ctx: ChainContext) => string);
  /** For review gates: pull artifact content from a previous step's result. */
  artifactFrom?: string;
  /** Additional gate config (varies by type). */
  config?: GateConfig;
  /** Adapter to use for this gate. */
  adapterId?: string;
  /** If the gate fails (denied/timeout), should the chain abort? Default: true. */
  abortOnDeny?: boolean;
  /** Optional: skip this gate based on context. */
  skipIf?: (ctx: ChainContext) => boolean;
}

export interface GateConfig {
  // Confirm
  action?: string;
  defaultDeny?: boolean;
  // Choice
  options?: Array<{ id: string; label: string; description?: string }>;
  multiple?: boolean;
  defaults?: string[];
  // Text
  placeholder?: string;
  multiline?: boolean;
  // Review
  artifactTitle?: string;
  contentType?: "text" | "markdown" | "code" | "json" | "diff";
  language?: string;
  allowedVerdicts?: ReviewVerdict[];
  // Form
  fields?: FormField[];
  // Shared
  timeout?: number;
  metadata?: Record<string, unknown>;
}

/** A programmatic transform step. */
export interface TransformStepDef {
  kind: "transform";
  name: string;
  fn: (ctx: ChainContext) => Promise<unknown> | unknown;
  skipIf?: (ctx: ChainContext) => boolean;
}

type StepDef = TaskStepDef | GateStepDef | TransformStepDef;

// ── Chain result ──────────────────────────────────────────────────

export interface ChainResult {
  success: boolean;
  /** Which step failed (if any). */
  failedAt?: string;
  /** All step outcomes in order. */
  steps: StepOutcome[];
  /** Final context (all accumulated state). */
  context: ChainContext;
}

// ── The agent interface we need (subset of HarnessAgent) ──────────

interface ChainAgent {
  run(task: string): Promise<{ success: boolean; response: string }>;
  bus: EventBus;
}

// ── TaskChain ─────────────────────────────────────────────────────

export class TaskChain {
  private steps: StepDef[] = [];
  private agent: ChainAgent;
  private feedbackManager: FeedbackManager;

  constructor(agent: ChainAgent, feedbackManager: FeedbackManager) {
    this.agent = agent;
    this.feedbackManager = feedbackManager;
  }

  /** Add an agent task step. */
  step(
    name: string,
    def: {
      task: string | ((ctx: ChainContext) => string);
      skipIf?: (ctx: ChainContext) => boolean;
    }
  ): this {
    this.steps.push({ kind: "task", name, ...def });
    return this;
  }

  /** Add a human feedback gate. */
  gate(
    name: string,
    def: {
      type: FeedbackType;
      prompt: string | ((ctx: ChainContext) => string);
      artifactFrom?: string;
      config?: GateConfig;
      adapterId?: string;
      abortOnDeny?: boolean;
      skipIf?: (ctx: ChainContext) => boolean;
    }
  ): this {
    this.steps.push({ kind: "gate", name, ...def });
    return this;
  }

  /** Add a programmatic transform step. */
  transform(
    name: string,
    fn: (ctx: ChainContext) => Promise<unknown> | unknown,
    skipIf?: (ctx: ChainContext) => boolean
  ): this {
    this.steps.push({ kind: "transform", name, fn, skipIf });
    return this;
  }

  /** Execute the chain. */
  async run(): Promise<ChainResult> {
    const outcomes: StepOutcome[] = [];
    const store = new Map<string, unknown>();
    const resultMap = new Map<string, StepOutcome>();

    const ctx: ChainContext = {
      result(stepName: string): string {
        const outcome = resultMap.get(stepName);
        if (!outcome) throw new Error(`No result for step '${stepName}' — step hasn't run yet.`);
        return outcome.response ?? "";
      },
      feedback(gateName: string): FeedbackResponse {
        const outcome = resultMap.get(gateName);
        if (!outcome?.feedbackResponse) {
          throw new Error(`No feedback for gate '${gateName}' — gate hasn't run yet.`);
        }
        return outcome.feedbackResponse;
      },
      get(key: string): unknown {
        return store.get(key);
      },
      set(key: string, value: unknown): void {
        store.set(key, value);
      },
      get results(): ReadonlyMap<string, StepOutcome> {
        return resultMap;
      },
    };

    for (const stepDef of this.steps) {
      // Check skip condition
      if (stepDef.skipIf?.(ctx)) {
        const skipped: StepOutcome = {
          type: stepDef.kind === "gate" ? "gate" : stepDef.kind === "task" ? "task" : "transform",
          name: stepDef.name,
          success: true,
          data: { skipped: true },
        };
        outcomes.push(skipped);
        resultMap.set(stepDef.name, skipped);
        continue;
      }

      let outcome: StepOutcome;

      switch (stepDef.kind) {
        case "task":
          outcome = await this.runTaskStep(stepDef, ctx);
          break;
        case "gate":
          outcome = await this.runGateStep(stepDef, ctx);
          break;
        case "transform":
          outcome = await this.runTransformStep(stepDef, ctx);
          break;
      }

      outcomes.push(outcome);
      resultMap.set(stepDef.name, outcome);

      // Check for failure
      if (!outcome.success) {
        return {
          success: false,
          failedAt: stepDef.name,
          steps: outcomes,
          context: ctx,
        };
      }
    }

    return {
      success: true,
      steps: outcomes,
      context: ctx,
    };
  }

  // ── Private step runners ────────────────────────────────────────

  private async runTaskStep(def: TaskStepDef, ctx: ChainContext): Promise<StepOutcome> {
    try {
      const task = typeof def.task === "function" ? def.task(ctx) : def.task;
      const result = await this.agent.run(task);
      return {
        type: "task",
        name: def.name,
        response: result.response,
        success: result.success,
        error: result.success ? undefined : result.response,
      };
    } catch (err) {
      return {
        type: "task",
        name: def.name,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async runGateStep(def: GateStepDef, ctx: ChainContext): Promise<StepOutcome> {
    const abortOnDeny = def.abortOnDeny ?? true;

    try {
      const prompt = typeof def.prompt === "function" ? def.prompt(ctx) : def.prompt;
      let response: FeedbackResponse;

      switch (def.type) {
        case "confirm":
          response = await this.feedbackManager.confirm(
            prompt,
            def.config?.action ?? prompt,
            {
              adapterId: def.adapterId,
              timeout: def.config?.timeout,
              defaultDeny: def.config?.defaultDeny,
              metadata: def.config?.metadata,
            }
          );
          break;

        case "choice":
          response = await this.feedbackManager.choose(
            prompt,
            def.config?.options ?? [],
            {
              adapterId: def.adapterId,
              timeout: def.config?.timeout,
              multiple: def.config?.multiple,
              defaults: def.config?.defaults,
              metadata: def.config?.metadata,
            }
          );
          break;

        case "text":
          response = await this.feedbackManager.askText(prompt, {
            adapterId: def.adapterId,
            timeout: def.config?.timeout,
            placeholder: def.config?.placeholder,
            multiline: def.config?.multiline,
            metadata: def.config?.metadata,
          });
          break;

        case "review": {
          // Build artifact — optionally pull content from a previous step
          let content = "";
          if (def.artifactFrom) {
            content = ctx.result(def.artifactFrom);
          }
          response = await this.feedbackManager.review(
            prompt,
            {
              title: def.config?.artifactTitle ?? def.name,
              content,
              contentType: def.config?.contentType ?? "text",
              language: def.config?.language,
            },
            {
              adapterId: def.adapterId,
              timeout: def.config?.timeout,
              allowedVerdicts: def.config?.allowedVerdicts,
              metadata: def.config?.metadata,
            }
          );
          break;
        }

        case "form":
          response = await this.feedbackManager.form(
            prompt,
            def.config?.fields ?? [],
            {
              adapterId: def.adapterId,
              timeout: def.config?.timeout,
              metadata: def.config?.metadata,
            }
          );
          break;
      }

      // Determine if the gate "passed"
      const passed = this.evaluateGateResponse(def.type, response);

      return {
        type: "gate",
        name: def.name,
        feedbackResponse: response,
        success: passed || !abortOnDeny,
        error: passed ? undefined : "Feedback gate denied or timed out",
      };
    } catch (err) {
      return {
        type: "gate",
        name: def.name,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async runTransformStep(def: TransformStepDef, ctx: ChainContext): Promise<StepOutcome> {
    try {
      const data = await def.fn(ctx);
      return {
        type: "transform",
        name: def.name,
        data,
        success: true,
      };
    } catch (err) {
      return {
        type: "transform",
        name: def.name,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private evaluateGateResponse(type: FeedbackType, response: FeedbackResponse): boolean {
    if (response.status === "timeout" || response.status === "cancelled" || response.status === "error") {
      return false;
    }

    switch (type) {
      case "confirm":
        return (response as any).approved === true;
      case "review":
        return (response as any).verdict === "approve";
      case "choice":
      case "text":
      case "form":
        // These are informational — always "pass"
        return true;
      default:
        return true;
    }
  }
}
