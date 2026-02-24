# Harness Sandbox - Isolated execution environment for the Harness LLM agent.
#
# Provides Python 3.12, Node.js 20, LibreOffice headless, and common utilities
# inside a sandboxed container. Commands run as a non-root `sandbox` user.
#
# Build:   docker build -t harness-sandbox:latest .
# Run:     docker run --rm harness-sandbox:latest python3 --version

FROM ubuntu:24.04

# Avoid interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# ── System packages ─────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Python
    python3 \
    python3-pip \
    python3-venv \
    # Node.js 20 (via NodeSource)
    curl \
    ca-certificates \
    gnupg \
    # Basic utilities
    jq \
    git \
    # LibreOffice headless (for document conversion)
    libreoffice-core \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    # Fonts for document rendering
    fonts-liberation \
    fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# ── Node.js 20 via NodeSource ───────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# ── Python packages ─────────────────────────────────────────────
RUN pip3 install --no-cache-dir --break-system-packages \
    requests \
    pandas \
    openpyxl \
    python-pptx \
    Pillow \
    matplotlib

# ── Non-root user ───────────────────────────────────────────────
RUN useradd -m -s /bin/bash sandbox \
  && mkdir -p /workspace/.harness-out \
  && chown -R sandbox:sandbox /workspace

USER sandbox
WORKDIR /workspace

# Default entrypoint: accept a command as args
ENTRYPOINT ["/bin/bash", "-c"]
CMD ["echo 'harness-sandbox ready'"]
