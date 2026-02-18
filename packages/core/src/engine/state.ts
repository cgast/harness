/**
 * AgentState - In-memory state machine with Proxy-based change detection.
 * Emits state:change events through the EventBus.
 */

import type { Message } from "../providers/provider.js";
import type { EventBus } from "../events/bus.js";
import { v4 as uuid } from "uuid";

export interface AgentStateData {
  // Session
  sessionId: string;
  taskId: string;
  status: "idle" | "running" | "paused" | "done" | "error";
  iteration: number;

  // Conversation
  messages: Message[];

  // Current configuration (mutable during session)
  config: {
    model: string;
    provider: string;
    temperature: number;
    maxIterations: number;
    maxTokens: number;
  };

  // Active soul + skills
  activeSoul: string;
  activeSkills: string[];

  // Tool registry snapshot
  availableTools: string[];

  // Metadata
  startedAt: Date;
  tokenUsage: { input: number; output: number; cost?: number };

  // Arbitrary plugin state
  pluginData: Record<string, unknown>;
}

export function createDefaultState(): AgentStateData {
  return {
    sessionId: uuid(),
    taskId: "",
    status: "idle",
    iteration: 0,
    messages: [],
    config: {
      model: "gpt-4o",
      provider: "openai",
      temperature: 0.7,
      maxIterations: 25,
      maxTokens: 4096,
    },
    activeSoul: "default",
    activeSkills: [],
    availableTools: [],
    startedAt: new Date(),
    tokenUsage: { input: 0, output: 0 },
    pluginData: {},
  };
}

/**
 * Creates a reactive state object that emits state:change events
 * when properties are modified.
 */
export class AgentState {
  private data: AgentStateData;
  private bus?: EventBus;

  constructor(bus?: EventBus, initialState?: Partial<AgentStateData>) {
    this.data = { ...createDefaultState(), ...initialState };
    this.bus = bus;
  }

  /**
   * Get a value from state.
   */
  get<K extends keyof AgentStateData>(key: K): AgentStateData[K] {
    return this.data[key];
  }

  /**
   * Set a value in state, emitting a state:change event.
   */
  set<K extends keyof AgentStateData>(key: K, value: AgentStateData[K]): void {
    const oldValue = this.data[key];
    this.data[key] = value;
    this.bus?.emit("state:change", {
      path: key,
      oldValue,
      newValue: value,
    });
  }

  /**
   * Update multiple state values at once.
   */
  update(partial: Partial<AgentStateData>): void {
    for (const [key, value] of Object.entries(partial)) {
      this.set(key as keyof AgentStateData, value as any);
    }
  }

  /**
   * Get a snapshot of the full state (copy).
   */
  snapshot(): AgentStateData {
    return { ...this.data };
  }

  /**
   * Get the raw data (for serialization).
   */
  toJSON(): AgentStateData {
    return this.data;
  }

  /**
   * Add a message to the conversation history.
   */
  addMessage(message: Message): void {
    this.data.messages.push(message);
    this.bus?.emit("state:change", {
      path: "messages",
      oldValue: null,
      newValue: message,
    });
  }

  /**
   * Increment iteration counter.
   */
  nextIteration(): number {
    this.data.iteration += 1;
    return this.data.iteration;
  }

  /**
   * Add to token usage.
   */
  addTokenUsage(input: number, output: number): void {
    this.data.tokenUsage.input += input;
    this.data.tokenUsage.output += output;
  }

  /**
   * Reset state for a new task.
   */
  reset(taskId?: string): void {
    this.data.sessionId = uuid();
    this.data.taskId = taskId || "";
    this.data.status = "idle";
    this.data.iteration = 0;
    this.data.messages = [];
    this.data.startedAt = new Date();
    this.data.tokenUsage = { input: 0, output: 0 };
    this.data.pluginData = {};
  }
}
