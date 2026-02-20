# Plan: Docker Electron Web Client + Compose Two-Service Setup

## Assessment

### Current State

The project has four packages:
- **`@harness/core`** — Core agent runtime library
- **`@harness/server`** — Headless HTTP/WebSocket server (REST `POST /api/run`, `GET /health`, WebSocket at `/ws`)
- **`@harness/desktop`** — Electron desktop app with a rich renderer UI (~45KB app.ts, ~18KB index.html, ~24KB styles.css)
- **`@harness/cli`** — CLI interface

The Electron renderer already runs in a Chromium browser context and is effectively a single-page web app. It communicates via Electron IPC through `window.harness` (preload contextBridge). The existing Docker setup only packages the headless server.

### Gap Analysis

The desktop renderer UI exposes a rich feature set through IPC:
- Chat/task execution, tools management, skills activation, plugins list
- Soul file CRUD, settings, telemetry, session history, event streaming

The server currently only exposes:
- `GET /health` — health check
- `POST /api/run` — blocking task execution
- `WS /ws` — streaming task execution with events

**The server API needs to be extended** to support the full feature set that the renderer UI expects.

### Recommended Approach: Static Web Client + Nginx Reverse Proxy

Extract the Electron renderer into a standalone web client package. Replace `window.harness` IPC calls with a WebSocket/REST transport layer. Build as static assets (HTML+JS+CSS) served by nginx, which also reverse-proxies `/api/*` and `/ws` to the backend.

**Why this approach:**
- The renderer is already browser-native (DOM APIs, no Node.js deps)
- Static assets are trivial to containerize (nginx is ~25MB)
- Nginx reverse proxy gives a single origin for the browser (no CORS issues)
- Clean separation: backend handles agent logic, frontend is purely presentational
- The alternative (BFF/SSR Node server) adds unnecessary complexity at this stage

---

## Implementation Steps

### Step 1: Extend `@harness/server` REST API

Add endpoints to `packages/server/src/server.ts` (or a new `api-routes.ts`):

| Endpoint | Method | Maps to |
|---|---|---|
| `/api/tools` | GET | tools list |
| `/api/tools/:name` | DELETE | unregister tool |
| `/api/skills` | GET | skills list |
| `/api/skills/:id/activate` | POST | activate skill |
| `/api/skills/:id/deactivate` | POST | deactivate skill |
| `/api/plugins` | GET | plugins list |
| `/api/sessions` | GET | sessions list |
| `/api/sessions/:id` | GET | session detail |
| `/api/sessions/:id/events` | GET | session events |
| `/api/state` | GET | agent state |
| `/api/config` | GET/PATCH | config get/update |
| `/api/settings` | GET/PUT | settings get/save |
| `/api/messages` | GET | message history |
| `/api/souls` | GET | soul files list |
| `/api/souls/:name` | GET/PUT/DELETE | soul file CRUD |
| `/api/souls/:name/activate` | POST | set active soul |
| `/api/telemetry` | GET | telemetry snapshot |
| `/api/running` | GET | is-running check |

### Step 2: Create `packages/webclient` package

- **`package.json`** — minimal package with esbuild build script
- **`src/transport.ts`** — `HarnessWebClient` class implementing `HarnessDesktopApi` using fetch + WebSocket instead of IPC
- **`src/app.ts`** — Copied from desktop renderer, modified to use `HarnessWebClient` instead of `window.harness`
- **`src/index.html`** — Adapted from desktop renderer (remove CSP `script-src 'self'` Electron restriction, add `<script src="app.js">`)
- **`src/styles.css`** — Copied from desktop renderer as-is
- **`tsconfig.json`** — Browser target config
- **`build.mjs`** — esbuild script producing `dist/` with static assets

### Step 3: Create `Dockerfile.webclient`

```dockerfile
# Stage 1: Build static assets
FROM node:22-slim AS builder
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/webclient/package.json packages/webclient/
RUN pnpm install --frozen-lockfile --filter @harness/webclient
COPY packages/webclient/ packages/webclient/
RUN pnpm --filter @harness/webclient build

# Stage 2: Serve with nginx
FROM nginx:alpine
COPY --from=builder /build/packages/webclient/dist /usr/share/nginx/html
COPY packages/webclient/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
```

### Step 4: Create `packages/webclient/nginx.conf`

```nginx
server {
    listen 8080;
    root /usr/share/nginx/html;
    index index.html;

    # Static assets
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Reverse proxy REST API to backend
    location /api/ {
        proxy_pass http://harness:3000;
        proxy_set_header Host $host;
    }

    # Reverse proxy WebSocket to backend
    location /ws {
        proxy_pass http://harness:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### Step 5: Update `docker-compose.yml`

```yaml
services:
  harness:
    build:
      context: .
      dockerfile: Dockerfile
    # ... (existing config, but no longer exposed on host by default)
    expose:
      - "3000"

  webclient:
    build:
      context: .
      dockerfile: Dockerfile.webclient
    ports:
      - "${WEB_PORT:-8080}:8080"
    depends_on:
      - harness
```

### Step 6: Update `.dockerignore` and `pnpm-workspace.yaml`

- Remove `packages/desktop/` exclusion rationale comment (keep excluding it from server image)
- The webclient Dockerfile will have its own context needs
- Add `packages/webclient` is already covered by `packages/*` in workspace

### Step 7: Adapt the transport layer in detail

The key file `transport.ts` will implement every method from `HarnessDesktopApi`:

```typescript
class HarnessWebClient {
  private ws: WebSocket;
  private eventCallbacks: ((payload) => void)[] = [];

  // REST methods use fetch()
  async getTools() { return this.get('/api/tools'); }
  async runTask(opts) { /* use WebSocket for streaming */ }

  // WebSocket for real-time events
  connect() { /* establish WS, dispatch events to callbacks */ }
  onEvent(cb) { this.eventCallbacks.push(cb); }
}
```

---

## Files to Create/Modify

### New files:
1. `packages/webclient/package.json`
2. `packages/webclient/tsconfig.json`
3. `packages/webclient/build.mjs`
4. `packages/webclient/nginx.conf`
5. `packages/webclient/src/index.html` (adapted from desktop)
6. `packages/webclient/src/styles.css` (copied from desktop)
7. `packages/webclient/src/transport.ts` (new IPC→HTTP/WS bridge)
8. `packages/webclient/src/app.ts` (adapted from desktop)
9. `Dockerfile.webclient`

### Modified files:
1. `packages/server/src/server.ts` — extended REST API routes
2. `docker-compose.yml` — two-service setup
3. `.dockerignore` — adjust for webclient build context
4. `pnpm-workspace.yaml` — already covers `packages/*`
5. `pnpm-lock.yaml` — will be updated by pnpm install

### Unchanged:
- `Dockerfile` (server image, stays as-is)
- `packages/desktop/` (Electron app, untouched)
- `packages/core/` (no changes needed)
