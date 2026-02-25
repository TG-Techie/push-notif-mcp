# Push Notification MCP Server

A local MCP server that exposes a single tool for sending push notifications to the user on macOS.

## Version

0.1.4

---

## Overview

This system is a Model Context Protocol (MCP) server that runs locally on the user's macOS machine. It exposes exactly one tool — `send_notification` — which delivers a visual notification to the user through the macOS notification system. The server is designed to be invoked by LLM-powered coding agents (Claude Code, Roo Code, Augment Code, or any MCP-compatible client) to alert the user when something requires their attention.

The server must be packageable as an MCPB bundle (`.mcpb` file) and simultaneously usable as a standalone MCP server for other tools.

### Design Principles

1. **Single responsibility.** One tool. One job. Send a notification.
2. **Security by construction.** All inputs are structured, validated, and sanitized before reaching any system interface. The implementation boundary between "LLM-provided text" and "system execution" is never bridged by string interpolation or template substitution of unsanitized input.
3. **Implementation opacity.** The LLM-facing tool description discloses nothing about the notification delivery mechanism. The tool description says it sends a push notification. It does not say how.
4. **Cross-client compatibility.** The server runs as a standard MCP server over stdio transport. Any MCP-compatible client can use it without modification.

---

## Tool Interface

The server exposes exactly one tool.

### `send_notification`

**LLM-facing description** (this is the exact description string exposed via MCP tool metadata):

> "Send a push notification to the user. Use this to alert the user when a long-running task completes, when input is needed, or when something requires their attention."

The description must not mention macOS, AppleScript, osascript, terminal-notifier, or any implementation detail. It must not mention the operating system. It is a push notification. That is all the LLM needs to know.

**Input schema:**

```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "description": "Short notification title. Typically identifies the context: branch name ?? workspace name ?? project name ?? repository name.",
      "maxLength": 256
    },
    "body": {
      "type": "string",
      "description": "Notification body text. Describes what happened or what the user needs to know.",
      "maxLength": 1024
    }
  },
  "required": ["title", "body"],
  "additionalProperties": false
}
```

**Parameter constraints:**

| Parameter | Type   | Required | Max Length | Default |
| --------- | ------ | -------- | ---------- | ------- |
| `title`   | string | yes      | 256 chars  | —       |
| `body`    | string | yes      | 1024 chars | —       |

Both `title` and `body` must be non-empty after trimming whitespace. A string consisting only of whitespace is invalid.

**Validation behavior:**

| Condition                       | Behavior                                       |
| ------------------------------- | ---------------------------------------------- |
| Missing `title`                 | Return MCP error: `"title" is required`        |
| Missing `body`                  | Return MCP error: `"body" is required`         |
| `title` empty after trim        | Return MCP error: `"title" must not be empty`  |
| `body` empty after trim         | Return MCP error: `"body" must not be empty`   |
| `title` exceeds 256 chars       | Truncate to 256 chars. Do not error.           |
| `body` exceeds 1024 chars       | Truncate to 1024 chars. Do not error.          |
| Extra properties in input       | Ignore. Do not error.                          |
| `title` or `body` is not string | Return MCP error: `"<field>" must be a string` |

Truncation is silent — the notification is sent with truncated content and the tool result includes a note that truncation occurred.

**Success response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Notification sent."
    }
  ]
}
```

If truncation occurred, append one truncation note per truncated field. The note format is `" Note: <field> was truncated from <original_length> to <limit> characters."` Multiple notes are concatenated.

Examples:

Title only truncated:
```json
{
  "content": [
    {
      "type": "text",
      "text": "Notification sent. Note: title was truncated from 312 to 256 characters."
    }
  ]
}
```

Both fields truncated:
```json
{
  "content": [
    {
      "type": "text",
      "text": "Notification sent. Note: title was truncated from 400 to 256 characters. Note: body was truncated from 2048 to 1024 characters."
    }
  ]
}
```

**Error response:**

Validation errors are returned as MCP tool errors (i.e., `isError: true` in the MCP result):

```json
{
  "content": [
    {
      "type": "text",
      "text": "<error message>"
    }
  ],
  "isError": true
}
```

If the underlying notification delivery fails (e.g., the system command returns a nonzero exit code), return:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Failed to send notification."
    }
  ],
  "isError": true
}
```

