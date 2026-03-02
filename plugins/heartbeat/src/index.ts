/**
 * Heartbeat Plugin
 *
 * Periodically triggers an agent session with a configurable mission prompt.
 * Only runs while the Electron app is open — no background daemon, no cron.
 *
 * The plugin reads a `runTask` callback from its PluginConfig, which the
 * desktop app provides at load time. Each tick checks whether the agent is
 * busy and whether quiet hours are active before firing.
 *
 * Configuration (via ~/.harness/config.yaml under plugins.heartbeat):
 *   intervalMs:       Timer interval in milliseconds (default: 3600000 = 1 hour)
 *   enabled:          Whether the timer is active (default: true)
 *   mission:          The task prompt sent on each tick
 *   soulId:           Optional soul document ID for heartbeat sessions
 *   maxIterations:    Cap agent iterations per heartbeat (default: 5)
 *   skipIfBusy:       Skip tick when agent is already running (default: true)
 *   quietHoursStart:  HH:MM to pause heartbeats (e.g. "22:00")
 *   quietHoursEnd:    HH:MM to resume heartbeats (e.g. "08:00")
 */

import type {
  HarnessPlugin,
  PluginContext,
  Logger,
  ToolContext,
  ToolResult,
} from "@harness/core";

// ── Types ─────────────────────────────────────────────────────

interface HeartbeatRecord {
  timestamp: string;
  summary: string;
  tokenUsage: { input: number; output: number };
  skipped: boolean;
  skipReason?: string;
}

export interface HeartbeatStatus {
  enabled: boolean;
  intervalMs: number;
  mission: string;
  tickCount: number;
  lastTick: string | null;
  nextTickEstimate: string | null;
  isInQuietHours: boolean;
}

export interface HeartbeatConfig {
  enabled?: boolean;
  intervalMs?: number;
  mission?: string;
  soulId?: string | null;
  maxIterations?: number;
  skipIfBusy?: boolean;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
}

type RunTaskFn = (options: {
  task: string;
  maxIterations?: number;
}) => Promise<{
  success: boolean;
  response: string;
  iterations: number;
  tokenUsage: { input: number; output: number };
  aborted: boolean;
}>;

type IsRunningFn = () => boolean;

// ── Constants ─────────────────────────────────────────────────

const SCOPE = "plugin:heartbeat";
const HISTORY_KEY = "history";
const LAST_TICK_KEY = "last-tick";
const TICK_COUNT_KEY = "tick-count";
const MAX_HISTORY = 100;

const DEFAULT_MISSION =
  "You are running as an autonomous heartbeat check. " +
  "Review recent activity, surface anything the user should know, " +
  "and provide a brief status summary. Be concise.";

// ── State ─────────────────────────────────────────────────────

let log: Logger;
let ctx: PluginContext;
let timer: ReturnType<typeof setInterval> | null = null;
let lastTickTime: number | null = null;
let ticking = false;

// Current effective config
let currentConfig = {
  enabled: true,
  intervalMs: 3_600_000,
  mission: DEFAULT_MISSION,
  soulId: null as string | null,
  maxIterations: 5,
  skipIfBusy: true,
  quietHoursStart: null as string | null,
  quietHoursEnd: null as string | null,
};

// Reports written by the LLM during a heartbeat session
let pendingReports: string[] = [];

// ── Helpers ───────────────────────────────────────────────────

function loadHistory(): HeartbeatRecord[] {
  const raw = ctx.store.getMemory(HISTORY_KEY, SCOPE);
  if (!raw) return [];
  return raw as HeartbeatRecord[];
}

function saveHistory(records: HeartbeatRecord[]): void {
  // Cap history length
  const trimmed = records.slice(-MAX_HISTORY);
  ctx.store.setMemory(HISTORY_KEY, trimmed, SCOPE);
}

function getTickCount(): number {
  const raw = ctx.store.getMemory(TICK_COUNT_KEY, SCOPE);
  return (raw as number) || 0;
}

function incrementTickCount(): number {
  const count = getTickCount() + 1;
  ctx.store.setMemory(TICK_COUNT_KEY, count, SCOPE);
  return count;
}

function parseTime(timeStr: string): { hours: number; minutes: number } | null {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return { hours: parseInt(match[1], 10), minutes: parseInt(match[2], 10) };
}

