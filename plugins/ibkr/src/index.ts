/**
 * Harness IBKR Plugin
 *
 * Connects to the Interactive Brokers Client Portal Gateway REST API and
 * exposes 17 read-only tools to the LLM agent, grouped into four areas:
 *
 *   - Session   — auth status, keep-alive, re-authentication
 *   - Accounts  — list accounts, summary, ledger, P&L
 *   - Portfolio  — positions, allocation, trades, orders
 *   - Market data — contract search, snapshots, history, scanners
 *
 * The plugin also injects a prompt:assemble hook that teaches the LLM how
 * to sequence the tools (e.g. call ibkr_accounts before ibkr_positions).
 *
 * Prerequisites:
 *   1. An IBKR Pro account
 *   2. The Client Portal Gateway running locally (default https://localhost:5000)
 *   3. An authenticated gateway session (browser login)
 *
 * Configuration (in ~/.harness/config.yaml):
 *
 *   plugins:
 *     ibkr:
 *       baseUrl: "https://localhost:5000"
 *       rejectUnauthorized: false
 *       timeout: 15000
 *       autoTickle: true
 *       tickleIntervalMs: 240000
 *
 * @see client.ts  — IBKRClient HTTP wrapper with typed responses
 * @see README.md  — full setup guide, tool reference, and rate limits
 */

import type {
  HarnessPlugin,
  PluginContext,
  Logger,
  ToolDefinition,
  ToolContext,
  ToolResult,
  EventPayloads,
} from "@harness/core";

import { IBKRClient, IBKRApiError } from "./client.js";

// ── Module-level state ──────────────────────────────────────────────

let log: Logger;
let ctx: PluginContext;
let client: IBKRClient;

// Keep-alive interval handle
let tickleInterval: ReturnType<typeof setInterval> | undefined;

// ── Helpers ─────────────────────────────────────────────────────────

