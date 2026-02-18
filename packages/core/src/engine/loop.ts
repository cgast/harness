/**
 * The Agentic Loop - the heart of Harness.
 *
 * Flow: assemble prompt -> call LLM -> parse response -> execute tools -> update state -> repeat
 *
 * Termination conditions (checked in order):
 * 1. LLM response contains no tool calls (final answer)
 * 2. maxIterations reached
 * 3. Plugin hook returns { abort: true }
 * 4. User sends interrupt signal
 */

import type { LLMProvider, ChatChunk, Message, ToolCallMessage } from "../providers/provider.js";
import type { EventBus } from "../events/bus.js";
import type { ToolRegistry, ToolContext } from "../tools/registry.js";
import type { SoulDocument } from "../soul/loader.js";
import type { SkillDocument } from "../skills/loader.js";
import type { AgentState } from "./state.js";
import { assemblePrompt } from "./prompt-assembler.js";

export interface LoopConfig {
  provider: LLMProvider;
  bus: EventBus;
  toolRegistry: ToolRegistry;
  state: AgentState;
  soul: SoulDocument | null;
  activeSkills: SkillDocument[];
  workdir: string;
  onText?: (text: string) => void;
}

export interface LoopResult {
  success: boolean;
  response: string;
  iterations: number;
  tokenUsage: { input: number; output: number };
  aborted: boolean;
}

/**
 * Run the agentic loop for a given task.
 */