function isInQuietHours(): boolean {
  const { quietHoursStart, quietHoursEnd } = currentConfig;
  if (!quietHoursStart || !quietHoursEnd) return false;

  const start = parseTime(quietHoursStart);
  const end = parseTime(quietHoursEnd);
  if (!start || !end) return false;

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;

  if (startMinutes <= endMinutes) {
    // Same-day window (e.g., 09:00 - 17:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Overnight window (e.g., 22:00 - 08:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

function readConfig(): void {
  currentConfig = {
    enabled: ctx.config.get("enabled", true),
    intervalMs: ctx.config.get("intervalMs", 3_600_000),
    mission: ctx.config.get("mission", DEFAULT_MISSION),
    soulId: ctx.config.get("soulId", null as string | null),
    maxIterations: ctx.config.get("maxIterations", 5),
    skipIfBusy: ctx.config.get("skipIfBusy", true),
    quietHoursStart: ctx.config.get("quietHoursStart", null as string | null),
    quietHoursEnd: ctx.config.get("quietHoursEnd", null as string | null),
  };
}

function getRunTask(): RunTaskFn | null {
  return ctx.config.get("runTask", null as RunTaskFn | null);
}

function getIsRunning(): IsRunningFn | null {
  return ctx.config.get("isRunning", null as IsRunningFn | null);
}

// ── Core tick ─────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (ticking) return; // Guard against overlapping ticks
  ticking = true;

  try {
    readConfig();

    if (!currentConfig.enabled) {
      log.debug("Heartbeat tick skipped: disabled");
      return;
    }

    // Check quiet hours
    if (isInQuietHours()) {
      log.debug("Heartbeat tick skipped: quiet hours");
      await ctx.bus.emit("heartbeat:skip" as any, {
        reason: "quiet_hours",
        timestamp: new Date().toISOString(),
      });
      addHistoryRecord("", { input: 0, output: 0 }, true, "quiet_hours");
      return;
    }

    // Check if agent is busy
    const isRunning = getIsRunning();
    if (currentConfig.skipIfBusy && isRunning && isRunning()) {
      log.debug("Heartbeat tick skipped: agent is busy");
      await ctx.bus.emit("heartbeat:skip" as any, {
        reason: "agent_busy",
        timestamp: new Date().toISOString(),
      });
      addHistoryRecord("", { input: 0, output: 0 }, true, "agent_busy");
      return;
    }

    // Emit heartbeat:before (modifiable/abortable)
    const beforeResult = await ctx.bus.emit("heartbeat:before" as any, {
      mission: currentConfig.mission,
      soulId: currentConfig.soulId,
      maxIterations: currentConfig.maxIterations,
      timestamp: new Date().toISOString(),
    });

    if (beforeResult === null) {
      log.info("Heartbeat tick aborted by hook");
      addHistoryRecord("", { input: 0, output: 0 }, true, "aborted_by_hook");
      return;
    }

    // Use potentially modified mission from hooks
    const mission = (beforeResult as any).mission || currentConfig.mission;
    const maxIterations =
      (beforeResult as any).maxIterations || currentConfig.maxIterations;

    // Run the task
    const runTask = getRunTask();
    if (!runTask) {
      log.warn("Heartbeat tick skipped: no runTask callback configured");
      return;
    }

    log.info(`Heartbeat tick firing (mission: ${mission.slice(0, 80)}...)`);
    pendingReports = [];

    const result = await runTask({
      task: mission,
      maxIterations,
    });

    lastTickTime = Date.now();
    const count = incrementTickCount();
    ctx.store.setMemory(LAST_TICK_KEY, new Date().toISOString(), SCOPE);

    const summary =
      pendingReports.length > 0
        ? pendingReports.join("\n---\n")
        : result.response.slice(0, 500);

    addHistoryRecord(summary, result.tokenUsage, false);

    log.info(
      `Heartbeat #${count} completed: ${result.iterations} iterations, ` +
        `${result.tokenUsage.input + result.tokenUsage.output} tokens`
    );

    // Emit heartbeat:after
    await ctx.bus.emit("heartbeat:after" as any, {
      summary,
      tokenUsage: result.tokenUsage,
      iterations: result.iterations,
      tickCount: count,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    log.error("Heartbeat tick failed:", err);
    addHistoryRecord(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      { input: 0, output: 0 },
      true,
      "error"
    );
  } finally {
    ticking = false;
  }
}

function addHistoryRecord(
  summary: string,
  tokenUsage: { input: number; output: number },
  skipped: boolean,
  skipReason?: string
): void {
  const history = loadHistory();
  history.push({
    timestamp: new Date().toISOString(),
    summary,
    tokenUsage,
    skipped,
    skipReason,
  });
  saveHistory(history);
}

// ── Timer management ──────────────────────────────────────────

function startTimer(): void {
  stopTimer();
  if (!currentConfig.enabled) return;

  log.info(
    `Heartbeat timer started: interval=${currentConfig.intervalMs}ms ` +
      `(${(currentConfig.intervalMs / 60_000).toFixed(1)} min)`
  );

  timer = setInterval(() => {
    tick().catch((err) => log.error("Heartbeat tick error:", err));
  }, currentConfig.intervalMs);
}

function stopTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info("Heartbeat timer stopped");
  }
}

function restartTimer(): void {
  readConfig();
  startTimer();
}

// ── Plugin definition ─────────────────────────────────────────

const heartbeatPlugin: HarnessPlugin = {
  id: "harness-heartbeat",
  name: "Heartbeat",
  version: "0.1.0",

  async activate(pluginCtx: PluginContext) {
    ctx = pluginCtx;
    log = ctx.log;

    readConfig();

    const storedLastTick = ctx.store.getMemory(LAST_TICK_KEY, SCOPE) as
      | string
      | null;
    if (storedLastTick) {
      lastTickTime = new Date(storedLastTick).getTime();
    }

    const tickCount = getTickCount();
    log.info(
      `Heartbeat plugin activated (enabled=${currentConfig.enabled}, ` +
        `interval=${currentConfig.intervalMs}ms, ` +
        `history=${loadHistory().length} records, ` +
        `total ticks=${tickCount})`
    );

    startTimer();
  },

  async deactivate() {
    stopTimer();
    log?.info("Heartbeat plugin deactivated");
  },

  // ── Tools ────────────────────────────────────────────────

  tools: [
    {
      name: "heartbeat_report",
      description:
        "Write a structured report or finding during a heartbeat session. " +
        "Use this to persist important observations that should be surfaced " +
        "to the user. Each call adds one report entry.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "A short title for this report entry.",
          },
          body: {
            type: "string",
            description:
              "The report content. Keep it concise but informative.",
          },
          severity: {
            type: "string",
            description:
              'Severity level: "info", "warning", or "critical". Defaults to "info".',
          },
        },
        required: ["title", "body"],
      },
      timeout: 5_000,

      async execute(
        args: Record<string, unknown>,
        _toolCtx: ToolContext
      ): Promise<ToolResult> {
        const title = args.title as string;
        const body = args.body as string;
        const severity = (args.severity as string) || "info";

        const report = `[${severity.toUpperCase()}] ${title}\n${body}`;
        pendingReports.push(report);

        log?.info(`Heartbeat report: [${severity}] ${title}`);

        return {
          success: true,
          output: `Report recorded: "${title}" (${severity})`,
        };
      },
    },
  ],

  // ── Hooks ────────────────────────────────────────────────

  hooks: [],
};

