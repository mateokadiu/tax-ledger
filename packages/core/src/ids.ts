/**
 * UUIDv7 — time-ordered, monotonic-ish, sortable by createdAt.
 * RFC 9562 layout: 48-bit unix-ms timestamp, 4-bit version (7), 12-bit rand,
 * 2-bit variant, 62-bit rand.
 */
import { randomBytes } from 'node:crypto';

export function uuidv7(now: number = Date.now()): string {
  const ts = BigInt(now);
  const buf = randomBytes(10);

  const hex: string[] = [];
  // 48-bit timestamp (12 hex chars)
  hex.push(ts.toString(16).padStart(12, '0').slice(-12));

  // version 7 nibble + 12 bits of rand
  const r0 = (buf[0]! << 8) | buf[1]!;
  hex.push((0x7000 | (r0 & 0x0fff)).toString(16).padStart(4, '0'));

  // variant (10xx) + 14 bits of rand
  const r1 = (buf[2]! << 8) | buf[3]!;
  hex.push((0x8000 | (r1 & 0x3fff)).toString(16).padStart(4, '0'));

  // remaining 48 bits of rand
  let tail = '';
  for (let i = 4; i < 10; i++) tail += buf[i]!.toString(16).padStart(2, '0');
  hex.push(tail);

  return `${hex[0]!.slice(0, 8)}-${hex[0]!.slice(8, 12)}-${hex[1]}-${hex[2]}-${hex[3]}`;
}
