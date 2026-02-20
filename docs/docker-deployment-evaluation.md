# Docker Deployment Evaluation

## Summary

This document evaluates adding Docker image support for the Harness server
(`@harness/server`) with automatic publishing to GitHub Container Registry
(GHCR). The server — a headless HTTP/WebSocket agent runtime — is the ideal
target for containerization.

---

## Current State

| Deployment target | Status | Notes |
|---|---|---|
| Desktop (Electron) | Shipped | Built via `electron-builder`, CI publishes `.dmg`/`.exe`/`.AppImage` |
| CLI | Source-only | `npx` / clone-and-build |
| Server | Source-only | Clone → `pnpm install` → `pnpm build` → `node dist/server.js` |
| **Docker image** | **Missing** | No Dockerfile, no container registry |

The server has **zero GUI dependencies** — it needs only Node.js + the
`better-sqlite3` native module. This makes it an excellent candidate for a
lightweight container image.

---

## What Docker Makes Easier

### 1. NixOS Deployment

The existing `shell.nix` targets **Electron desktop development** and pulls in
60+ packages (X11, Wayland, GTK, Mesa, PulseAudio, etc.). For users who just
want to run the Harness server on NixOS, this is wildly over-specified.

With Docker, NixOS users have three clean options:

```nix
# Option A: OCI container via NixOS module
virtualisation.oci-containers.containers.harness = {
  image = "ghcr.io/cgast/harness:latest";
  ports = [ "3000:3000" ];
  environment = { ANTHROPIC_API_KEY = "..."; };
  volumes = [ "harness-data:/home/harness/.harness" ];
};

# Option B: Podman (rootless, no daemon)
# Just run: podman run -p 3000:3000 -e ANTHROPIC_API_KEY=... ghcr.io/cgast/harness

# Option C: Docker via NixOS
virtualisation.docker.enable = true;
```

This completely sidesteps:
- Native module compilation issues (`better-sqlite3` with mismatched glibc)
- FHS incompatibilities (NixOS uses `/nix/store` paths, not `/usr/lib`)
- Needing to maintain a separate Nix flake just for the server

### 2. Sandboxing / Safety

The Harness agent runtime **executes shell commands and file operations** as
tools — this is its core purpose. Running it containerized provides defense in
depth:

| Layer | What it prevents |
|---|---|
| **Filesystem isolation** | Agent can't read/write outside mounted volumes |
| **Non-root user** | Container runs as UID 1001, not root |
| **Read-only rootfs** | `docker-compose.yml` mounts the rootfs read-only |
| **No new privileges** | `security_opt: no-new-privileges` blocks privilege escalation |
| **Resource limits** | Memory caps prevent runaway processes |
| **Network isolation** | Only port 3000 is exposed; can add `--network=none` for full isolation |
| **Disposable environment** | `docker rm` leaves no residue on the host |

For use cases where the agent executes untrusted or semi-trusted tasks, this is
a significant safety improvement over running directly on the host.

### 3. Ease of Use / Onboarding

**Before (source install):**
```bash
git clone https://github.com/cgast/harness
cd harness
# Need: Node.js 20+, pnpm 9, Python 3, gcc/g++ (for better-sqlite3)
pnpm install
pnpm --filter @harness/core build
pnpm --filter @harness/server build
ANTHROPIC_API_KEY=... node packages/server/dist/server.js
```

**After (Docker):**
```bash
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... ghcr.io/cgast/harness
```

One command. No build toolchain. No Node.js version management. Works
identically on Ubuntu, Fedora, macOS (Docker Desktop), WSL2, NixOS, and any
cloud provider.

### 4. Production Deployment

Docker images are the lingua franca of modern deployment targets:

- **Cloud Run / Fly.io / Railway** — Push image, done
- **Kubernetes** — Standard Pod spec
- **AWS ECS / Fargate** — Native container support
- **Home servers** — Docker Compose or Portainer
- **CI/CD agent** — Spin up as a sidecar for automated testing

---

## What's Included in This PR

### `Dockerfile`

Multi-stage build optimized for size and security:

1. **Builder stage** (`node:22-slim`) — installs pnpm, compiles TypeScript,
   builds `better-sqlite3` native module, prunes dev dependencies
2. **Production stage** (`node:22-slim`) — copies only built artifacts, runs as
   non-root user `harness` (UID 1001), uses `tini` as PID 1 for proper signal
   handling

**Key design choices:**
- Only `@harness/core` and `@harness/server` are included (no CLI, no Electron)
- Default souls/skills are baked into the image
- `HEALTHCHECK` hits `/health` every 30s for orchestrator integration
- Layer ordering maximizes Docker cache hits (lockfile → deps → source → build)

### `.dockerignore`

Excludes `node_modules/`, `dist/`, `.git/`, desktop/CLI packages, and
development files from the build context.

### `docker-compose.yml`

Ready-to-use local deployment with:
- Named volume for SQLite persistence
- Environment variable passthrough for API keys
- Memory limits (512 MB cap)
- Security hardening (read-only rootfs, no-new-privileges, tmpfs for `/tmp`)

### `.github/workflows/docker-publish.yml`

Automated GHCR publishing:

| Trigger | Tags produced |
|---|---|
| Push to `main` | `ghcr.io/owner/harness:main` |
| Tag `v1.2.3` | `:1.2.3`, `:1.2`, `:latest` |
| Pull request | `:pr-42` (build-only, not pushed) |

Features:
- **Multi-arch**: Builds for both `linux/amd64` and `linux/arm64`
  (Apple Silicon, Raspberry Pi, Graviton)
- **GitHub Actions cache**: Uses GHA cache backend for fast rebuilds
- **Build provenance attestation**: SLSA-compliant supply chain attestation
  attached to each pushed image

---

## Tradeoffs and Considerations

### Image Size

Estimated final image size: **~200-250 MB** (Node.js 22 slim + better-sqlite3 +
application code). Could be reduced further with a distroless base, but
`node:22-slim` provides a good balance of debuggability and size.

### Tool Execution Sandboxing

The agent's shell/file tools execute **inside the container**. This is both a
feature (safety) and a constraint (can't access host paths unless mounted). For
use cases where the agent needs host access, users can bind-mount specific
directories:

```bash
docker run -v /path/to/project:/workspace -e ANTHROPIC_API_KEY=... ghcr.io/cgast/harness
```

### No Desktop/CLI in Image

The Docker image only contains the server. The CLI and desktop remain
source-install or binary-download only. This keeps the image focused and small.

### Database Persistence

SQLite (`better-sqlite3`) works well in single-container deployments. The
`docker-compose.yml` uses a named volume so data survives container restarts.
For multi-replica deployments, a migration to PostgreSQL/MySQL would be needed
(out of scope).

---

## Future Enhancements

- **Distroless variant** — Smaller image, no shell (even more locked down)
- **Helm chart** — Kubernetes deployment template
- **`docker-compose.yml` with Ollama sidecar** — Local LLM inference alongside
  Harness for fully offline operation
- **Nix flake with Docker image derivation** — `nix build .#docker` to build
  the OCI image from Nix, for reproducible builds
