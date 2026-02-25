#!/usr/bin/env node

/**
 * Push Notification MCP Server.
 *
 * Exposes a single tool — send_notification — that delivers a visual
 * notification to the user. Communicates over stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { sendNotification } from "./notify.js";
import { TokenBucketRateLimiter } from "./rate-limiter.js";
import { loadRateLimitConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TITLE_MAX_LENGTH = 256;
const BODY_MAX_LENGTH = 1024;

const rateLimitConfig = loadRateLimitConfig();

const rateLimiter: TokenBucketRateLimiter | null = rateLimitConfig.enabled
  ? new TokenBucketRateLimiter(rateLimitConfig.burst, rateLimitConfig.refillMs)
  : null;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate and prepare the title/body fields.
 *
 * Returns either a validation error string, or an object with the
 * (possibly truncated) values and any truncation notes.
 */
function validateAndPrepare(args: Record<string, unknown>): {
  error?: string;
  title?: string;
  body?: string;
  notes?: string[];
} {
  const { title, body } = args;

  // Type checks
  if (title !== undefined && typeof title !== "string") {
    return { error: '"title" must be a string' };
  }
  if (body !== undefined && typeof body !== "string") {
    return { error: '"body" must be a string' };
  }

  // Presence checks
  if (title === undefined || title === null) {
    return { error: '"title" is required' };
  }
  if (body === undefined || body === null) {
    return { error: '"body" is required' };
  }

  const titleStr = title as string;
  const bodyStr = body as string;

  // Empty-after-trim checks
  if (titleStr.trim().length === 0) {
    return { error: '"title" must not be empty' };
  }
  if (bodyStr.trim().length === 0) {
    return { error: '"body" must not be empty' };
  }

  // Truncation
  const notes: string[] = [];
  let finalTitle = titleStr;
  let finalBody = bodyStr;

  if (titleStr.length > TITLE_MAX_LENGTH) {
    notes.push(
      `Note: title was truncated from ${titleStr.length} to ${TITLE_MAX_LENGTH} characters.`
    );
    finalTitle = titleStr.slice(0, TITLE_MAX_LENGTH);
  }

  if (bodyStr.length > BODY_MAX_LENGTH) {
    notes.push(
      `Note: body was truncated from ${bodyStr.length} to ${BODY_MAX_LENGTH} characters.`
    );
    finalBody = bodyStr.slice(0, BODY_MAX_LENGTH);
  }

  return { title: finalTitle, body: finalBody, notes };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "push-notification",
  version: "0.1.0",
});

server.registerTool(
  "send_notification",
  {
    title: "Send Notification",
    description:
      "Send a push notification to the user. Use this to alert the user when a long-running task completes, when input is needed, or when something requires their attention.",
    inputSchema: {
      title: z
        .string()
        .describe(
          "Short notification title. Typically identifies the context: branch name, workspace name, project name, or repository name."
        ),
      body: z
        .string()
        .describe(
          "Notification body text. Describes what happened or what the user needs to know."
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (args: { title: string; body: string }) => {
    // -----------------------------------------------------------------------
    // Manual validation layer — the spec defines specific error messages and
    // truncation behavior that go beyond what Zod schema enforcement provides.
    // The Zod schema above handles the MCP-level type contract; this layer
    // implements the spec's behavioral requirements.
    // -----------------------------------------------------------------------
    const result = validateAndPrepare(args as Record<string, unknown>);

    if (result.error) {
      return {
        content: [{ type: "text" as const, text: result.error }],
        isError: true,
      };
    }

    const { title, body, notes } = result as {
      title: string;
      body: string;
      notes: string[];
    };

    // Rate limiting
    if (rateLimiter) {
      const bucket = rateLimiter.consume();
      if (!bucket.allowed) {
        process.stderr.write(
          `[push-notification] Rate limited: bucket empty, next refill in ${bucket.nextRefillMs}ms\n`
        );
        return {
          content: [
            { type: "text" as const, text: "Failed to send notification." },
          ],
          isError: true,
        };
      }
    }

    // Deliver notification
    try {
      await sendNotification(title, body);
    } catch {
      return {
        content: [
          { type: "text" as const, text: "Failed to send notification." },
        ],
        isError: true,
      };
    }

    // Success response
    let responseText = "Notification sent.";
    if (notes && notes.length > 0) {
      responseText += " " + notes.join(" ");
    }

    return {
      content: [{ type: "text" as const, text: responseText }],
    };
  }
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stderr.write("[push-notification] Starting MCP server over stdio\n");

  if (rateLimitConfig.enabled) {
    process.stderr.write(
      `[push-notification] Rate limiting: burst=${rateLimitConfig.burst}, refill=${rateLimitConfig.refillMs}ms\n`
    );
  } else {
    process.stderr.write("[push-notification] Rate limiting: disabled\n");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write("[push-notification] Server ready\n");
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[push-notification] Fatal: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