// ── Exported control functions ────────────────────────────────
// These are used by the AgentManager / IPC handlers to control
// the heartbeat from the renderer.

export function getHeartbeatStatus(): HeartbeatStatus {
  const nextTick =
    currentConfig.enabled && lastTickTime
      ? new Date(lastTickTime + currentConfig.intervalMs).toISOString()
      : currentConfig.enabled
        ? new Date(Date.now() + currentConfig.intervalMs).toISOString()
        : null;

  return {
    enabled: currentConfig.enabled,
    intervalMs: currentConfig.intervalMs,
    mission: currentConfig.mission,
    tickCount: getTickCount(),
    lastTick: ctx
      ? (ctx.store.getMemory(LAST_TICK_KEY, SCOPE) as string | null)
      : null,
    nextTickEstimate: nextTick,
    isInQuietHours: isInQuietHours(),
  };
}

export function updateHeartbeatConfig(updates: HeartbeatConfig): void {
  if (updates.enabled !== undefined) ctx.config.set("enabled", updates.enabled);
  if (updates.intervalMs !== undefined)
    ctx.config.set("intervalMs", updates.intervalMs);
  if (updates.mission !== undefined) ctx.config.set("mission", updates.mission);
  if (updates.soulId !== undefined) ctx.config.set("soulId", updates.soulId);
  if (updates.maxIterations !== undefined)
    ctx.config.set("maxIterations", updates.maxIterations);
  if (updates.skipIfBusy !== undefined)
    ctx.config.set("skipIfBusy", updates.skipIfBusy);
  if (updates.quietHoursStart !== undefined)
    ctx.config.set("quietHoursStart", updates.quietHoursStart);
  if (updates.quietHoursEnd !== undefined)
    ctx.config.set("quietHoursEnd", updates.quietHoursEnd);

  restartTimer();
}

export function triggerHeartbeatNow(): Promise<void> {
  return tick();
}

export function getHeartbeatHistory(): HeartbeatRecord[] {
  return loadHistory();
}

export default heartbeatPlugin;
