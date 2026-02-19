# NixOS development shell for Harness
#
# Electron requires an FHS-compatible environment with system libraries
# at standard paths. This shell provides that via buildFHSEnv.
#
# Usage:
#   nix-shell
#   pnpm install    # first time only — also rebuilds native modules for Electron
#   pnpm desktop
#
{ pkgs ? import <nixpkgs> {} }:

let
  lib = pkgs.lib;
in
(pkgs.buildFHSEnv {
  name = "harness-dev";
  targetPkgs = pkgs: (with pkgs; [
    # Build tools
    nodejs_22
    pnpm
    python3       # needed by node-gyp for native module compilation
    gcc
    gnumake
    pkg-config

    # Electron runtime dependencies
    glib
    glib.dev
    nss
    nspr
    atk
    cups
    dbus
    libdrm
    gtk3
    pango
    cairo
    expat
    alsa-lib
    at-spi2-atk
    at-spi2-core
    libxkbcommon
    mesa
    libGL
    vulkan-loader
    systemd         # libudev.so.1
    libpulseaudio
    libva
    pipewire
    wayland
    ffmpeg
    xdg-utils

    # X11 libraries
    xorg.libX11
    xorg.libXcomposite
    xorg.libXdamage
    xorg.libXext
    xorg.libXfixes
    xorg.libXrandr
    xorg.libxcb
    xorg.libxshmfence
    xorg.libXcursor
    xorg.libXi
    xorg.libXrender
    xorg.libXtst
    xorg.libXScrnSaver
  ])
  # libgbm was split from mesa in nixpkgs 25.05+
  ++ lib.optional (pkgs ? libgbm) pkgs.libgbm;
  runScript = "bash";
}).env
