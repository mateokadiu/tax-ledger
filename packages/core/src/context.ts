import { uuidv7 } from './ids.js';

/**
 * Injectable side-effects for ledger-producing operations. Pass deterministic
 * implementations to make `split`/`refund`/`revise`/`partialCapture` pure and
 * replay-stable (e.g. snapshot tests, event-sourced replays); omit for the
 * default real clock + UUIDv7.
 */
export interface LedgerOptions {
  /** Timestamp source for emitted rows. Default: `() => new Date()`. */
  now?: () => Date;
  /** Id generator for emitted rows. Default: {@link uuidv7}. */
  generateId?: () => string;
}

export interface ResolvedContext {
  /** A single ISO-8601 timestamp shared by every row of one operation. */
  readonly createdAt: string;
  /** Pull the next row id. */
  nextId: () => string;
}

/**
 * Resolve a {@link LedgerOptions} bag into a concrete context. `createdAt` is
 * sampled once so every row emitted by a single operation shares a timestamp.
 */
export function resolveContext(opts?: LedgerOptions): ResolvedContext {
  const now = opts?.now ?? (() => new Date());
  const nextId = opts?.generateId ?? uuidv7;
  return { createdAt: now().toISOString(), nextId };
}
