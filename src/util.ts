/**
 * Small readers reimplemented once per module.
 *
 * `readString`, `readNumber` and `isPlainObject` each existed in two or three
 * files with identical bodies. Identical is the good case: `toStringId` had
 * drifted, and one path accepted an id the other rejected (finding A12-05).
 * Nothing here is clever; the point is that there is one of each.
 */

/** A non-empty trimmed string, or nothing. */
export function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** A finite number, from a number or from its decimal spelling. */
export function readNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** An object that is not an array and not null — a config or params bag. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
