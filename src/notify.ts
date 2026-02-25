import { execFile } from "node:child_process";

/**
 * Sanitize a string for safe embedding as an AppleScript string literal.
 *
 * Strategy: use `osascript` with an argument vector via `execFile` (no shell).
 * The AppleScript accesses user input via `on run argv` — the title and body
 * are passed as positional arguments, never interpolated into script text.
 *
 * This function is a defense-in-depth layer: it strips control characters
 * (U+0000–U+001F except \t \n \r, U+007F, U+0080–U+009F) from the input
 * so that even if a future code path accidentally interpolates, no control
 * character injection is possible.
 */
export function sanitize(input: string): string {
  // Strip C0 control characters (except \t, \n, \r), DEL, and C1 control characters.
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g, "");
}

/**
 * Send a macOS notification using `osascript` via `execFile`.
 *
 * The AppleScript is a static string — user input is passed via argv,
 * accessed as `item 1 of argv` and `item 2 of argv`. No string interpolation
 * of user content into AppleScript source.
 *
 * Throws on delivery failure.
 */
export function sendNotification(title: string, body: string): Promise<void> {
  const safeTitle = sanitize(title);
  const safeBody = sanitize(body);

  // Static AppleScript — user data enters only via argv, never via interpolation.
  const script = `on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run`;

  return new Promise<void>((resolve, reject) => {
    // execFile with an argument array — no shell involved.
    execFile(
      "/usr/bin/osascript",
      ["-e", script, safeTitle, safeBody],
      { timeout: 5000 },
      (error, _stdout, stderr) => {
        if (error) {
          // Log diagnostic detail to stderr for the operator.
          process.stderr.write(
            `[push-notification] osascript failed: ${stderr || error.message}\n`
          );
          reject(new Error("Notification delivery failed"));
          return;
        }
        resolve();
      }
    );
  });
}