export async function runLoop(
  task: string,
  config: LoopConfig
): Promise<LoopResult> {
  const {
    provider,
    bus,
    toolRegistry,
    state,
    soul,
    activeSkills,
    workdir,
    onText,
  } = config;

  const maxIterations = state.get("config").maxIterations;
  const model = state.get("config").model;
  const temperature = state.get("config").temperature;
  const maxTokens = state.get("config").maxTokens;

  // Set initial state
  state.set("status", "running");
  state.addMessage({ role: "user", content: task });

  // Emit agent:start
  const startData = await bus.emit("agent:start", {
    task,
    soul: soul?.id || "none",
    skills: activeSkills.map((s) => s.id),
    config: { model, temperature, maxIterations },
  });

  if (!startData) {
    return {
      success: false,
      response: "Agent start was aborted by a plugin.",
      iterations: 0,
      tokenUsage: { input: 0, output: 0 },
      aborted: true,
    };
  }

  let lastTextResponse = "";
  let aborted = false;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    state.nextIteration();

    // Emit loop:iteration_start
    const iterData = await bus.emit("loop:iteration_start", {
      iteration,
      state: state.snapshot() as unknown as Record<string, unknown>,
    });
    if (!iterData) {
      aborted = true;
      break;
    }

    // Assemble prompt
    const assembled = await assemblePrompt(
      soul,
      activeSkills,
      state.get("messages"),
      toolRegistry,
      bus
    );
    if (!assembled) {
      aborted = true;
      break;
    }

    // Emit llm:request
    const reqData = await bus.emit("llm:request", {
      provider: provider.id,
      model,
      messages: assembled.messages,
    });
    if (!reqData) {
      aborted = true;
      break;
    }

    // Call LLM
    let responseText = "";
    const toolCalls: ToolCallMessage[] = [];
    let usage = { inputTokens: 0, outputTokens: 0 };

    try {
      const stream = provider.chat({
        messages: assembled.messages,
        tools: assembled.tools.length > 0 ? assembled.tools : undefined,
        model,
        temperature,
        maxTokens,
      });

      for await (const chunk of stream) {
        // Emit each chunk
        bus.emit("llm:chunk", { chunk });

        switch (chunk.type) {
          case "text":
            if (chunk.content) {
              responseText += chunk.content;
              onText?.(chunk.content);
            }
            if (chunk.usage) {
              usage = chunk.usage;
            }
            break;

          case "tool_call":
            if (chunk.toolCall) {
              toolCalls.push(chunk.toolCall);
            }
            break;

          case "done":
            if (chunk.usage) {
              usage = chunk.usage;
            }
            break;

          case "error":
            const errData = await bus.emit("llm:error", {
              error: new Error(chunk.error || "Unknown LLM error"),
              retryCount: 0,
            });
            if (!errData || errData.retry === false) {
              state.set("status", "error");
              await bus.emit("agent:error", {
                error: new Error(chunk.error || "Unknown LLM error"),
                iteration,
              });
              return {
                success: false,
                response: chunk.error || "LLM error",
                iterations: iteration,
                tokenUsage: state.get("tokenUsage"),
                aborted: false,
              };
            }
            break;
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      await bus.emit("llm:error", { error, retryCount: 0 });
      state.set("status", "error");
      await bus.emit("agent:error", { error, iteration });
      return {
        success: false,
        response: `LLM call failed: ${error.message}`,
        iterations: iteration,
        tokenUsage: state.get("tokenUsage"),
        aborted: false,
      };
    }

    // Update token usage
    state.addTokenUsage(usage.inputTokens, usage.outputTokens);

    // Emit llm:response
    const responseMessage: Message = {
      role: "assistant",
      content: responseText,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    await bus.emit("llm:response", {
      response: responseMessage,
      usage,
    });

    // Add assistant message to state
    state.addMessage(responseMessage);
    lastTextResponse = responseText;

    // If no tool calls, we're done (final answer)
    if (toolCalls.length === 0) {
      break;
    }

    // Execute tool calls
    const toolCtx: ToolContext = {
      workdir,
      state,
      emit: (event, data) => bus.emit(event as any, data as any),
    };

    for (const tc of toolCalls) {
      const tool = toolRegistry.get(tc.name);
      if (!tool) {
        // Tool not found - add error result
        state.addMessage({
          role: "tool",
          content: `Error: Tool '${tc.name}' not found.`,
          toolCallId: tc.id,
          name: tc.name,
        });
        continue;
      }

      // Emit tool:request (can be aborted)
      const toolReqData = await bus.emit("tool:request", {
        name: tc.name,
        args: tc.args,
      });
      if (!toolReqData) {
        state.addMessage({
          role: "tool",
          content: `Tool call '${tc.name}' was blocked by a plugin.`,
          toolCallId: tc.id,
          name: tc.name,
        });
        continue;
      }

      // Emit tool:start
      await bus.emit("tool:start", { name: tc.name, args: tc.args });

      const startTime = Date.now();
      try {
        // Execute with timeout
        const result = await withTimeout(
          tool.execute(toolReqData.args, toolCtx),
          tool.timeout ?? 30_000,
          tc.name
        );

        const duration = Date.now() - startTime;

        // Emit tool:result (modifiable)
        const resultData = await bus.emit("tool:result", {
          name: tc.name,
          result,
          duration,
        });

        const finalResult = resultData?.result ?? result;

        state.addMessage({
          role: "tool",
          content: finalResult.output,
          toolCallId: tc.id,
          name: tc.name,
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const duration = Date.now() - startTime;

        await bus.emit("tool:error", { name: tc.name, error });

        state.addMessage({
          role: "tool",
          content: `Tool '${tc.name}' failed: ${error.message}`,
          toolCallId: tc.id,
          name: tc.name,
        });
      }
    }

    // Update available tools list in state
    state.set("availableTools", toolRegistry.names());

    // Emit loop:iteration_end
    await bus.emit("loop:iteration_end", {
      iteration,
      state: state.snapshot() as unknown as Record<string, unknown>,
    });
  }

  // Task complete
  state.set("status", aborted ? "error" : "done");

  const finalUsage = state.get("tokenUsage");

  await bus.emit("agent:end", {
    task,
    result: lastTextResponse,
    tokenUsage: finalUsage,
  });

  return {
    success: !aborted,
    response: lastTextResponse,
    iterations: state.get("iteration"),
    tokenUsage: finalUsage,
    aborted,
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  name: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Tool '${name}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
