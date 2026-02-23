/**
 * WorkspaceGuard - Validates file paths and shell working directories
 * against configured workspace permissions.
 *
 * Provides the security boundary that prevents agents from accessing
 * files outside approved directories (path traversal prevention).
 */

import * as path from "node:path";
import type { WorkspacePermissions, WorkspaceValidationResult } from "./types.js";

export class WorkspaceGuard {
  private workdir: string;
  private permissions: Required<WorkspacePermissions>;

  constructor(workdir: string, permissions: WorkspacePermissions = {}) {
    this.workdir = path.resolve(workdir);
    this.permissions = {
      allowedPaths: permissions.allowedPaths ?? [],
      deniedPaths: permissions.deniedPaths ?? [],
      allowOutsideWorkdir: permissions.allowOutsideWorkdir ?? false,
      shellRestrictToWorkdir: permissions.shellRestrictToWorkdir ?? true,
    };
  }

  /**
   * Validate whether a file path is allowed for access.
   * Resolves relative paths against workdir before checking.
   */
  validatePath(targetPath: string): WorkspaceValidationResult {
    const resolved = path.resolve(this.workdir, targetPath);

    // Check denied paths first (highest priority)
    if (this.matchesDenied(resolved)) {
      return {
        allowed: false,
        reason: `Path '${resolved}' matches a denied path pattern`,
        resolvedPath: resolved,
      };
    }

    // Check workdir confinement
    if (!this.permissions.allowOutsideWorkdir) {
      if (!this.isWithin(resolved, this.workdir)) {
        return {
          allowed: false,
          reason: `Path '${resolved}' is outside the workspace directory '${this.workdir}'. Set allowOutsideWorkdir to permit access.`,
          resolvedPath: resolved,
        };
      }
    }

    // If allowedPaths is specified, path must match at least one
    if (this.permissions.allowedPaths.length > 0) {
      if (!this.matchesAllowed(resolved)) {
        return {
          allowed: false,
          reason: `Path '${resolved}' does not match any allowed path pattern`,
          resolvedPath: resolved,
        };
      }
    }

    return { allowed: true, resolvedPath: resolved };
  }

  /**
   * Validate a shell command's working directory.
   */
  validateShellWorkdir(requestedWorkdir?: string): WorkspaceValidationResult {
    if (!requestedWorkdir) {
      return { allowed: true, resolvedPath: this.workdir };
    }

    if (this.permissions.shellRestrictToWorkdir) {
      const resolved = path.resolve(this.workdir, requestedWorkdir);
      if (!this.isWithin(resolved, this.workdir)) {
        return {
          allowed: false,
          reason: `Shell working directory '${resolved}' is outside the workspace '${this.workdir}'. shellRestrictToWorkdir is enabled.`,
          resolvedPath: resolved,
        };
      }
      return { allowed: true, resolvedPath: resolved };
    }

    // If not restricted to workdir, apply the same path validation rules
    return this.validatePath(requestedWorkdir);
  }

  /**
   * Get the current workspace root.
   */
  getWorkdir(): string {
    return this.workdir;
  }

  /**
   * Get the active permissions (with defaults applied).
   */
  getPermissions(): Required<WorkspacePermissions> {
    return { ...this.permissions };
  }

  /**
   * Update permissions at runtime (e.g., from UI settings changes).
   */
  updatePermissions(permissions: Partial<WorkspacePermissions>): void {
    if (permissions.allowedPaths !== undefined) {
      this.permissions.allowedPaths = permissions.allowedPaths;
    }
    if (permissions.deniedPaths !== undefined) {
      this.permissions.deniedPaths = permissions.deniedPaths;
    }
    if (permissions.allowOutsideWorkdir !== undefined) {
      this.permissions.allowOutsideWorkdir = permissions.allowOutsideWorkdir;
    }
    if (permissions.shellRestrictToWorkdir !== undefined) {
      this.permissions.shellRestrictToWorkdir = permissions.shellRestrictToWorkdir;
    }
  }

  /**
   * Check whether `child` is a path within `parent`.
   */
  private isWithin(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    // If the relative path starts with ".." or is absolute, it's outside
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  /**
   * Check if a resolved path matches any denied pattern.
   */
  private matchesDenied(resolved: string): boolean {
    return this.permissions.deniedPaths.some((pattern) =>
      this.matchPattern(resolved, pattern)
    );
  }

  /**
   * Check if a resolved path matches any allowed pattern.
   */
  private matchesAllowed(resolved: string): boolean {
    return this.permissions.allowedPaths.some((pattern) =>
      this.matchPattern(resolved, pattern)
    );
  }

  /**
   * Match a resolved path against a pattern.
   *
   * Supports:
   *   - Absolute path prefixes: "/home/user/project" matches any path starting with it
   *   - Simple glob with "*": "/tmp/harness-*" matches "/tmp/harness-abc"
   *   - Basename patterns: ".env" matches any file named ".env" at any depth
   */
  private matchPattern(resolved: string, pattern: string): boolean {
    // Resolve the pattern against workdir to normalize it
    const resolvedPattern = path.isAbsolute(pattern)
      ? pattern
      : path.resolve(this.workdir, pattern);

    // If pattern has no glob characters, treat as prefix match
    if (!pattern.includes("*")) {
      // Basename-only pattern (no slashes) — match against filename
      if (!pattern.includes("/") && !pattern.includes(path.sep)) {
        const basename = path.basename(resolved);
        return basename === pattern;
      }
      // Path prefix match: pattern is parent of resolved path
      return this.isWithin(resolved, resolvedPattern) || resolved === resolvedPattern;
    }

    // Convert glob pattern to regex
    const regex = this.globToRegex(resolvedPattern);
    return regex.test(resolved);
  }

  /**
   * Convert a simple glob pattern to a RegExp.
   * Supports * (any chars except /) and ** (any chars including /).
   */
  private globToRegex(glob: string): RegExp {
    let regexStr = "^";
    let i = 0;
    while (i < glob.length) {
      const char = glob[i];
      if (char === "*") {
        if (glob[i + 1] === "*") {
          // ** matches anything including path separators
          regexStr += ".*";
          i += 2;
          // Skip trailing slash after **
          if (glob[i] === "/" || glob[i] === path.sep) {
            i++;
          }
          continue;
        }
        // * matches anything except path separators
        regexStr += "[^/]*";
      } else if (char === "?") {
        regexStr += "[^/]";
      } else if (".+^${}()|[]\\".includes(char)) {
        regexStr += "\\" + char;
      } else {
        regexStr += char;
      }
      i++;
    }
    regexStr += "$";
    return new RegExp(regexStr);
  }
}