function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function handleError(err: unknown): ToolResult {
  if (err instanceof IBKRApiError) {
    if (err.statusCode === 401) {
      return {
        success: false,
        output:
          "Authentication required. Please ensure the IBKR Client Portal Gateway is running and you are logged in. " +
          "Use the ibkr_auth_status tool to check your session.",
      };
    }
    if (err.statusCode === 429) {
      return {
        success: false,
        output: "Rate limit exceeded. IBKR enforces a 10 req/s global limit. Please wait and retry.",
      };
    }
    return {
      success: false,
      output: `IBKR API error (HTTP ${err.statusCode}): ${err.body}`,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("ECONNREFUSED")) {
    return {
      success: false,
      output:
        "Cannot connect to the IBKR Client Portal Gateway. " +
        "Please ensure it is running (default: https://localhost:5000). " +
        "You can configure the gateway URL in the plugin config under 'ibkr.baseUrl'.",
    };
  }
  return { success: false, output: `Error: ${msg}` };
}

// ── Market Data Field Reference ─────────────────────────────────────
// Common snapshot field IDs for quick reference in descriptions:
//   31 = Last Price, 84 = Bid, 86 = Ask, 7295 = Open, 7296 = Close
//   70 = High, 71 = Low, 82 = Change, 83 = Change %, 87 = Volume
//   7219 = Contract ID, 7051 = Company Name, 7094 = Conid Exchange

// ── Tool Definitions ────────────────────────────────────────────────

const sessionTools: ToolDefinition[] = [
  {
    name: "ibkr_auth_status",
    description:
      "Check the current authentication status of the IBKR Client Portal Gateway session. " +
      "Returns whether the session is authenticated, connected, and if there are competing sessions.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    timeout: 10_000,
    async execute(): Promise<ToolResult> {
      try {
        const status = await client.authStatus();
        const lines = [
          `Authenticated: ${status.authenticated}`,
          `Connected: ${status.connected}`,
          `Competing: ${status.competing}`,
          status.message ? `Message: ${status.message}` : null,
          status.serverInfo
            ? `Server: ${status.serverInfo.serverName} (${status.serverInfo.serverVersion})`
            : null,
        ].filter(Boolean);
        return { success: true, output: lines.join("\n") };
      } catch (err) {
        return handleError(err);
      }
    },
  },
  {
    name: "ibkr_tickle",
    description:
      "Send a keep-alive ping to the IBKR Client Portal Gateway to prevent session timeout. " +
      "Sessions time out after ~6 minutes of inactivity.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    timeout: 10_000,
    async execute(): Promise<ToolResult> {
      try {
        await client.tickle();
        return { success: true, output: "Session keep-alive sent successfully." };
      } catch (err) {
        return handleError(err);
      }
    },
  },
  {
    name: "ibkr_reauthenticate",
    description:
      "Re-authenticate the brokerage session with the IBKR Client Portal Gateway. " +
      "Use this if the brokerage session has become disconnected while the portal session is still active.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    timeout: 15_000,
    async execute(): Promise<ToolResult> {
      try {
        const result = await client.reauthenticate();
        return { success: true, output: `Re-authentication initiated.\n${formatJson(result)}` };
      } catch (err) {
        return handleError(err);
      }
    },
  },
];

const accountTools: ToolDefinition[] = [
  {
    name: "ibkr_accounts",
    description:
      "List all IBKR portfolio accounts accessible to the current user. " +
      "This must be called before using other portfolio endpoints. " +
      "Returns account IDs, types, currencies, and status information.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    timeout: 15_000,
    async execute(): Promise<ToolResult> {
      try {
        const accounts = await client.getAccounts();
        if (!Array.isArray(accounts) || accounts.length === 0) {
          return { success: true, output: "No accounts found." };
        }
        const lines = accounts.map(
          (a) =>
            `• ${a.id || a.accountId} — ${a.accountTitle || a.displayName || "Untitled"} ` +
            `(${a.type || "N/A"}, ${a.currency || "N/A"})`,
        );
        return {
          success: true,
          output: `Found ${accounts.length} account(s):\n${lines.join("\n")}\n\nFull details:\n${formatJson(accounts)}`,
        };
      } catch (err) {
        return handleError(err);
      }
    },
  },
  {
    name: "ibkr_account_summary",
    description:
      "Get a summary for an IBKR account, including margin, cash balances, net liquidation value, " +
      "buying power, and other financial metrics. Call ibkr_accounts first to get the account ID.",
    parameters: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description: "The IBKR account ID (e.g., 'U1234567').",
        },
      },
      required: ["accountId"],
    },
    timeout: 15_000,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const accountId = args.accountId as string;
        const summary = await client.getAccountSummary(accountId);
        return { success: true, output: formatJson(summary) };
      } catch (err) {
        return handleError(err);
      }
    },
  },
  {
    name: "ibkr_account_ledger",
    description:
      "Get cash balance details by currency (ledger) for an IBKR account. " +
      "Shows settled cash, accrued interest, dividends, stock value, and net liquidation by currency.",
    parameters: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description: "The IBKR account ID (e.g., 'U1234567').",
        },
      },
      required: ["accountId"],
    },
    timeout: 15_000,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const accountId = args.accountId as string;
        const ledger = await client.getAccountLedger(accountId);
        return { success: true, output: formatJson(ledger) };
      } catch (err) {
        return handleError(err);
      }
    },
  },
  {
    name: "ibkr_account_pnl",
    description:
      "Get profit and loss (P&L) information partitioned by account and model. " +
      "Shows daily P&L, unrealized P&L, and realized P&L. Requires an active brokerage session.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    timeout: 15_000,
    async execute(): Promise<ToolResult> {
      try {
        const pnl = await client.getAccountPnL();
        return { success: true, output: formatJson(pnl) };
      } catch (err) {
        return handleError(err);
      }
    },
  },
];

