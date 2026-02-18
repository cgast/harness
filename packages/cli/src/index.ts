#!/usr/bin/env node

/**
 * Harness CLI - Run an agent from the command line.
 *
 * Usage:
 *   harness "your task here"
 *   harness --provider anthropic "your task"
 *   harness --model gpt-4o-mini "your task"
 */

import { createAgent, loadConfig } from "@harness/core";
import type { EventName } from "@harness/core";

async function main() {
  // Load .env file if present
  try {
    const dotenv = require("dotenv");
    dotenv.config();
  } catch {
    // dotenv not available, that's fine
  }

  // Parse arguments
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Harness - Universal LLM Agent Runtime

Usage:
  harness "your task here"
  harness --provider anthropic "analyze this code"
  harness --model gpt-4o-mini "quick question"

Options:
  --provider <name>    LLM provider (openai, anthropic, ollama)
  --model <name>       Model to use
  --temperature <n>    Temperature (0.0-2.0)
  --max-iterations <n> Max agent loop iterations
  --workdir <path>     Working directory for tools
  --config <path>      Path to config.yaml
  --verbose            Show event stream
  --help, -h           Show this help
`);
    process.exit(0);
  }

  // Parse flags
  let provider: string | undefined;
  let model: string | undefined;
  let temperature: number | undefined;
  let maxIterations: number | undefined;
  let workdir: string | undefined;
  let configPath: string | undefined;
  let verbose = false;
  const taskParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--provider":
        provider = args[++i];
        break;
      case "--model":
        model = args[++i];
        break;
      case "--temperature":
        temperature = parseFloat(args[++i]);
        break;
      case "--max-iterations":
        maxIterations = parseInt(args[++i], 10);
        break;
      case "--workdir":
        workdir = args[++i];
        break;
      case "--config":
        configPath = args[++i];
        break;
      case "--verbose":
        verbose = true;
        break;
      default:
        taskParts.push(args[i]);
    }
  }

  const task = taskParts.join(" ");

  if (!task) {
    console.error("Error: No task provided. Run 'harness --help' for usage.");
    process.exit(1);
  }

  // Load config
  const config = loadConfig(configPath);

  // Apply CLI overrides
  if (provider) {
    config.defaults = config.defaults || {};
    config.defaults.provider = provider;
  }
  if (temperature !== undefined) {
    config.defaults = config.defaults || {};
    config.defaults.temperature = temperature;
  }
  if (maxIterations !== undefined) {
    config.defaults = config.defaults || {};
    config.defaults.maxIterations = maxIterations;
  }
  if (workdir) {
    config.workdir = workdir;
  }

  // Create agent
  const agent = await createAgent(config);

  // Override model if specified
  if (model) {
    agent.state.set("config", {
      ...agent.state.get("config"),
      model,
    });
  }

  // Verbose event logging
  if (verbose) {
    agent.bus.onAll((event: EventName, data: unknown) => {
      const safeData = JSON.stringify(data, (_, v) =>
        v instanceof Error ? v.message : v
      );
      const truncated =
        safeData && safeData.length > 200
          ? safeData.slice(0, 200) + "..."
          : safeData;
      console.error(`[event] ${event} ${truncated}`);
    });
  } else {
    // Minimal event logging
    agent.bus.on("tool:start", async (data) => {
      console.error(`\n[tool] ${data.name}(${JSON.stringify(data.args)})`);
    });
    agent.bus.on("tool:result", async (data) => {
      const preview =
        data.result.output.length > 200
          ? data.result.output.slice(0, 200) + "..."
          : data.result.output;
      console.error(
        `[tool] ${data.name} -> ${data.result.success ? "ok" : "fail"} (${data.duration}ms)`
      );
      if (data.result.output) {
        console.error(`  ${preview}`);
      }
    });
    agent.bus.on("llm:error", async (data) => {
      console.error(`[error] LLM: ${data.error.message}`);
    });
  }

  // Run the task
  console.error(`\n[harness] Running task: ${task}`);
  console.error(`[harness] Provider: ${agent.state.get("config").provider}`);
  console.error(`[harness] Model: ${agent.state.get("config").model}`);
  console.error("---\n");

  const result = await agent.run(task);

  console.error("\n---");
  console.error(
    `[harness] Done. Iterations: ${result.iterations}, Tokens: ${result.tokenUsage.input}in/${result.tokenUsage.output}out`
  );

  if (!result.success) {
    console.error(`[harness] Task failed${result.aborted ? " (aborted)" : ""}`);
    process.exit(1);
  }

  // Clean up
  agent.store.close();
}

main().catch((err) => {
  console.error(`[harness] Fatal error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
