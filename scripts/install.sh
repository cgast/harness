#!/usr/bin/env sh
# Harness CLI installer for macOS and Linux.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/cgast/harness/main/scripts/install.sh | sh
#
# Environment variables:
#   HARNESS_VERSION   - Specific version to install (default: latest)
#   HARNESS_INSTALL   - Installation directory (default: ~/.harness/bin)

set -e

REPO="cgast/harness"
INSTALL_DIR="${HARNESS_INSTALL:-$HOME/.harness/bin}"
BASE_URL="https://github.com/$REPO/releases"

# ── Helpers ────────────────────────────────────────────────────────
info()  { printf '  \033[1;34m>\033[0m %s\n' "$*"; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
err()   { printf '  \033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || err "Required command not found: $1"
}

# ── Detect platform ───────────────────────────────────────────────
detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Darwin) PLATFORM="mac" ;;
    Linux)  PLATFORM="linux" ;;
    *)      err "Unsupported OS: $OS. Use the Windows installer (install.ps1) on Windows." ;;
  esac

  case "$ARCH" in
    x86_64|amd64)  ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *)             err "Unsupported architecture: $ARCH" ;;
  esac

  info "Detected platform: $PLATFORM/$ARCH"
}

# ── Resolve version ──────────────────────────────────────────────
resolve_version() {
  if [ -n "$HARNESS_VERSION" ]; then
    VERSION="$HARNESS_VERSION"
  else
    need curl
    VERSION="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$BASE_URL/latest" | rev | cut -d'/' -f1 | rev)"
    [ -n "$VERSION" ] || err "Could not determine latest version"
  fi
  info "Version: $VERSION"
}

# ── Download & extract ───────────────────────────────────────────
download_and_install() {
  need curl

  case "$PLATFORM" in
    mac)
      FILENAME="Harness Desktop-${VERSION#v}-${ARCH}.zip"
      ;;
    linux)
      FILENAME="Harness Desktop-${VERSION#v}-${ARCH}.AppImage"
      ;;
  esac

  URL="$BASE_URL/download/$VERSION/$FILENAME"
  TMPDIR="$(mktemp -d)"
  TMPFILE="$TMPDIR/$FILENAME"

  info "Downloading $URL"
  curl -fSL --progress-bar -o "$TMPFILE" "$URL" || err "Download failed. Check that version $VERSION exists."

  mkdir -p "$INSTALL_DIR"

  case "$PLATFORM" in
    mac)
      # Extract the zip to a temporary location, then move the .app bundle
      unzip -qo "$TMPFILE" -d "$TMPDIR/extracted"
      APP_BUNDLE="$(find "$TMPDIR/extracted" -name '*.app' -maxdepth 1 | head -1)"
      if [ -n "$APP_BUNDLE" ]; then
        DEST="/Applications/$(basename "$APP_BUNDLE")"
        info "Installing to $DEST"
        rm -rf "$DEST"
        mv "$APP_BUNDLE" "$DEST"
        ok "Installed Harness Desktop to $DEST"
      else
        # Fallback: no .app found, just put the binary in INSTALL_DIR
        mv "$TMPFILE" "$INSTALL_DIR/harness"
        chmod +x "$INSTALL_DIR/harness"
        ok "Installed to $INSTALL_DIR/harness"
      fi
      ;;
    linux)
      mv "$TMPFILE" "$INSTALL_DIR/harness"
      chmod +x "$INSTALL_DIR/harness"
      ok "Installed to $INSTALL_DIR/harness"
      ;;
  esac

  rm -rf "$TMPDIR"
}

# ── Update PATH ──────────────────────────────────────────────────
update_path() {
  case "$PLATFORM" in
    mac)
      # macOS .app bundle goes to /Applications, no PATH update needed for GUI
      # but symlink the CLI wrapper if desired
      return
      ;;
  esac

  if echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    return
  fi

  info "Adding $INSTALL_DIR to PATH"
  PROFILE=""
  for f in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    [ -f "$f" ] && PROFILE="$f" && break
  done

  if [ -n "$PROFILE" ]; then
    echo "" >> "$PROFILE"
    echo "# Harness CLI" >> "$PROFILE"
    echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$PROFILE"
    ok "Added to $PROFILE (restart your shell or run: source $PROFILE)"
  else
    info "Add this to your shell profile:"
    info "  export PATH=\"$INSTALL_DIR:\$PATH\""
  fi
}

# ── Main ─────────────────────────────────────────────────────────
main() {
  printf '\n  \033[1mHarness Installer\033[0m\n\n'

  detect_platform
  resolve_version
  download_and_install
  update_path

  printf '\n  \033[1;32mDone!\033[0m Harness %s installed successfully.\n\n' "$VERSION"
}

main "$@"