const portfolioTools: ToolDefinition[] = [
  {
    name: "ibkr_positions",
    description:
      "Get all open positions for an IBKR account. Returns contract details, quantities, market values, " +
      "average cost, and unrealized/realized P&L for each position. Results are paginated.",
    parameters: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description: "The IBKR account ID (e.g., 'U1234567').",
        },
        pageId: {
          type: "number",
          description: "Page number for pagination, starting at 0 (default: 0).",
        },
      },
      required: ["accountId"],
    },
    timeout: 15_000,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const accountId = args.accountId as string;
        const pageId = (args.pageId as number) ?? 0;
        const positions = await client.getPositions(accountId, pageId);
        if (!Array.isArray(positions) || positions.length === 0) {
          return {
            success: true,
            output:
              pageId > 0
                ? "No more positions on this page."
                : "No open positions found for this account.",
          };
        }
        const summary = positions.map(
          (p) =>
            `• ${p.ticker || p.contractDesc} — ${p.position} shares @ $${p.avgPrice?.toFixed(2) ?? "N/A"} | ` +
            `Mkt: $${p.mktValue?.toFixed(2) ?? "N/A"} | ` +
            `Unrealized P&L: $${p.unrealizedPnl?.toFixed(2) ?? "N/A"}`,
        );
        return {
          success: true,
          output: `Positions (page ${pageId}, ${positions.length} items):\n${summary.join("\n")}\n\nFull details:\n${formatJson(positions)}`,
        };
      } catch (err) {
        return handleError(err);
      }
    },
  },
  {
    name: "ibkr_portfolio_allocation",
    description:
      "Get portfolio allocation breakdown for an IBKR account. " +
      "Shows allocation by asset class (stocks, bonds, options, etc.), sector, and group.",
    parameters: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description: "The IBKR account ID (e.g., 'U1234567').",
        },
      },
      required: ["accountId"],
    },
    timeout: 15_000,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const accountId = args.accountId as string;
        const allocation = await client.getPortfolioAllocation(accountId);
        return { success: true, output: formatJson(allocation) };
      } catch (err) {
        return handleError(err);
      }
    },
  },
  {
    name: "ibkr_trades",
    description:
      "Get recent trades/executions for the current session. " +
      "Requires an active brokerage session.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    timeout: 15_000,
    async execute(): Promise<ToolResult> {
      try {
        const trades = await client.getTrades();
        if (!Array.isArray(trades) || trades.length === 0) {
          return { success: true, output: "No recent trades found." };
        }
        return {
          success: true,
          output: `Found ${trades.length} recent trade(s):\n${formatJson(trades)}`,
        };
      } catch (err) {
        return handleError(err);
      }
    },
  },
  {
    name: "ibkr_orders",
    description:
      "Get current live/working orders. " +
      "Requires an active brokerage session.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    timeout: 15_000,
    async execute(): Promise<ToolResult> {
      try {
        const orders = await client.getOrders();
        return { success: true, output: formatJson(orders) };
      } catch (err) {
        return handleError(err);
      }
    },
  },
];