The error message for delivery failure must not include system-level details (stderr output, exit codes, process information). It says "Failed to send notification." and nothing more. Diagnostic detail may be logged to stderr for the server operator but is never returned to the LLM.

---

## Input Sanitization

This is the security-critical section of the spec.

### Threat Model

The tool receives free-text input from an LLM. The LLM is an untrusted input source — its outputs may contain adversarial content due to prompt injection, jailbreaking, or simply unexpected content. The input will ultimately reach a system interface that executes a notification. The sanitization layer must guarantee that no input, regardless of content, can:

1. Execute arbitrary code or commands on the host system.
2. Escape the notification context (e.g., inject additional AppleScript statements, shell commands, or control sequences).
3. Cause the notification delivery process to behave in any way other than displaying the provided text.

### Sanitization Strategy

The implementation must use one of the following approaches, in order of preference:

**Preferred: API-level delivery (no shell involvement).** If the chosen notification mechanism provides a programmatic API (e.g., a native library binding, a subprocess invoked with an argument vector rather than a shell string), use it. Pass `title` and `body` as discrete arguments or structured data. No sanitization of shell metacharacters is needed because no shell is involved.

**Acceptable: Shell-mediated delivery with strict escaping.** If the notification mechanism requires invoking a shell command (e.g., `osascript`):

1. **Never use string interpolation or template literals to construct the command string.** Never do `osascript -e "display notification \"${body}\""` or any equivalent.
2. **Use subprocess argument vectors.** Invoke the process with an argument array (e.g., Node.js `child_process.execFile` with arguments as array elements, Python `subprocess.run` with a list). The subprocess function must not invoke a shell. Specifically: no `shell: true`, no `sh -c`, no backtick execution.
3. **For AppleScript string literals:** If the notification mechanism is AppleScript (via `osascript`), the script must be constructed such that user input is passed as arguments to `osascript` via the `-` (stdin) mechanism or as positional arguments accessed via `on run argv`, never interpolated into the script text. If script-level string construction is unavoidable, apply the following escaping to both `title` and `body` before interpolation:
   - Replace every `\` with `\\`
   - Replace every `"` with `\"`
   - Replace every newline (`\n`) with `\n` (literal backslash-n in AppleScript string)
   - Replace every carriage return (`\r`) with `\r`
   - Replace every tab (`\t`) with `\t`
   - Strip or replace any characters outside the printable ASCII + common Unicode range that could be interpreted as control characters (U+0000–U+001F, U+007F, U+0080–U+009F), except for the whitespace characters handled above.
   - After escaping, the result is placed inside double quotes in the AppleScript source.
   - **Validation step:** After constructing the escaped string, verify it contains no unescaped double-quote characters. This is a defense-in-depth check; if it fires, it indicates a bug in the escaping logic. Abort the notification and return a delivery error.

4. **No additional execution pathways.** The sanitized input must only ever appear as a string literal in a notification display command. It must never be passed to `do shell script`, `run script`, `eval`, `exec`, or any other execution primitive.

### What Is Not Allowed

The following patterns are prohibited in any implementation, regardless of context:

- `eval()` or equivalent dynamic code execution with user input
- Shell string construction via concatenation or template literals
- `child_process.exec()` (Node.js) or `subprocess.run(..., shell=True)` (Python) with user-derived content
- Passing user input as part of a shell command string
- Using user input in any context where it could be interpreted as code, commands, or control sequences

---

## Notification Delivery Mechanism

The spec does not prescribe a specific delivery mechanism. The implementation may use any approach that satisfies these requirements:

