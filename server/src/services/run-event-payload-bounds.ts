const MAX_STRING_CHARS = 16 * 1024;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 6;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function truncate(value: string) {
  if (value.length <= MAX_STRING_CHARS) return value;
  return `${value.slice(0, MAX_STRING_CHARS)}\n[truncated ${value.length - MAX_STRING_CHARS} chars]`;
}

function bound(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return truncate(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return { _truncated: true, type: "array", originalLength: value.length };
    const out = value.slice(0, MAX_ARRAY_ITEMS).map((entry) => bound(entry, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) out.push({ _truncated: true, omittedItems: value.length - MAX_ARRAY_ITEMS });
    return out;
  }
  if (typeof value !== "object" || value === undefined) return null;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const entries = Object.entries(value as Record<string, unknown>);
  if (depth >= MAX_DEPTH) {
    const out = { _truncated: true, type: "object", keys: entries.map(([key]) => key).slice(0, 20) };
    seen.delete(value);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of entries.slice(0, MAX_OBJECT_KEYS)) out[key] = bound(entry, depth + 1, seen);
  if (entries.length > MAX_OBJECT_KEYS) {
    out._truncated = true;
    out._omittedKeys = entries.length - MAX_OBJECT_KEYS;
  }
  seen.delete(value);
  return out;
}

export function boundHeartbeatRunEventPayloadForStorage(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return object(bound(payload, 0, new WeakSet())) ?? { _truncated: true };
}
