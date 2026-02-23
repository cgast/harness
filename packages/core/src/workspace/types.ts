/**
 * Workspace permission types for folder-scoped access control.
 *
 * Workspace permissions restrict which paths the agent can read, write,
 * and execute commands in. This prevents path traversal attacks and
 * confines agent operations to approved directories.
 */

export interface WorkspacePermissions {
  /**
   * List of allowed path prefixes or glob patterns.
   * If specified, ONLY paths matching at least one entry are accessible.
   * If empty/undefined, defaults to workdir-only access.
   *
   * Examples: ["/home/user/project", "/tmp/harness-*"]
   */
  allowedPaths?: string[];

  /**
   * List of denied path prefixes or glob patterns.
   * Takes priority over allowedPaths — a path matching any denied pattern
   * is blocked regardless of allowedPaths.
   *
   * Examples: ["/etc", "/home/user/.ssh", "**\/.env"]
   */
  deniedPaths?: string[];

  /**
   * If true, file operations can target paths outside the workdir,
   * provided they pass the allowed/denied checks.
   * Default: false (all operations confined to workdir subtree).
   */
  allowOutsideWorkdir?: boolean;

  /**
   * If true, shell commands are forced to use the workdir as cwd,
   * ignoring any workdir override in shell tool args.
   * Default: true.
   */
  shellRestrictToWorkdir?: boolean;
}

export interface WorkspaceValidationResult {
  allowed: boolean;
  reason?: string;
  resolvedPath?: string;
}
