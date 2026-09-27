import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

type JsonRecord = Record<string, unknown>;
type EvidenceStatus = "partial" | "unavailable";
type SchemaShape = {
  type: string[];
  required: string[];
  properties: string[];
  hasItems: boolean;
  variants: string[];
  additionalProperties: boolean | null;
  enumCount: number | null;
};

export type CodexRolloutCompletionEvidence = {
  schema: "paperclip.codex-rollout-completion-evidence.v1";
  status: EvidenceStatus;
  source: "codex_rollout_session";
  sessionId: string | null;
  /** Codex stores only dynamic tool declarations here, never the full built-in tool surface. */
  toolSchemaCoverage: "dynamic_tools_only_partial";
  rollout: null | {
    fileName: string;
    sha256: string;
    bytes: number;
    sessionBinding: "session_meta.payload.session_id";
    fieldProvenance: { model: "turn_context"; effort: "turn_context"; dynamicTools: "session_meta" };
    models: string[];
    effort: string[];
    effortStatus: "available" | "unavailable";
    dynamicToolSchemaStatus: "available" | "unavailable";
    dynamicTools: Array<{ name: string; inputSchemaShape: SchemaShape | null; inputSchemaShapeSha256: string | null }>;
    malformedRecordCount: number;
  };
  parseGaps: string[];
};
type DynamicTool = NonNullable<CodexRolloutCompletionEvidence["rollout"]>["dynamicTools"][number];

const SESSION_ID_RE = /^[A-Za-z0-9-]{1,200}$/;
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:/-]{0,200}$/;
const PROPERTY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:/-]{0,128}$/;
const VALUE_RE = /^[A-Za-z0-9_.:/@-]{1,200}$/;
const MAX_ROLLOUT_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_DEPTH = 4;
const MAX_DIRECTORY_ENTRIES = 2_000;
const MAX_DYNAMIC_TOOLS = 50;
const SCHEMA_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function valueString(value: unknown): string | null {
  return typeof value === "string" && VALUE_RE.test(value) ? value : null;
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function regularFileInside(root: string, candidate: string) {
  const details = await lstat(candidate).catch(() => null);
  if (!details || !details.isFile() || details.isSymbolicLink()) return false;
  const resolved = await realpath(candidate).catch(() => null);
  return resolved !== null && inside(root, resolved);
}

function safeStringArray(value: unknown, allowed: RegExp, limit: number) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && allowed.test(entry)))]
    .sort((left, right) => left.localeCompare(right)).slice(0, limit);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = record(value);
  if (item) return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function schemaShape(value: unknown): SchemaShape | null {
  const schema = record(value);
  if (!schema) return null;
  const type = safeStringArray(Array.isArray(schema.type) ? schema.type : [schema.type], /^[a-z]+$/, 8)
    .filter((entry) => SCHEMA_TYPES.has(entry));
  const properties = record(schema.properties);
  return {
    type,
    required: safeStringArray(schema.required, PROPERTY_NAME_RE, 100),
    properties: Object.keys(properties ?? {}).filter((name) => PROPERTY_NAME_RE.test(name)).sort().slice(0, 100),
    hasItems: record(schema.items) !== null,
    variants: ["oneOf", "anyOf", "allOf"].filter((key) => Array.isArray(schema[key])),
    additionalProperties: typeof schema.additionalProperties === "boolean" ? schema.additionalProperties : null,
    enumCount: Array.isArray(schema.enum) ? Math.min(schema.enum.length, 100) : null,
  };
}

async function findRollout(root: string, sessionId: string): Promise<{ path: string | null; reason: string | null }> {
  const sessionsRoot = path.join(root, "sessions");
  const sessionsRealpath = await realpath(sessionsRoot).catch(() => null);
  if (!sessionsRealpath || !inside(root, sessionsRealpath)) return { path: null, reason: "codex_sessions_dir_unavailable" };
  const suffix = `-${sessionId}.jsonl`;
  const matches: string[] = [];
  let scanned = 0;
  async function visit(dir: string, depth: number): Promise<void> {
    if (matches.length > 1 || scanned >= MAX_DIRECTORY_ENTRIES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (++scanned > MAX_DIRECTORY_ENTRIES) return;
      const candidate = path.join(dir, entry.name);
      if (entry.isFile() && !entry.isSymbolicLink() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) {
        if (await regularFileInside(root, candidate)) matches.push(candidate);
      }
    }
    if (depth >= MAX_SCAN_DEPTH) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path.join(dir, entry.name), depth + 1);
    }
  }
  await visit(sessionsRealpath, 0);
  if (scanned >= MAX_DIRECTORY_ENTRIES) return { path: null, reason: "codex_session_scan_bound_exceeded" };
  if (matches.length !== 1) return { path: null, reason: matches.length === 0 ? "codex_rollout_unavailable" : "codex_rollout_ambiguous" };
  return { path: matches[0]!, reason: null };
}

