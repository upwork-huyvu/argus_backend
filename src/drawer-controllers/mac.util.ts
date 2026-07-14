/**
 * MAC normalization for drawer controllers — see docs/ESP32_DEVICE_MVP_PLAN.md §4.1.
 * Uppercase, strip `:`/`-`/whitespace, require exactly 12 hex chars.
 */

const MAC_RE = /^[0-9A-F]{12}$/;

/** Returns the normalized MAC, or null if it is not a valid 12-hex identifier. */
export function normalizeMac(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[\s:-]/g, "").toUpperCase();
  return MAC_RE.test(cleaned) ? cleaned : null;
}