1. **The notification is visible to the user.** It must appear as a system-level notification on macOS — either in Notification Center, as a banner, or as an alert. It must not be a terminal-only message, a log line, or a sound without visual content.
2. **The notification displays the `title` and `body` as provided (after any truncation).** The user must be able to read both fields.
3. **The mechanism is available on a default macOS installation or is bundled with the server.** The server must not require the user to install third-party notification tools unless those tools are included as dependencies of the server itself.
4. **The mechanism does not require elevated privileges.** No `sudo`, no accessibility permissions beyond what is available to a normal user process. (Note: macOS may require the user to grant notification permissions to the delivering application. This is acceptable and expected.)

### Known Viable Mechanisms

These are provided for implementer reference, not as requirements:

- **`osascript` with `display notification`.** Available on all macOS installations. Invoked as a subprocess. Notification appears attributed to "Script Editor" or "osascript" unless customized. Supports `with title` parameter.
- **`terminal-notifier`.** Third-party tool, installable via Homebrew. Richer notification features (actions, sounds, custom icons). Would need to be declared as a dependency or bundled.
- **Native bindings (e.g., `node-notifier`, `pync`).** Language-specific libraries that wrap macOS notification APIs. May pull in native dependencies.

The implementation should document which mechanism it chose and any setup requirements in user-facing documentation (README, not tool descriptions).

---

## MCP Server Configuration

### Transport

The server communicates over **stdio** (stdin/stdout). This is the standard transport for local MCP servers and is compatible with all known MCP clients.

### Server Metadata

| Field     | Value                       |
| --------- | --------------------------- |
| `name`    | `push-notification`         |
| `version` | Matches the package version |

### Capabilities

The server declares the `tools` capability. It does not declare `resources`, `prompts`, or any other MCP capability.

---

## Packaging

### As an MCPB Bundle

The server must be packageable as an MCP Bundle (`.mcpb` file) conforming to the MCPB manifest specification:

- **Manifest spec:** https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
- **CLI tooling (`mcpb init`, `mcpb pack`):** https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md
- **npm package:** `@anthropic-ai/mcpb`

As of writing (February 2026), the manifest specification version is `0.3`. The implementation must conform to this version at minimum and should target the latest available version at time of build.

The implementer is expected to read the MCPB specification directly. This NLSpec does not restate the MCPB manifest schema — it only specifies constraints specific to this server:

- `compatibility.platforms` must be `["darwin"]` (macOS only).
- `tools` must declare exactly one tool: `send_notification`. The tool description in the manifest must match the LLM-facing description specified in the Tool Interface section of this spec — no implementation details.
- `description` must not disclose the notification delivery mechanism.
- `user_config` must not be present. The server has no user-configurable secrets or required setup. Rate limiting env vars are operator-level configuration and must not appear in the manifest.
- **No System Data or PII:** The bundled artifact MUST NOT contain any local system data, personal identifiable information (PII), or absolute file paths pointing to the developer's machine. Specifically, `node_modules` must be entirely excluded from the `.mcpb` bundle (e.g., via `.mcpbignore`) because it often contains platform-specific binaries and shell scripts with hardcoded local paths. All dependencies should be compiled and bundled into a single standalone executable file (using a bundler like `esbuild` or `tsup`) prior to packing.

The project must be structured such that `mcpb pack` produces a valid `.mcpb` file without manual intervention. Include a `.mcpbignore` file if there are development artifacts that should be excluded from the bundle.

The implementation must include a `README.md` that contains, at minimum:

1. A one-line description of what the server does.
2. **A single copy-paste command that builds and packages the `.mcpb` file from a clean checkout.** This must be a single shell command using `&&` to chain the build and pack steps (e.g., `pnpm build && pnpx @anthropic-ai/mcpb pack .`). The exact command depends on the chosen language and build tool, but it must be one line, copy-pasteable, and must build before packing. This is the most important line in the README.
3. Installation instructions for both the MCPB and standalone use cases.
4. Environment variable reference for rate limiting configuration.

