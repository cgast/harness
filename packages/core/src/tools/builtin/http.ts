/**
 * Built-in HTTP tool - fetch URLs.
 */

import type { ToolDefinition } from "../registry.js";

export const httpFetchTool: ToolDefinition = {
  name: "http_fetch",
  description:
    "Fetch content from a URL via HTTP GET. Returns the response body as text.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch",
      },
      method: {
        type: "string",
        description: "HTTP method (GET, POST, PUT, DELETE). Defaults to GET.",
      },
      headers: {
        type: "object",
        description: "Optional HTTP headers as key-value pairs",
      },
      body: {
        type: "string",
        description: "Request body (for POST/PUT)",
      },
    },
    required: ["url"],
  },

  async execute(args) {
    const url = args.url as string;
    const method = (args.method as string) || "GET";
    const headers = (args.headers as Record<string, string>) || {};
    const body = args.body as string | undefined;

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body || undefined,
        signal: AbortSignal.timeout(25_000), // 25s timeout
      });

      const text = await response.text();
      const truncated =
        text.length > 50_000 ? text.slice(0, 50_000) + "\n...(truncated)" : text;

      return {
        success: response.ok,
        output: `HTTP ${response.status} ${response.statusText}\n\n${truncated}`,
      };
    } catch (err: any) {
      return {
        success: false,
        output: `HTTP fetch failed: ${err.message}`,
      };
    }
  },
};
