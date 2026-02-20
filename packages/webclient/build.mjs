/**
 * Build script for Harness Web Client.
 *
 * Uses esbuild to produce static assets (HTML + JS + CSS) that can be
 * served by any HTTP server (nginx, caddy, etc.).
 *
 * Output structure:
 *   dist/
 *   ├── index.html
 *   ├── styles.css
 *   └── app.js
 */

import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(__dirname, "dist");

// Clean
fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

// Bundle renderer app (browser target)
await esbuild.build({
  entryPoints: [path.join(__dirname, "src/app.ts")],
  bundle: true,
  platform: "browser",
  target: "chrome120",
  outfile: path.join(outdir, "app.js"),
  sourcemap: true,
  format: "iife",
  tsconfig: path.join(__dirname, "tsconfig.json"),
});

// Copy static assets
for (const file of ["index.html", "styles.css"]) {
  fs.copyFileSync(
    path.join(__dirname, "src", file),
    path.join(outdir, file)
  );
}

console.log("✓ Webclient build complete →", outdir);
