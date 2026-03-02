# Heartbeat Plugin - Implementation Plan

## Overview

A **heartbeat plugin** that periodically triggers an agent session on a configurable timer while the Electron app is running. Each heartbeat session receives a special "mission" prompt (soul doc / custom instructions) — enabling autonomous periodic tasks like journaling, summarization, health checks, or proactive suggestions.

The plugin does **not** run in the background as a system service. It lives inside the Electron main process and only ticks while the desktop app is open.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│  Electron Main Process                       │
│                                              │
│  ┌────────────────────┐   ┌───────────────┐  │
│  │   AgentManager     │◄──│  Heartbeat    │  │
│  │   .runTask(opts)   │   │  Plugin       │  │
│  └────────────────────┘   │               │  │
│                           │  setInterval  │  │
│                           │  ───────────► │  │
│                           │  tick()       │  │
│                           └───────────────┘  │
│                                 ▲            │
│  ┌──────────────────────┐       │            │
│  │  IPC Handlers        │───────┘            │
│  │  heartbeat:config    │  (start/stop/      │
│  │  heartbeat:status    │   reconfigure)     │
│  │  heartbeat:trigger   │                    │
│  │  heartbeat:history   │                    │
│  └──────────────────────┘                    │
└──────────────────────────────────────────────┘
```

---

## Components to Create

### 1. Plugin: `plugins/heartbeat/src/index.ts`

**Implements `HarnessPlugin`** following the same pattern as memory/telemetry plugins.

#### Configuration (via `PluginConfig` / `~/.harness/config.yaml`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `intervalMs` | number | `3600000` (1h) | Time between heartbeats in ms |
| `enabled` | boolean | `true` | Whether the timer is active |
| `mission` | string | `"Provide a brief status summary..."` | The task prompt sent to the agent on each tick |
| `soulId` | string | `null` | Optional soul doc to use for heartbeat sessions (falls back to active soul) |
| `maxIterations` | number | `5` | Cap iterations for heartbeat sessions (keep them short) |
| `skipIfBusy` | boolean | `true` | Skip tick if agent is already running a task |
| `quietHoursStart` | string | `null` | Optional HH:MM to pause heartbeats (e.g. `"22:00"`) |
| `quietHoursEnd` | string | `null` | Optional HH:MM to resume heartbeats (e.g. `"08:00"`) |

#### Lifecycle

- **`activate(ctx)`**: Read config, start `setInterval` timer, store interval handle.
- **`deactivate()`**: `clearInterval`, clean up.
- **`tick()`**: Core function called on each interval:
  1. Check `skipIfBusy` — if agent is running, skip and log.
  2. Check quiet hours — if inside window, skip.
  3. Emit `heartbeat:before` event (modifiable — plugins can adjust or abort).
  4. Call `agentManager.runTask({ task: mission, maxIterations })`.
  5. Log result, store in heartbeat history.
  6. Emit `heartbeat:after` event with results.

#### Tools (exposed to the LLM during heartbeat sessions)

- **`heartbeat_report`**: Allows the heartbeat session's LLM to write a structured report/finding that gets persisted and surfaced in the UI.

#### Hooks

- **`agent:end`**: Tag completed sessions that were heartbeat-initiated (store metadata in persistence).

#### Persistent State

- Heartbeat history stored via `ctx.store` under scope `plugin:heartbeat`:
  - `lastTick`: ISO timestamp of last successful heartbeat
  - `history`: Array of `{ timestamp, sessionId, summary, tokenUsage }`
  - `tickCount`: Total number of heartbeats executed

### 2. Package scaffolding: `plugins/heartbeat/`

```
plugins/heartbeat/
├── package.json          # @harness/plugin-heartbeat
├── tsconfig.json         # extends ../../tsconfig.base.json
└── src/
    └── index.ts          # Plugin implementation
```

### 3. IPC Handlers (extend `ipc-handlers.ts`)

Add channels for renderer control:

| Channel | Direction | Description |
|---------|-----------|-------------|
| `harness:heartbeat-status` | renderer → main | Get current config + state (enabled, next tick, history) |
| `harness:heartbeat-config` | renderer → main | Update heartbeat config (interval, mission, enabled, etc.) |
| `harness:heartbeat-trigger` | renderer → main | Manually trigger a heartbeat now |
| `harness:heartbeat-history` | renderer → main | Fetch heartbeat session history |

### 4. Events (extend `events.ts`)

Add new event types:

```typescript
| "heartbeat:before"    // Emitted before a heartbeat tick runs (modifiable/abortable)
| "heartbeat:after"     // Emitted after a heartbeat tick completes
| "heartbeat:skip"      // Emitted when a tick is skipped (busy/quiet hours)
```

### 5. AgentManager additions

The heartbeat plugin needs the ability to programmatically run tasks. Two approaches:

**Option A (Recommended): Plugin receives a `runTask` callback in its config.**
- During plugin loading in the desktop app, pass `agentManager.runTask` as a config value.
- The plugin calls it directly. Clean, no new interfaces needed.

**Option B: Extend PluginContext with a `runTask` method.**
- Would require changing the core `PluginContext` interface.
- More principled but heavier change.

We go with **Option A** — the plugin reads a `runTask` function from its `PluginConfig`, which the desktop app provides at load time.

---

## Implementation Steps

### Step 1: Scaffold the plugin package
- Create `plugins/heartbeat/package.json`, `tsconfig.json`, `src/index.ts`
- Follow the exact same structure as `plugins/memory/`

### Step 2: Implement the core plugin (`src/index.ts`)
- Plugin config reading (interval, mission, soul, etc.)
- `setInterval` / `clearInterval` lifecycle management
- `tick()` function with busy-check, quiet-hours, and task execution
- Heartbeat history persistence via `ctx.store`
- `heartbeat_report` tool for the LLM
- Event hooks to tag heartbeat sessions

### Step 3: Add heartbeat events to `events.ts`
- Add `heartbeat:before`, `heartbeat:after`, `heartbeat:skip` to `EventName` union
- Add payload types to `EventPayloads`
- Add `heartbeat:before` to `MODIFIABLE_EVENTS`

### Step 4: Wire IPC handlers in the desktop app
- Add `harness:heartbeat-*` IPC channels to `ipc-handlers.ts`
- Pass `runTask` callback to the heartbeat plugin config during initialization

### Step 5: Update `AgentManager` to support heartbeat plugin wiring
- In `initialize()`, after creating the agent, configure the heartbeat plugin with a bound `runTask` reference
- Expose methods for heartbeat status/config/trigger/history

### Step 6: Add to pnpm workspace (if not auto-discovered)
- Ensure `plugins/heartbeat` is in the workspace config
- Add to default enabled plugins list in config schema

---

## Key Design Decisions

1. **Timer in main process, not renderer**: `setInterval` runs in Electron main — survives renderer reloads, doesn't need web workers.

2. **Skip-if-busy by default**: Heartbeats shouldn't queue up or interrupt active user sessions. The default `skipIfBusy: true` ensures the timer simply skips and tries again next interval.

3. **Quiet hours**: Simple time-of-day window check. No timezone complexity — uses local system time.

4. **Mission as config string**: The heartbeat prompt is a plain string in config. For more complex missions, users can point to a soul doc via `soulId`.

5. **Short sessions**: `maxIterations: 5` default keeps heartbeat sessions fast and cheap. The LLM gets in, does its job, and gets out.

6. **History cap**: Keep last 100 heartbeat records to avoid unbounded growth.

7. **No background daemon**: The plugin only runs inside the Electron process. When the app closes, the timer is cleaned up via `deactivate()`. No system services, no cron, no separate process.