const marketDataTools: ToolDefinition[] = [
  {
    name: "ibkr_contract_search",
    description:
      "Search for a financial instrument/contract by symbol or company name. " +
      "Returns matching contracts with their conid (contract ID), symbol, company name, " +
      "and available security types (stocks, options, futures, etc.).",
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "The ticker symbol or company name to search for (e.g., 'AAPL', 'Apple').",
        },
      },
      required: ["symbol"],
    },
    timeout: 15_000,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const symbol = args.symbol as string;
        const results = await client.searchContract(symbol);
        if (!Array.isArray(results) || results.length === 0) {
          return { success: true, output: `No contracts found matching "${symbol}".` };
        }
        const lines = results.map(
          (r) =>
            `• ${r.symbol} (conid: ${r.conid}) — ${r.companyName || r.description || ""} ` +
            `[${r.sections?.map((s) => s.secType).join(", ") || "N/A"}]`,
        );
        return {
          success: true,
          output: `Found ${results.length} result(s) for "${symbol}":\n${lines.join("\n")}\n\nFull details:\n${formatJson(results)}`,
        };
      } catch (err) {
        return handleError(err);
      }
    },
  },
  {
    name: "ibkr_contract_details",
    description:
      "Get detailed information about a specific contract by its conid (contract ID). " +
      "Returns full contract specifications including exchange, currency, industry, category, etc. " +
      "Use ibkr_contract_search first to find the conid.",
    parameters: {
      type: "object",
      properties: {
        conid: {
          type: "number",
          description: "The IBKR contract ID (e.g., 265598 for AAPL).",
        },
      },
      required: ["conid"],
    },
    timeout: 15_000,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const conid = args.conid as number;
        const details = await client.getContractDetails(conid);
        return { success: true, output: formatJson(details) };
      } catch (err) {
        return handleError(err);
      }
    },
  },
  {
    name: "ibkr_market_snapshot",
    description:
      "Get a real-time market data snapshot for one or more contracts. Returns price data including " +
      "last price, bid, ask, open, close, high, low, volume, and change. Requires a brokerage session. " +
      "Common field IDs: 31=Last, 84=Bid, 86=Ask, 7295=Open, 7296=Close, 70=High, 71=Low, " +
      "82=Change, 83=Change%, 87=Volume, 7051=CompanyName. " +
      "NOTE: The first call may return partial data; call again for complete results.",
    parameters: {
      type: "object",
      properties: {
        conids: {
          type: "string",
          description:
            "Comma-separated contract IDs (e.g., '265598' for AAPL or '265598,8314' for AAPL and IBM).",
        },
        fields: {
          type: "string",
          description:
            "Comma-separated field IDs to retrieve (e.g., '31,84,86,87'). " +
            "If omitted, returns a default set of fields.",
        },
      },
      required: ["conids"],
    },
    timeout: 15_000,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const conids = args.conids as string;
        const fields = args.fields as string | undefined;
        const snapshots = await client.getMarketDataSnapshot(conids, fields);
        return { success: true, output: formatJson(snapshots) };
      } catch (err) {
        return handleError(err);
      }
    },
  },
  {
    name: "ibkr_market_history",
    description:
      "Get historical market data (OHLCV bars) for a contract. Requires a brokerage session. " +
      "Useful for charting and technical analysis.",
    parameters: {
      type: "object",
      properties: {
        conid: {
          type: "number",
          description: "The IBKR contract ID.",
        },
        period: {
          type: "string",
          description:
            "Time period to fetch (e.g., '1d', '1w', '1m', '3m', '6m', '1y', '5y').",
        },
        bar: {
          type: "string",
          description:
            "Bar size/interval (e.g., '1min', '5min', '15min', '1h', '4h', '1d', '1w', '1m').",
        },
        outsideRth: {
          type: "boolean",
          description: "Include data outside regular trading hours (default: false).",
        },
      },
      required: ["conid", "period", "bar"],
    },
    timeout: 20_000,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const conid = args.conid as number;
        const period = args.period as string;
        const bar = args.bar as string;
        const outsideRth = args.outsideRth as boolean | undefined;
        const history = await client.getMarketDataHistory(conid, period, bar, outsideRth);
        return { success: true, output: formatJson(history) };
      } catch (err) {
        return handleError(err);
      }
    },
  },
  {
    name: "ibkr_scanner_params",
    description:
      "Retrieve all available market scanner parameters from IBKR. Returns lists of scanner types " +
      "(e.g., top gainers, most active), instruments (stocks, futures, etc.), filter criteria, " +
      "and location/exchange options. Use this to discover what scanners are available before running one. " +
      "Note: Rate limited to 1 request per 15 minutes.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    timeout: 30_000,
    async execute(): Promise<ToolResult> {
      try {
        const params = await client.getScannerParams();
        const summary = [];
        if (params.scan_type_list) {
          summary.push(
            `Scanner types (${params.scan_type_list.length}): ` +
              params.scan_type_list.slice(0, 20).map((s) => s.display_name).join(", ") +
              (params.scan_type_list.length > 20 ? "..." : ""),
          );
        }
        if (params.instrument_list) {
          summary.push(
            `Instruments (${params.instrument_list.length}): ` +
              params.instrument_list.map((i) => i.display_name).join(", "),
          );
        }
        return {
          success: true,
          output: `${summary.join("\n\n")}\n\nFull details:\n${formatJson(params)}`,
        };
      } catch (err) {
        return handleError(err);
      }
    },
  },
  {
    name: "ibkr_scanner_run",
    description:
      "Run a market scanner to find instruments matching specific criteria. " +
      "For example: top gainers, most active, hot contracts by volume, highest option implied volatility, etc. " +
      "Use ibkr_scanner_params first to discover available scanner types, instruments, and filters. " +
      "Rate limited to 1 request per second.",
    parameters: {
      type: "object",
      properties: {
        instrument: {
          type: "string",
          description: "Instrument type (e.g., 'STK', 'FUT.US').",
        },
        type: {
          type: "string",
          description: "Scanner type (e.g., 'TOP_PERC_GAIN', 'MOST_ACTIVE', 'HIGH_OPT_IMP_VOLAT').",
        },
        locations: {
          type: "string",
          description: "Market location (e.g., 'STK.US.MAJOR', 'STK.US', 'STK.EU').",
        },
        filter: {
          type: "string",
          description:
            'Optional JSON array of filter objects, e.g., \'[{"code":"priceAbove","value":10}]\'. ' +
            "Use ibkr_scanner_params to see available filter codes.",
        },
      },
      required: ["instrument", "type", "locations"],
    },
    timeout: 30_000,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const instrument = args.instrument as string;
        const type = args.type as string;
        const locations = args.locations as string;
        let filter: Array<{ code: string; value: unknown }> | undefined;
        if (args.filter) {
          try {
            filter = JSON.parse(args.filter as string);
          } catch {
            return {
              success: false,
              output: "Invalid filter JSON. Expected an array of {code, value} objects.",
            };
          }
        }
        const results = await client.runScanner({ instrument, type, locations, filter });
        if (!Array.isArray(results) || results.length === 0) {
          return { success: true, output: "No results from scanner." };
        }
        return {
          success: true,
          output: `Scanner returned ${results.length} result(s):\n${formatJson(results)}`,
        };
      } catch (err) {
        return handleError(err);
      }
    },
  },
];

