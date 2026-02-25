# push-notification-mcp

A local MCP server that sends push notifications on macOS. 

## Quick Start

```bash
pnpm install && pnpm run build && npx @anthropic-ai/mcpb pack .
```

Drag the `.mcpb` into Claude Desktop or any MCPB-compatible client of your choice.

## Specification


> NOTE: This project was generated from an NLSpec (included) and was wholey implemented (or "dark-complied") by a Claude model (code formatting not included).


An [NLSpec (as la the @TG-Techie flavor)](https://github.com/TG-Techie/NLSpec-Spec) is a prescriptive, generative specification written in natural language — precise enough to derive a faithful implementation from, flexible enough to leave genuine implementation choices to the builder. For background on the approach, see the [strongdm/attractor](https://github.com/strongdm/attractor) repo where the concept was developed in practice.

## How It Works

The server exposes a single MCP tool — `send_notification` — over stdio. When called, it delivers a native macOS notification displaying a title and body. The notification mechanism is `osascript` with `display notification`, invoked via `execFile` (no shell). User input is passed as argv to the AppleScript `on run argv` handler — never interpolated into script text.

## Installation

### As an MCPB Bundle

Build and pack:

```bash
pnpm install && pnpm run build && npx @anthropic-ai/mcpb pack .
```

This produces a `.mcpb` file you can install in Claude Desktop or any MCPB-compatible client.

### As a Standalone MCP Server

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "push-notification": {
      "command": "node",
      "args": ["/absolute/path/to/push-notification-mcp/dist/index.js"]
    }
  }
}
```

Or if published to npm:

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

### Run Directly

```bash
npm install
npm run build
node dist/index.js
```

The server communicates over stdio (stdin/stdout). Diagnostic logs go to stderr.

## Environment Variables

All configuration is optional. The server works out of the box with sensible defaults.

| Variable                                 | Type    | Default | Description                                    |
| ---------------------------------------- | ------- | ------- | ---------------------------------------------- |
| `PUSH_NOTIFICATION_RATE_LIMIT_ENABLED`   | boolean | `true`  | Set to `false` or `0` to disable rate limiting |
| `PUSH_NOTIFICATION_RATE_LIMIT_BURST`     | integer | `5`     | Token bucket capacity (max burst)              |
| `PUSH_NOTIFICATION_RATE_LIMIT_REFILL_MS` | integer | `12000` | Milliseconds between token refills             |

Boolean values accept `true`/`1` (truthy) and `false`/`0` (falsy), case-insensitive. Integer values must be positive; invalid values are ignored and defaults are used, with a warning logged to stderr.

With defaults: burst of 5 notifications, then sustained rate of ~5 per minute (one every 12 s). The bucket refills continuously — idle for 60 s and it's full again.

## Platform

macOS only. The notification delivery mechanism (`osascript display notification`) is available on all default macOS installations. macOS may prompt you to allow notifications from "Script Editor" — this is expected.

## License

MIT
