/**
 * Bundle script for Harness Desktop.
 *
 * Uses esbuild to produce self-contained bundles for the Electron main process,
 * preload script, and renderer.  Native modules (better-sqlite3) and the
 * electron runtime are left as externals so electron-builder can handle them.
 *
 * Output structure (mirrors the tsc layout so path.join(__dirname, ..) works):
 *
 *   bundle/
 *   ├── main/index.js
 *   ├── preload/index.js
 *   ├── renderer/
 *   │   ├── index.html
 *   │   ├── styles.css
 *   │   └── app.js
 *   └── package.json   ← minimal manifest for electron-builder
 */

import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outdir = path.join(root, "bundle");

// ── Clean ────────────────────────────────────────────────────
fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(path.join(outdir, "main"), { recursive: true });
fs.mkdirSync(path.join(outdir, "preload"), { recursive: true });
fs.mkdirSync(path.join(outdir, "renderer"), { recursive: true });

// ── Shared externals ─────────────────────────────────────────
const external = ["electron", "better-sqlite3"];

// ── Main process ─────────────────────────────────────────────
await esbuild.build({
  entryPoints: [path.join(root, "src/main/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  outfile: path.join(outdir, "main/index.js"),
  external,
  sourcemap: true,
  format: "cjs",
  // Resolve workspace packages via the monorepo node_modules
  tsconfig: path.join(root, "tsconfig.json"),
});

// ── Preload script ───────────────────────────────────────────
await esbuild.build({
  entryPoints: [path.join(root, "src/preload/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  outfile: path.join(outdir, "preload/index.js"),
  external: ["electron"],
  sourcemap: true,
  format: "cjs",
  tsconfig: path.join(root, "tsconfig.json"),
});

// ── Renderer (browser context) ───────────────────────────────
await esbuild.build({
  entryPoints: [path.join(root, "src/renderer/app.ts")],
  bundle: true,
  platform: "browser",
  target: "chrome120",
  outfile: path.join(outdir, "renderer/app.js"),
  sourcemap: true,
  format: "iife",
  tsconfig: path.join(root, "tsconfig.json"),
});

// ── Copy static renderer assets ──────────────────────────────
for (const file of ["index.html", "styles.css"]) {
  fs.copyFileSync(
    path.join(root, "src/renderer", file),
    path.join(outdir, "renderer", file),
  );
}

// ── Generate minimal package.json for electron-builder ───────
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
fs.writeFileSync(
  path.join(outdir, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      author: {
        name: "Harness Contributors",
        email: "harness@users.noreply.github.com",
      },
      homepage: "https://github.com/cgast/harness",
      main: "main/index.js",
      dependencies: {
        "better-sqlite3": "^11.8.0",
      },
    },
    null,
    2,
  ),
);

// ── Isolate bundle from parent pnpm workspace ────────────────
// Without this, pnpm walks up the directory tree and finds the monorepo
// workspace root, causing electron-builder's `pnpm install` to fail.
fs.writeFileSync(
  path.join(outdir, "pnpm-workspace.yaml"),
  "# Standalone workspace root — prevents pnpm from inheriting the monorepo workspace\npackages: []\n",
);

console.log("✓ Bundle complete →", outdir);
