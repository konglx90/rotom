/**
 * E2ED Retry — Transient failure handling with exponential backoff.
 */

import type { RetryConfig } from './types.js';

const RETRYABLE_PATTERNS = [
  /timeout/i,
  /network/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /rate.?limit/i,
  /429/,
  /OOM/i,
  /out of memory/i,
  /SIGKILL/i,
  /SIGTERM/i,
  /crash/i,
  /agent.*not found/i,
  /temporarily unavailable/i,
];

const NON_RETRYABLE_PATTERNS = [
  /ENOENT.*working directory/i,
  /permission denied/i,
  /EACCES/i,
  /not found.*requirement/i,
  /no plan available/i,
  /no code delivery found/i,
];

/** Check if an error message indicates a retryable (transient) failure. */
export function isRetryable(error: string): boolean {
  if (!error) return false;

  // Check non-retryable first (higher priority)
  for (const pattern of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(error)) return false;
  }

  for (const pattern of RETRYABLE_PATTERNS) {
    if (pattern.test(error)) return true;
  }

  // Default: not retryable for unknown errors
  return false;
}

/** Calculate delay for attempt N with exponential backoff and jitter. */
export function retryDelay(attempt: number, config?: RetryConfig): number {
  const cfg = config ?? defaultRetryConfig();
  const baseDelay = cfg.baseDelayMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(baseDelay, cfg.maxDelayMs);
  // Add jitter: random 0-25% of delay
  const jitter = cappedDelay * Math.random() * 0.25;
  return Math.floor(cappedDelay + jitter);
}

/** Default retry configuration. */
export function defaultRetryConfig(): Required<RetryConfig> {
  return {
    maxRetries: 2,
    baseDelayMs: 5000,
    maxDelayMs: 60000,
  };
}
