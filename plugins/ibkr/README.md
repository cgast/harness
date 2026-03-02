# @harness/plugin-ibkr

Interactive Brokers (IBKR) integration plugin for Harness. Connects to the
IBKR Client Portal Gateway REST API to provide portfolio analysis, account
management, and market data tools to the LLM agent.

## Prerequisites

1. **IBKR Pro account** — the Client Portal API only supports IBKR Pro.
2. **Client Portal Gateway** — a local Java gateway that proxies requests to
   IBKR's servers. Download it from
   [IBKR API](https://www.interactivebrokers.com/en/trading/ib-api.php),
   then run:
   ```bash
   cd clientportal-gw
   bin/run.sh root/conf.yaml
   ```
   The gateway starts at `https://localhost:5000` by default and presents a
   browser-based login page. Once authenticated, tools in this plugin can
   make API calls through it.
3. **Session lifetime** — a gateway session times out after ~6 minutes of
   inactivity. The plugin sends automatic keep-alive pings (configurable).

## Setup

```yaml
# ~/.harness/config.yaml
plugins:
  enabled:
    - "ibkr"
  ibkr:
    baseUrl: "https://localhost:5000"   # Gateway address
    rejectUnauthorized: false           # Self-signed cert (default)
    timeout: 15000                      # Per-request timeout (ms)
    autoTickle: true                    # Auto keep-alive pings
    tickleIntervalMs: 240000            # Ping interval (4 min)
```

All config keys are optional — defaults are shown above.

## Tools

The plugin registers 17 tools grouped into four categories.

### Session Management

| Tool                   | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `ibkr_auth_status`     | Check if the gateway session is authenticated        |
| `ibkr_tickle`          | Send a manual keep-alive ping                        |
| `ibkr_reauthenticate`  | Re-establish a dropped brokerage session             |

### Account Information

| Tool                   | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `ibkr_accounts`        | List all accessible portfolio accounts               |
| `ibkr_account_summary` | Margin, net liquidation value, buying power          |
| `ibkr_account_ledger`  | Cash balances broken down by currency                |
| `ibkr_account_pnl`     | Daily / unrealized / realized P&L                    |

### Portfolio

| Tool                        | Description                                     |
| --------------------------- | ----------------------------------------------- |
| `ibkr_positions`            | Open positions with cost basis & P&L            |
| `ibkr_portfolio_allocation` | Allocation by asset class, sector, group        |
| `ibkr_trades`               | Recent trade executions                         |
| `ibkr_orders`               | Current live / working orders                   |

### Market Data & Analysis

| Tool                   | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `ibkr_contract_search` | Search instruments by symbol or company name         |
| `ibkr_contract_details`| Full contract specs (exchange, currency, industry)   |
| `ibkr_market_snapshot` | Real-time quote (last, bid, ask, volume, change)     |
| `ibkr_market_history`  | Historical OHLCV bars for technical analysis         |
| `ibkr_scanner_params`  | Discover available market scanner types & filters    |
| `ibkr_scanner_run`     | Run a scanner (top gainers, most active, high IV...) |

## Typical Workflow

The prompt injection hook teaches the LLM this sequence automatically, but
for reference:

```
1. ibkr_auth_status          → verify the gateway is connected
2. ibkr_accounts             → required before any /portfolio call
3. ibkr_positions            → see what you hold
   ibkr_account_summary      → see balances and margin
   ibkr_portfolio_allocation → see sector/asset-class breakdown
4. ibkr_contract_search      → find a contract ID (conid)
   ibkr_market_snapshot      → get a live quote  (call twice — first may be partial)
   ibkr_market_history       → pull OHLCV bars
5. ibkr_scanner_params       → list scanner types
   ibkr_scanner_run          → run a scan
```

## Architecture

```
plugins/ibkr/
├── src/
│   ├── index.ts    Plugin entry point — tools, hooks, lifecycle
│   └── client.ts   HTTP client wrapping the IBKR REST API
├── package.json
└── tsconfig.json
```

- **Zero external dependencies.** Uses Node's built-in `http` / `https`.
- **Read-only.** No order placement or account modification — only data retrieval.
- **Self-signed cert support.** The gateway ships with a self-signed TLS cert;
  `rejectUnauthorized` defaults to `false`.
- **Prompt injection.** A `prompt:assemble` hook injects workflow tips into the
  system prompt so the LLM knows how to sequence the tools.

## Rate Limits

IBKR enforces per-endpoint rate limits. The plugin surfaces `429` errors with
a clear message, but be aware of these constraints:

| Endpoint pattern              | Limit            |
| ----------------------------- | ---------------- |
| `/iserver/marketdata/snapshot`| 10 req/s         |
| `/iserver/scanner/params`     | 1 req / 15 min   |
| `/iserver/scanner/run`        | 1 req/s          |
| `/iserver/trades`             | 1 req / 5 sec    |
| `/iserver/orders`             | 1 req / 5 sec    |
| `/portfolio/accounts`         | 1 req / 5 sec    |
| General (via gateway)         | 10 req/s global  |

## References

- [IBKR Web API Documentation](https://www.interactivebrokers.com/campus/ibkr-api-page/webapi-doc/)
- [Client Portal API v1.0](https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/)
- [Trading Web API](https://www.interactivebrokers.com/campus/ibkr-api-page/web-api-trading/)