async function readBoundedSnapshot(fileName: string): Promise<{ contents: string; bytes: number; sha256: string } | null> {
  const handle = await open(fileName, "r").catch(() => null);
  if (!handle) return null;
  try {
    const before = await handle.stat();
    if (before.size > MAX_ROLLOUT_BYTES) return null;
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) return null;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null;
    return {
      contents: bytes.toString("utf8"),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

export async function captureCodexRolloutCompletionEvidence(input: {
  codexHome: string | null | undefined;
  sessionId: string | null | undefined;
  unavailableReason?: string;
}): Promise<CodexRolloutCompletionEvidence> {
  const sessionId = valueString(input.sessionId);
  const unavailable = (reason: string): CodexRolloutCompletionEvidence => ({
    schema: "paperclip.codex-rollout-completion-evidence.v1", status: "unavailable", source: "codex_rollout_session",
    sessionId, toolSchemaCoverage: "dynamic_tools_only_partial", rollout: null, parseGaps: [reason],
  });
  if (input.unavailableReason) return unavailable(input.unavailableReason);
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return unavailable("invalid_session_id");
  if (!input.codexHome) return unavailable("codex_home_unavailable");
  const root = await realpath(input.codexHome).catch(() => null);
  if (!root) return unavailable("codex_home_missing");
  const found = await findRollout(root, sessionId);
  if (!found.path) return unavailable(found.reason ?? "codex_rollout_unavailable");
  const snapshot = await readBoundedSnapshot(found.path);
  if (!snapshot) return unavailable("codex_rollout_snapshot_unavailable_or_changed");

  const rows: JsonRecord[] = [];
  let malformedRecordCount = 0;
  for (const line of snapshot.contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = record(JSON.parse(line));
      if (row) rows.push(row); else malformedRecordCount += 1;
    } catch { malformedRecordCount += 1; }
  }
  const sessionMetas = rows.filter((row) => row.type === "session_meta");
  const matchingMetas = sessionMetas.filter((row) => valueString(record(row.payload)?.session_id) === sessionId);
  if (matchingMetas.length !== 1 || sessionMetas.length !== 1) return unavailable("codex_rollout_session_meta_mismatch_or_conflict");

  const models = new Set<string>();
  const effort = new Set<string>();
  const tools = new Map<string, DynamicTool>();
  const parseGaps = ["builtin_tool_schema_not_in_rollout_dynamic_tools"];
  for (const row of rows) {
    const payload = record(row.payload);
    if (!payload) continue;
    if (row.type === "turn_context") {
      const model = valueString(payload.model);
      const selectedEffort = valueString(payload.effort);
      if (model) models.add(model);
      if (selectedEffort) effort.add(selectedEffort);
      continue;
    }
    if (row.type !== "session_meta" || valueString(payload.session_id) !== sessionId || !Array.isArray(payload.dynamic_tools)) continue;
    for (const candidate of payload.dynamic_tools) {
      if (tools.size >= MAX_DYNAMIC_TOOLS) break;
      const tool = record(candidate);
      const name = valueString(tool?.name);
      if (!name || !TOOL_NAME_RE.test(name)) continue;
      const inputSchemaShape = schemaShape(tool?.inputSchema);
      const entry: DynamicTool = {
        name,
        inputSchemaShape,
        inputSchemaShapeSha256: inputSchemaShape ? createHash("sha256").update(canonicalJson(inputSchemaShape)).digest("hex") : null,
      };
      const previous = tools.get(name);
      if (previous && previous.inputSchemaShapeSha256 !== entry.inputSchemaShapeSha256) {
        tools.set(name, { name, inputSchemaShape: null, inputSchemaShapeSha256: null });
        parseGaps.push(`codex_rollout_dynamic_tool_schema_conflict:${name}`);
      } else if (!previous) tools.set(name, entry);
    }
  }
  if (malformedRecordCount > 0) parseGaps.push("codex_rollout_malformed_records");
  if (effort.size === 0) parseGaps.push("codex_rollout_effort_unavailable");
  if (effort.size > 1) parseGaps.push("codex_rollout_effort_conflict");
  if (models.size > 1) parseGaps.push("codex_rollout_model_conflict");
  if (tools.size === 0) parseGaps.push("codex_rollout_dynamic_tools_unavailable");
  if (tools.size >= MAX_DYNAMIC_TOOLS) parseGaps.push("codex_rollout_dynamic_tools_truncated");
  return {
    schema: "paperclip.codex-rollout-completion-evidence.v1", status: "partial", source: "codex_rollout_session",
    sessionId, toolSchemaCoverage: "dynamic_tools_only_partial",
    rollout: {
      fileName: path.basename(found.path), sha256: snapshot.sha256, bytes: snapshot.bytes,
      sessionBinding: "session_meta.payload.session_id",
      fieldProvenance: { model: "turn_context", effort: "turn_context", dynamicTools: "session_meta" },
      models: [...models].sort(), effort: [...effort].sort(), effortStatus: effort.size ? "available" : "unavailable",
      dynamicToolSchemaStatus: tools.size ? "available" : "unavailable", dynamicTools: [...tools.values()].sort((left, right) => left.name.localeCompare(right.name)), malformedRecordCount,
    },
    parseGaps: [...new Set(parseGaps)].sort(),
  };
}
