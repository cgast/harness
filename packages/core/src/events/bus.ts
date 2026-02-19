/**
 * EventBus - The central integration point for Harness.
 * Supports typed events, priority ordering, and modifiable payloads.
 */

import type { EventName, EventPayloads } from "./events.js";
import { MODIFIABLE_EVENTS } from "./events.js";

export interface HookRegistration<E extends EventName = EventName> {
  event: E;
  handler: (data: EventPayloads[E]) => Promise<void | EventPayloads[E] | { abort: true }>;
  priority?: number; // Lower = earlier, default 100
}

/** A union of HookRegistration for every concrete event name, so heterogeneous hook arrays type-check. */
export type AnyHookRegistration = { [E in EventName]: HookRegistration<E> }[EventName];

interface RegisteredHook {
  event: EventName;
  handler: (data: any) => Promise<void | any>;
  priority: number;
}

export class EventBus {
  private hooks: Map<EventName, RegisteredHook[]> = new Map();
  private globalListeners: Array<(event: EventName, data: any) => void> = [];

  /**
   * Register a hook for an event.
   */
  on<E extends EventName>(
    event: E,
    handler: (data: EventPayloads[E]) => Promise<void | EventPayloads[E] | { abort: true }>,
    priority: number = 100
  ): () => void {
    const hook: RegisteredHook = { event, handler, priority };

    if (!this.hooks.has(event)) {
      this.hooks.set(event, []);
    }

    const hooks = this.hooks.get(event)!;
    hooks.push(hook);
    // Sort by priority (lower first)
    hooks.sort((a, b) => a.priority - b.priority);

    // Return unsubscribe function
    return () => {
      const idx = hooks.indexOf(hook);
      if (idx !== -1) hooks.splice(idx, 1);
    };
  }

  /**
   * Register a global listener that receives all events.
   * Cannot modify event data.
   */
  onAll(listener: (event: EventName, data: any) => void): () => void {
    this.globalListeners.push(listener);
    return () => {
      const idx = this.globalListeners.indexOf(listener);
      if (idx !== -1) this.globalListeners.splice(idx, 1);
    };
  }

  /**
   * Emit an event. For modifiable events, hooks can transform the payload
   * or abort the action by returning { abort: true }.
   *
   * Returns the (possibly modified) payload, or null if aborted.
   */
  async emit<E extends EventName>(
    event: E,
    data: EventPayloads[E]
  ): Promise<EventPayloads[E] | null> {
    const hooks = this.hooks.get(event) || [];
    const isModifiable = MODIFIABLE_EVENTS.has(event);

    let currentData = { ...data };

    for (const hook of hooks) {
      try {
        const result = await hook.handler(currentData);

        if (result != null && typeof result === "object") {
          if ("abort" in result && (result as any).abort === true) {
            // Action aborted by hook
            return null;
          }
          if (isModifiable) {
            currentData = result as EventPayloads[E];
          }
        }
      } catch (err) {
        // Hook errors don't crash the bus - log and continue
        console.error(`[EventBus] Error in hook for ${event}:`, err);
      }
    }

    // Notify global listeners (fire-and-forget)
    for (const listener of this.globalListeners) {
      try {
        listener(event, currentData);
      } catch (err) {
        console.error(`[EventBus] Error in global listener for ${event}:`, err);
      }
    }

    return currentData;
  }

  /**
   * Remove all hooks for a specific event, or all hooks entirely.
   */
  removeAll(event?: EventName): void {
    if (event) {
      this.hooks.delete(event);
    } else {
      this.hooks.clear();
      this.globalListeners = [];
    }
  }

  /**
   * Get the number of registered hooks for an event.
   */
  listenerCount(event: EventName): number {
    return this.hooks.get(event)?.length || 0;
  }
}
