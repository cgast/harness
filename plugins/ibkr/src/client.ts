/**
 * IBKRClient — HTTP client for the IBKR Client Portal Gateway REST API
 *
 * A lightweight, zero-dependency wrapper around the IBKR CP Gateway endpoints.
 * Uses Node's built-in http/https modules — no fetch polyfills or external
 * HTTP libraries required.
 *
 * Endpoint coverage:
 *
 *   Session    POST /v1/api/iserver/auth/status
 *              POST /v1/api/tickle
 *              POST /v1/api/iserver/reauthenticate
 *              GET  /v1/api/sso/validate
 *
 *   Accounts   GET  /v1/api/portfolio/accounts
 *              GET  /v1/api/portfolio/subaccounts
 *              GET  /v1/api/iserver/accounts
 *
 *   Portfolio  GET  /v1/api/portfolio/{accountId}/positions/{pageId}
 *              GET  /v1/api/portfolio/{accountId}/summary
 *              GET  /v1/api/portfolio/{accountId}/ledger
 *              GET  /v1/api/portfolio/{accountId}/allocation
 *              GET  /v1/api/portfolio/positions/{conid}
 *
 *   P&L        GET  /v1/api/iserver/account/pnl/partitioned
 *
 *   Market     GET  /v1/api/iserver/marketdata/snapshot
 *              GET  /v1/api/iserver/marketdata/history
 *              GET  /v1/api/iserver/scanner/params
 *              POST /v1/api/iserver/scanner/run
 *
 *   Contracts  POST /v1/api/iserver/secdef/search
 *              GET  /v1/api/iserver/contract/{conid}/info
 *              GET  /v1/api/iserver/contract/{conid}/info-and-rules
 *
 *   Orders     GET  /v1/api/iserver/account/trades
 *              GET  /v1/api/iserver/account/orders
 *
 * All methods throw IBKRApiError on HTTP 4xx/5xx responses.
 *
 * @see index.ts  — plugin entry point that wires these methods into Harness tools
 * @see README.md — setup guide, configuration, and rate-limit reference
 */

import * as https from "node:https";
import * as http from "node:http";

export interface IBKRClientConfig {
  /** Base URL of the IBKR Client Portal Gateway (default: https://localhost:5000) */
  baseUrl: string;
  /**
   * Whether to reject unauthorized TLS certificates.
   * The CP Gateway uses a self-signed cert by default, so this defaults to false.
   */
  rejectUnauthorized: boolean;
  /** Request timeout in ms (default: 15000) */
  timeout: number;
}

const DEFAULT_CONFIG: IBKRClientConfig = {
  baseUrl: "https://localhost:5000",
  rejectUnauthorized: false,
  timeout: 15_000,
};

export interface IBKRAccount {
  id: string;
  accountId: string;
  accountTitle: string;
  displayName: string;
  accountAlias: string;
  accountStatus: number;
  currency: string;
  type: string;
  tradingType: string;
  covestor: boolean;
  parent?: { mmc: string[]; accountId: string; isMParent: boolean };
  desc: string;
}

export interface IBKRPosition {
  acctId: string;
  conid: number;
  contractDesc: string;
  position: number;
  mktPrice: number;
  mktValue: number;
  currency: string;
  avgCost: number;
  avgPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  assetClass: string;
  ticker: string;
  multiplier?: number;
  strike?: number;
  expiry?: string;
  putOrCall?: string;
  model: string;
}

export interface IBKRAuthStatus {
  authenticated: boolean;
  competing: boolean;
  connected: boolean;
  message: string;
  MAC: string;
  serverInfo?: { serverName: string; serverVersion: string };
}

export interface IBKRScannerParams {
  scan_type_list: Array<{ name: string; display_name: string }>;
  instrument_list: Array<{ type: string; display_name: string; filters: string[] }>;
  filter_list: Array<{ group: string; display_name: string; type: string; code: string }>;
  location_tree: Array<{ display_name: string; type: string; locations?: unknown[] }>;
}

