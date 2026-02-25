/**
 * Environment-driven configuration for rate limiting.
 *
 * Boolean env vars: "true"/"1" → true, "false"/"0" → false (case-insensitive).
 * Integer env vars: positive integers only; anything else uses default + stderr warning.
 */

function parseBoolean(
  envVar: string,
  defaultValue: boolean
): boolean {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") return defaultValue;

  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;

  // Any other value → default.
  return defaultValue;
}

function parsePositiveInt(
  envVar: string,
  defaultValue: number
): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") return defaultValue;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    process.stderr.write(
      `[push-notification] Warning: invalid value for ${envVar}="${raw}", using default ${defaultValue}\n`
    );
    return defaultValue;
  }
  return parsed;
}

export interface RateLimitConfig {
  enabled: boolean;
  burst: number;
  refillMs: number;
}

export function loadRateLimitConfig(): RateLimitConfig {
  return {
    enabled: parseBoolean("PUSH_NOTIFICATION_RATE_LIMIT_ENABLED", true),
    burst: parsePositiveInt("PUSH_NOTIFICATION_RATE_LIMIT_BURST", 5),
    refillMs: parsePositiveInt("PUSH_NOTIFICATION_RATE_LIMIT_REFILL_MS", 12000),
  };
}