// ── Plugin Definition ───────────────────────────────────────────────

const allTools: ToolDefinition[] = [
  ...sessionTools,
  ...accountTools,
  ...portfolioTools,
  ...marketDataTools,
];

const ibkrPlugin: HarnessPlugin = {
  id: "harness-ibkr",
  name: "Interactive Brokers",
  version: "0.1.0",

  async activate(pluginCtx: PluginContext) {
    ctx = pluginCtx;
    log = ctx.log;

    const baseUrl = ctx.config.get("baseUrl", "https://localhost:5000");
    const rejectUnauthorized = ctx.config.get("rejectUnauthorized", false);
    const timeout = ctx.config.get("timeout", 15_000);
    const autoTickle = ctx.config.get("autoTickle", true);
    const tickleIntervalMs = ctx.config.get("tickleIntervalMs", 4 * 60_000); // 4 minutes

    client = new IBKRClient({ baseUrl, rejectUnauthorized, timeout });

    log.info(`IBKR plugin activated — gateway: ${baseUrl}`);

    // Optionally start an automatic keep-alive to prevent session timeout
    if (autoTickle) {
      tickleInterval = setInterval(async () => {
        try {
          await client.tickle();
          log.debug("IBKR session keep-alive sent");
        } catch (err) {
          log.warn(`IBKR keep-alive failed: ${err instanceof Error ? err.message : err}`);
        }
      }, tickleIntervalMs);
    }
  },

  async deactivate() {
    if (tickleInterval) {
      clearInterval(tickleInterval);
      tickleInterval = undefined;
    }
    log?.info("IBKR plugin deactivated");
  },

  tools: allTools,

  hooks: [
    {
      event: "prompt:assemble" as const,
      priority: 80,
      handler: async (data: EventPayloads["prompt:assemble"]) => {
        const ibkrContext =
          "\n\n## IBKR Integration\n" +
          "You have access to Interactive Brokers tools via the IBKR plugin. " +
          "The tools connect to the IBKR Client Portal Gateway REST API.\n\n" +
          "**Workflow tips:**\n" +
          "1. Check connection: use `ibkr_auth_status` to verify the gateway session is authenticated.\n" +
          "2. List accounts: call `ibkr_accounts` first — this is required before using other portfolio endpoints.\n" +
          "3. Portfolio overview: use `ibkr_positions` for holdings, `ibkr_account_summary` for balances/margin, " +
          "`ibkr_portfolio_allocation` for allocation breakdown.\n" +
          "4. Market data: search for instruments with `ibkr_contract_search`, then get snapshots with " +
          "`ibkr_market_snapshot` or history with `ibkr_market_history`.\n" +
          "5. Scanning: use `ibkr_scanner_params` to discover available scans, then `ibkr_scanner_run` to execute.\n" +
          "6. The first market data snapshot call may return partial data — call it a second time for complete results.\n";

        return {
          ...data,
          systemPrompt: data.systemPrompt + ibkrContext,
        };
      },
    },
  ],
};

export default ibkrPlugin;