export interface IBKRScannerRequest {
  instrument: string;
  type: string;
  locations: string;
  filter?: Array<{ code: string; value: unknown }>;
}

export interface IBKRContractSearchResult {
  conid: number;
  companyHeader: string;
  companyName: string;
  symbol: string;
  description: string;
  restricted: string;
  fop: string;
  opt: string;
  war: string;
  sections: Array<{ secType: string; exchange: string; months?: string }>;
}

export class IBKRApiError extends Error {
  constructor(
    public statusCode: number,
    public body: string,
    message?: string,
  ) {
    super(message || `IBKR API error ${statusCode}: ${body}`);
    this.name = "IBKRApiError";
  }
}

/**
 * Lightweight HTTP client for the IBKR Client Portal Gateway REST API.
 * Uses Node built-in http/https — no external dependencies required.
 */
export class IBKRClient {
  private config: IBKRClientConfig;

  constructor(config: Partial<IBKRClientConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Core HTTP ─────────────────────────────────────────────────────

  private request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.config.baseUrl);
      const isHttps = url.protocol === "https:";
      const transport = isHttps ? https : http;

      const payload = body ? JSON.stringify(body) : undefined;

      const opts: https.RequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          "User-Agent": "harness-ibkr-plugin/0.1.0",
          Accept: "application/json",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
        timeout: this.config.timeout,
        ...(isHttps
          ? { rejectUnauthorized: this.config.rejectUnauthorized }
          : {}),
      };

      const req = transport.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: unknown;
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            reject(new IBKRApiError(status, raw));
          } else {
            resolve({ status, data });
          }
        });
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`IBKR API request timed out after ${this.config.timeout}ms`));
      });

      if (payload) req.write(payload);
      req.end();
    });
  }

  private async get<T = unknown>(path: string): Promise<T> {
    const { data } = await this.request("GET", path);
    return data as T;
  }

  private async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const { data } = await this.request("POST", path, body);
    return data as T;
  }

  // ── Session / Auth ────────────────────────────────────────────────

  /** Check current authentication status. */
  async authStatus(): Promise<IBKRAuthStatus> {
    return this.post<IBKRAuthStatus>("/v1/api/iserver/auth/status");
  }

  /** Keep the session alive (call at least every 5 minutes). */
  async tickle(): Promise<unknown> {
    return this.post("/v1/api/tickle");
  }

  /** Re-authenticate the brokerage session. */
  async reauthenticate(): Promise<unknown> {
    return this.post("/v1/api/iserver/reauthenticate");
  }

  /** Validate the current SSO session. */
  async ssoValidate(): Promise<unknown> {
    return this.get("/v1/api/sso/validate");
  }

  // ── Accounts ──────────────────────────────────────────────────────

  /** List portfolio accounts (must be called before other /portfolio endpoints). */
  async getAccounts(): Promise<IBKRAccount[]> {
    return this.get<IBKRAccount[]>("/v1/api/portfolio/accounts");
  }

  /** List sub-accounts (for FA / IBroker multi-level structures). */
  async getSubaccounts(): Promise<IBKRAccount[]> {
    return this.get<IBKRAccount[]>("/v1/api/portfolio/subaccounts");
  }

  /** List tradeable accounts (requires brokerage session). */
  async getIServerAccounts(): Promise<unknown> {
    return this.get("/v1/api/iserver/accounts");
  }

  // ── Portfolio ─────────────────────────────────────────────────────

  /** Get positions for an account (paginated, pageId starts at 0). */
  async getPositions(accountId: string, pageId: number = 0): Promise<IBKRPosition[]> {
    return this.get<IBKRPosition[]>(
      `/v1/api/portfolio/${encodeURIComponent(accountId)}/positions/${pageId}`,
    );
  }

  /** Get account summary (margin, balances, etc.). */
  async getAccountSummary(accountId: string): Promise<Record<string, unknown>> {
    return this.get(`/v1/api/portfolio/${encodeURIComponent(accountId)}/summary`);
  }

  /** Get account ledger (cash balances by currency). */
  async getAccountLedger(accountId: string): Promise<Record<string, unknown>> {
    return this.get(`/v1/api/portfolio/${encodeURIComponent(accountId)}/ledger`);
  }

  /** Get portfolio allocation by asset class, sector, group. */
  async getPortfolioAllocation(accountId: string): Promise<Record<string, unknown>> {
    return this.get(`/v1/api/portfolio/${encodeURIComponent(accountId)}/allocation`);
  }

  /** Get position info for a specific contract across all accounts. */
  async getPositionByConid(conid: number): Promise<unknown> {
    return this.get(`/v1/api/portfolio/positions/${conid}`);
  }

  // ── P&L ───────────────────────────────────────────────────────────

  /** Get P&L partitioned by account/model. */
  async getAccountPnL(): Promise<Record<string, unknown>> {
    return this.get("/v1/api/iserver/account/pnl/partitioned");
  }

  // ── Market Data ───────────────────────────────────────────────────

  /**
   * Get a market data snapshot for one or more contracts.
   * @param conids Comma-separated contract IDs.
   * @param fields Comma-separated field IDs (e.g., "31,84,86" for last, bid, ask).
   */
  async getMarketDataSnapshot(
    conids: string,
    fields?: string,
  ): Promise<unknown[]> {
    const params = new URLSearchParams({ conids });
    if (fields) params.set("fields", fields);
    return this.get<unknown[]>(
      `/v1/api/iserver/marketdata/snapshot?${params.toString()}`,
    );
  }

  /** Get market data history for a contract. */
  async getMarketDataHistory(
    conid: number,
    period: string,
    bar: string,
    outsideRth?: boolean,
  ): Promise<unknown> {
    const params = new URLSearchParams({
      conid: String(conid),
      period,
      bar,
    });
    if (outsideRth !== undefined) params.set("outsideRth", String(outsideRth));
    return this.get(`/v1/api/iserver/marketdata/history?${params.toString()}`);
  }

  // ── Scanner ───────────────────────────────────────────────────────

  /** Get available scanner parameters (instruments, types, filters, locations). */
  async getScannerParams(): Promise<IBKRScannerParams> {
    return this.get<IBKRScannerParams>("/v1/api/iserver/scanner/params");
  }

  /** Run a market scanner. */
  async runScanner(scannerReq: IBKRScannerRequest): Promise<unknown[]> {
    return this.post<unknown[]>("/v1/api/iserver/scanner/run", scannerReq);
  }

  // ── Contract / Instrument Search ──────────────────────────────────

  /** Search for a contract by symbol or name. */
  async searchContract(symbol: string): Promise<IBKRContractSearchResult[]> {
    return this.post<IBKRContractSearchResult[]>(
      "/v1/api/iserver/secdef/search",
      { symbol },
    );
  }

  /** Get full contract details by conid. */
  async getContractDetails(conid: number): Promise<unknown> {
    return this.get(`/v1/api/iserver/contract/${conid}/info`);
  }

  /** Get related contracts (algos, futures, options chains). */
  async getContractRules(conid: number, isBuy: boolean = true): Promise<unknown> {
    return this.get(
      `/v1/api/iserver/contract/${conid}/info-and-rules?isBuy=${isBuy}`,
    );
  }

  // ── Trades / Orders (Read-Only) ───────────────────────────────────

  /** Get recent trades. */
  async getTrades(): Promise<unknown[]> {
    return this.get<unknown[]>("/v1/api/iserver/account/trades");
  }

  /** Get live orders. */
  async getOrders(): Promise<unknown> {
    return this.get("/v1/api/iserver/account/orders");
  }
}