### As a Standalone MCP Server

The server must also be runnable as a standalone MCP server without the MCPB bundle. This means:

1. The server can be started directly from the command line (e.g., `node server.js` or `npx push-notification-mcp`).
2. MCP clients (Roo Code, Augment Code, etc.) can configure the server in their MCP settings by specifying the command and arguments.
3. The server does not depend on any MCPB-specific or Claude Desktop-specific runtime, API, or environment variable to function.

Example MCP client configuration (for documentation purposes):

```json
{
  "mcpServers": {
    "push-notification": {
      "command": "npx",
      "args": ["-y", "push-notification-mcp"]
    }
  }
}
```

The specific command and package name are implementation details. The above is illustrative.

The server is not currently published to any package registry. However, the implementation must be structured such that publishing (e.g., `npm publish` or `pip publish`) requires only adding registry credentials and running the publish command — no restructuring of the project. The `package.json` (or equivalent) should have a valid `name`, `version`, `description`, `main`/`bin`, and `license` field from the start.

---

## Language and Runtime

The spec does not prescribe a language. The implementation may use any language that:

1. Has a mature, well-maintained MCP SDK or can implement the MCP protocol directly.
2. Can invoke macOS system commands (for notification delivery).
3. Can be distributed as a single installable package (npm, pip, etc.).

Node.js/TypeScript with the `@modelcontextprotocol/sdk` package is the most common choice for MCP servers and has the broadest client compatibility. Additionally, the MCPB specification recommends Node.js because a Node.js runtime ships with Claude Desktop, meaning `server.type: "node"` bundles work without requiring users to install additional runtimes. This is noted as context, not as a requirement — the spec does not prescribe a language.

---

## Rate Limiting

The server enforces rate limiting on notification delivery. Rate limiting is an implementation detail — it must not be disclosed to the LLM via tool descriptions, error messages, or any other MCP-visible surface. From the LLM's perspective, a rate-limited notification simply failed to send.

### Algorithm

The server uses a **token bucket** rate limiter:

- The bucket has a **capacity** (maximum burst size). Each `send_notification` call consumes one token.
- Tokens **refill** at a fixed rate: one token per **refill interval**.
- When the bucket is empty (no tokens available), the notification is not sent.
- The bucket initializes full (at capacity) on server start.

This gives two properties: the caller can burst up to `capacity` notifications in rapid succession, and the sustained rate is capped at one notification per `refill_interval`.

### Defaults

| Parameter       | Default Value | Unit          |
| --------------- | ------------- | ------------- |
| Bucket capacity | 5             | notifications |
| Refill interval | 12000         | milliseconds  |

With these defaults: burst of 5 notifications, then sustained rate of ~5 per minute (one every 12 seconds). The bucket refills continuously — if the bucket has been idle for 60 seconds, it is full again.

### Configuration via Environment Variables

All rate limiting parameters are configurable via environment variables. This allows operators to tune behavior without modifying code.

| Environment Variable                     | Type    | Default | Description                                      |
| ---------------------------------------- | ------- | ------- | ------------------------------------------------ |
| `PUSH_NOTIFICATION_RATE_LIMIT_ENABLED`   | boolean | `true`  | Set to `false` to disable rate limiting entirely |
| `PUSH_NOTIFICATION_RATE_LIMIT_BURST`     | integer | `5`     | Token bucket capacity (max burst)                |
| `PUSH_NOTIFICATION_RATE_LIMIT_REFILL_MS` | integer | `12000` | Milliseconds between token refills               |

Boolean environment variables accept `true`/`1` as truthy and `false`/`0` as falsy (case-insensitive). Any other value is treated as the default.

Integer environment variables must be positive integers. Non-numeric, zero, or negative values are ignored and the default is used. The implementation should log a warning to stderr when an invalid value is encountered.

### Behavior When Rate Limited

When a notification is rate-limited:

1. The notification is **not sent**. It is silently dropped.
2. The tool returns the same generic error as a delivery failure: `"Failed to send notification."` with `isError: true`.
3. The response must not mention rate limiting, throttling, cooldown, or any hint that the failure is due to rate enforcement.
4. The server logs the rate limit event to stderr with diagnostic detail (e.g., `"Rate limited: bucket empty, next refill in Xms"`).

This is deliberate. The LLM cannot distinguish a rate-limited notification from a delivery failure, which prevents it from attempting to game or circumvent the rate limiter.

---

## What This Spec Does Not Cover

- **Notification actions (click handling, buttons, reply).** The notification is fire-and-forget. No callback, no action handling.
- **Notification grouping, threading, or deduplication.** Each call to `send_notification` produces one notification (subject to rate limiting).
- **Sound configuration.** The notification uses the system default sound behavior for the delivering application. The server does not configure sound.
- **Icon or image customization.** Not specified.
- **Queuing or persistence.** Notifications are sent immediately and are not stored by the server. Rate-limited notifications are dropped, not queued.
- **Non-macOS platforms.** This version targets macOS only. Cross-platform support is out of scope.

---

## Definition of Done

1. The MCP server starts, completes the MCP initialization handshake over stdio, and reports one tool (`send_notification`).
2. Calling `send_notification` with a valid `title` and `body` produces a visible macOS notification displaying both fields.
3. The tool description exposed via MCP contains no implementation details — no mention of macOS, AppleScript, osascript, or any delivery mechanism.
4. Calling `send_notification` with a missing `title` returns an MCP error with `isError: true`.
5. Calling `send_notification` with a missing `body` returns an MCP error with `isError: true`.
6. Calling `send_notification` with an empty (whitespace-only) `title` returns an MCP error.
7. Calling `send_notification` with an empty (whitespace-only) `body` returns an MCP error.
8. Calling `send_notification` with a `title` exceeding 256 characters sends the notification with a truncated title and includes a truncation note in the response.
9. Calling `send_notification` with a `body` exceeding 1024 characters sends the notification with a truncated body and includes a truncation note in the response.
10. Input containing shell metacharacters (`$`, `` ` ``, `"`, `\`, `|`, `;`, `&`, `(`, `)`, `{`, `}`, `<`, `>`, `!`, `~`, `*`, `?`, `[`, `]`, `#`, newlines) does not execute commands — it appears as literal text in the notification.
11. Input containing AppleScript injection attempts (e.g., `" & do shell script "malicious" & "`, `\n tell application "Finder" to delete`) does not execute injected code — it appears as literal text in the notification.
12. The server can be started as a standalone process and responds to MCP protocol messages over stdio.
13. Running `mcpb pack` on the project directory produces a valid `.mcpb` file that passes `mcpb validate`.
14. The `.mcpb` bundle's `manifest.json` declares exactly one tool (`send_notification`) with a description that contains no implementation details.
15. The server does not require `sudo`, root privileges, or accessibility permissions to send notifications (standard macOS notification permissions are acceptable).
16. The server logs diagnostic information (startup, errors) to stderr only, never to stdout (which is reserved for MCP protocol messages).
17. With rate limiting enabled (default), sending more than `PUSH_NOTIFICATION_RATE_LIMIT_BURST` notifications in rapid succession causes excess notifications to fail with the generic error `"Failed to send notification."` — no mention of rate limiting in the response.
18. Setting `PUSH_NOTIFICATION_RATE_LIMIT_ENABLED=false` disables rate limiting; all notifications are delivered regardless of frequency.
19. Setting `PUSH_NOTIFICATION_RATE_LIMIT_BURST` and `PUSH_NOTIFICATION_RATE_LIMIT_REFILL_MS` to custom values changes the rate limiting behavior accordingly.
20. Invalid environment variable values (non-numeric, negative) are ignored and defaults are used, with a warning logged to stderr.
21. The project is structured for future package registry publication without restructuring (valid package metadata, bin/main entry point).
22. The compiled `.mcpb` bundle does not contain any `node_modules` folders, absolute paths from the local system, or PII. The bundled artifact size is reasonably small due to efficient bundling.

---

## Appendix A: Design Decision Rationale

**Why one tool, not separate tools for different notification types?** The use case is simple alerting. A single tool with `title` and `body` covers all current needs. Adding complexity (urgency levels, categories, actions) is premature. The tool can be extended later by adding optional parameters without breaking existing callers.

**Why hide implementation details from the LLM?** Two reasons. First, the LLM doesn't need to know — it sends text, the user gets a notification. Second, disclosing the mechanism (e.g., "this uses AppleScript") invites the LLM to attempt mechanism-specific optimizations or workarounds, which increases the attack surface for injection.

**Why truncate instead of rejecting oversized input?** The primary goal is delivering the notification. A truncated notification is more useful than no notification. The truncation note in the response informs the LLM that content was lost, enabling it to adjust future calls if needed.

**Why `body` instead of `content`?** `content` is an overloaded term in MCP (it's a field in the response schema). Using `body` avoids confusion for implementers reading both the MCP spec and this spec.

**Why hide rate limiting from the LLM?** Rate limiting is a system protection mechanism. If the LLM knows the rate limits, it can (intentionally or through prompt injection) attempt to maximize notification throughput right up to the limit, or modify its behavior to work around the limiter. By making rate-limited failures indistinguishable from delivery failures, the server removes the LLM's ability to reason about or adapt to the rate limiter. The LLM's only correct response to "Failed to send notification" is to try again later or give up — which is the desired behavior regardless of the cause.

**Why token bucket instead of fixed window?** A fixed-window rate limiter (e.g., "10 per minute") has a boundary problem: a caller can send 10 notifications at 0:59 and 10 more at 1:01, achieving 20 in 2 seconds. Token bucket avoids this by making burst capacity explicit and independent of wall-clock boundaries. It also degrades gracefully — a caller that sends one notification every 15 seconds never hits the limiter, while a caller that bursts 5 at once then waits is also fine. The two behaviors a token bucket independently controls (burst tolerance and sustained rate) map cleanly to the two things an operator wants to tune.

**Why not publish to a registry initially?** The server is designed for personal/team use. Publishing adds maintenance burden (versioning, security advisories, support expectations). The project is structured for easy future publication if demand materializes, but the default posture is local-only.

---

## Appendix B: MCPB Reference Material

This appendix provides reference links for implementers working with the MCPB bundle format. These are external resources and may evolve independently of this spec.

### Specification and Tooling

- **MCPB Manifest Specification:** https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md — Authoritative spec for `manifest.json` fields, types, constraints, and variable substitution. Read this before writing the manifest.
- **MCPB CLI Documentation:** https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md — Documents `mcpb init` (scaffold a manifest interactively) and `mcpb pack` (produce a `.mcpb` from a directory). The CLI is published as `@anthropic-ai/mcpb` on npm.
- **MCPB Repository Root:** https://github.com/modelcontextprotocol/mcpb — README with goals, architecture overview, and the reference loader implementation (`src/index.ts`) used by Claude Desktop.

### Examples and Guides

- **Example Bundles:** https://github.com/modelcontextprotocol/mcpb/tree/main/examples — Reference MCPB bundles demonstrating manifest structure, server layout, and packaging conventions. Not production code, but useful for understanding the expected file layout.
- **Building Desktop Extensions (Claude Help Center):** https://support.claude.com/en/articles/12922929-building-desktop-extensions-with-mcpb — Tutorial-style walkthrough of building and packaging an MCPB extension.
- **Anthropic Engineering Blog — Desktop Extensions:** https://www.anthropic.com/engineering/desktop-extensions — Design rationale, open-sourcing context, and the goals behind the MCPB format.

The implementer is expected to read the MCPB specification directly. This appendix is a reference index, not a substitute for the source material.
