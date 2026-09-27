import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

type JsonRecord = Record<string, unknown>;
type EvidenceStatus = "available" | "unavailable" | "partial";
type ToolSchemaShape = {
  type: string[];
  required: string[];
  properties: Record<string, ToolSchemaShape>;
  items: ToolSchemaShape | null;
  variants: ToolSchemaShape[];
  additionalProperties: boolean | null;
  enumCount: number | null;
};
type TranscriptTraceRecord = {
  fileName: string;
  fileSha256: string;
  role: "parent" | "child";
  line: number;
  recordType: string | null;
  timestamp: string;
  model: string | null;
  effort: string | null;
  /** Safe schema identifiers only; tool names and schema bodies stay out of the trace. */
  toolSchemaHashes: string[];
};
type TraceCollector = {
  records: TranscriptTraceRecord[];
  addGap: (gap: string) => void;
};

export type ClaudeTranscriptCompletionEvidence = {
  schema: "paperclip.claude-transcript-completion-evidence.v1";
  status: EvidenceStatus;
  source: "claude_config_transcript";
  sessionId: string | null;
  /** Safe structural projection: never descriptions, defaults, examples, or enum values. */
  toolSchemaProjection: "prompt_snapshot_safe_structure.v1";
  attempt: {
    startedAt: string | null;
    resumed: boolean;
  };
  /** Bounded transcript-derived evidence, never a raw provider wire trace. */
  transcriptTrace: {
    schema: "paperclip.claude-sanitized-transcript-trace.v1";
    status: "partial" | "unavailable";
    scope: "timestamped_records_at_or_after_attempt_start";
    ordering: "source_file_then_line";
    records: TranscriptTraceRecord[];
    recordSetSha256: string | null;
    parseGaps: string[];
  };
  files: Array<{
    role: "parent" | "child";
    fileName: string;
    sha256: string;
    bytes: number;
    models: string[];
    /** Raw top-level transcript field, never a requested or configured effort. */
    effort: string[];
    effortStatus: "available" | "unavailable";
    toolSchemaStatus: "available" | "unavailable";
    promptSnapshotTools: Array<{
      timestamp: string | null;
      tools: Array<{
        name: string;
        inputSchemaShape: ToolSchemaShape | null;
        inputSchemaShapeSha256: string | null;
      }>;
    }>;
    malformedRecordCount: number;
  }>;
  parseGaps: string[];
};

const SESSION_ID_RE = /^[A-Za-z0-9-]{1,200}$/;
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:/-]{0,200}$/;
const STRUCTURAL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:/-]{0,128}$/;
const SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_PROPERTIES = 100;
const MAX_SCHEMA_VARIANTS = 20;
const MAX_TRACE_RECORDS = 32;
const MAX_TRACE_SCHEMA_HASHES = 16;
const VALUE_RE = /^[A-Za-z0-9_.:/@-]{1,200}$/;
const OFFSET_TIMESTAMP_RE = /(?:Z|[+-]\d{2}:\d{2})$/;

function object(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeValue(value: unknown): string | null {
  const result = string(value);
  return result && VALUE_RE.test(result) ? result : null;
}

function timestamp(value: unknown): string | null {
  const result = string(value);
  return result && OFFSET_TIMESTAMP_RE.test(result) && Number.isFinite(Date.parse(result))
    ? result
    : null;
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

async function regularFileInside(root: string, candidate: string): Promise<boolean> {
  const stat = await lstat(candidate).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return false;
  const resolved = await realpath(candidate).catch(() => null);
  return resolved !== null && isInside(root, resolved);
}

function stringValues(value: unknown) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter((entry): entry is string =>
    typeof entry === "string" && SCHEMA_TYPES.has(entry),
  ))].sort((left, right) => left.localeCompare(right));
}

function schemaShape(value: unknown, depth = 0): ToolSchemaShape | null {
  const schema = object(value);
  if (!schema || depth > MAX_SCHEMA_DEPTH) return null;
  const properties = object(schema.properties);
  const propertyEntries = Object.entries(properties ?? {})
    .filter(([name]) => STRUCTURAL_NAME_RE.test(name))
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_SCHEMA_PROPERTIES);
  const required = Array.isArray(schema.required)
    ? schema.required
      .filter((name): name is string =>
        typeof name === "string" && STRUCTURAL_NAME_RE.test(name),
      )
      .sort((left, right) => left.localeCompare(right))
      .slice(0, MAX_SCHEMA_PROPERTIES)
    : [];
  const variants = ["oneOf", "anyOf", "allOf"]
    .flatMap((key) => Array.isArray(schema[key]) ? schema[key] : [])
    .slice(0, MAX_SCHEMA_VARIANTS)
    .map((variant) => schemaShape(variant, depth + 1))
    .filter((variant): variant is ToolSchemaShape => variant !== null);
  const additionalProperties = typeof schema.additionalProperties === "boolean"
    ? schema.additionalProperties
    : null;

  return {
    type: stringValues(schema.type),
    required: [...new Set(required)],
    properties: Object.fromEntries(
      propertyEntries.flatMap(([name, child]) => {
        const shape = schemaShape(child, depth + 1);
        return shape ? [[name, shape]] : [];
      }),
    ),
    items: schemaShape(schema.items, depth + 1),
    variants,
    additionalProperties,
    // Enum values can be task-derived strings. The count proves its presence
    // without retaining those values.
    enumCount: Array.isArray(schema.enum)
      ? Math.min(schema.enum.length, MAX_SCHEMA_PROPERTIES)
      : null,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = object(value);
  if (record) {
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function promptSnapshotToolEntries(record: JsonRecord) {
  const snapshot = object(record.prompt_snapshot);
  const tools = Array.isArray(snapshot?.tools) ? snapshot.tools : null;
  if (!tools) return null;
  return tools.flatMap((value) => {
    const tool = object(value);
    const name = string(tool?.name);
    if (!name || !TOOL_NAME_RE.test(name)) return [];
    const inputSchemaShape = schemaShape(tool?.input_schema);
    return [{
      name,
      inputSchemaShape,
      inputSchemaShapeSha256: inputSchemaShape
        ? createHash("sha256").update(canonicalJson(inputSchemaShape)).digest("hex")
        : null,
    }];
  });
}

function inspectTranscript(
  contents: string,
  role: "parent" | "child",
  fileName: string,
  attemptStartedAt: number | null,
  trace: TraceCollector,
): ClaudeTranscriptCompletionEvidence["files"][number] {
  const models = new Set<string>();
  const effort = new Set<string>();
  const promptSnapshotTools: Array<{
    timestamp: string | null;
    tools: Array<{
      name: string;
      inputSchemaShape: ToolSchemaShape | null;
      inputSchemaShapeSha256: string | null;
    }>;
  }> = [];
  let malformedRecordCount = 0;

  const sha256 = createHash("sha256").update(contents).digest("hex");
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record: JsonRecord | null = null;
    try {
      record = object(JSON.parse(line));
    } catch {
      malformedRecordCount += 1;
      continue;
    }
    if (!record) {
      malformedRecordCount += 1;
      continue;
    }
    const message = object(record.message);
    const model = safeValue(message?.model);
    const selectedEffort = safeValue(record.effort);
    const tools = promptSnapshotToolEntries(record);
    const toolSchemaHashes = (tools ?? [])
      .map((tool) => tool.inputSchemaShapeSha256)
      .filter((hash): hash is string => hash !== null);
    if (!model && !selectedEffort && toolSchemaHashes.length === 0) continue;
    const recordTimestamp = timestamp(record.timestamp);
    if (recordTimestamp === null) {
      trace.addGap("trace_record_timestamp_unavailable");
      continue;
    }
    if (attemptStartedAt === null || Date.parse(recordTimestamp) < attemptStartedAt) {
      trace.addGap("trace_record_before_attempt_excluded");
      continue;
    }
    if (model) models.add(model);
    if (selectedEffort) effort.add(selectedEffort);
    if (tools) promptSnapshotTools.push({ timestamp: recordTimestamp, tools });
    if (toolSchemaHashes.length > MAX_TRACE_SCHEMA_HASHES) {
      trace.addGap("trace_schema_hash_projection_truncated");
    }
    if (trace.records.length >= MAX_TRACE_RECORDS) {
      trace.addGap("trace_record_projection_truncated");
      continue;
    }
    trace.records.push({
      fileName,
      fileSha256: sha256,
      role,
      line: index + 1,
      recordType: safeValue(record.type),
      timestamp: recordTimestamp,
      model,
      effort: selectedEffort,
      toolSchemaHashes: toolSchemaHashes.slice(0, MAX_TRACE_SCHEMA_HASHES),
    });
  }

  return {
    role,
    fileName,
    sha256,
    bytes: Buffer.byteLength(contents),
    models: [...models].sort((left, right) => left.localeCompare(right)),
    effort: [...effort].sort((left, right) => left.localeCompare(right)),
    effortStatus: effort.size > 0 ? "available" : "unavailable",
    toolSchemaStatus: promptSnapshotTools.some((snapshot) => snapshot.tools.length > 0)
      ? "available"
      : "unavailable",
    promptSnapshotTools,
    malformedRecordCount,
  };
}

async function findParentTranscript(
  projectsRoot: string,
  sessionId: string,
  maxDepth = 5,
): Promise<string | null> {
  async function visit(dir: string, depth: number): Promise<string | null> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === `${sessionId}.jsonl`) return candidate;
    }
    if (depth >= maxDepth) return null;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const found = await visit(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  }
  return visit(projectsRoot, 0);
}

export async function captureClaudeTranscriptCompletionEvidence(input: {
  configDir: string | null | undefined;
  sessionId: string | null | undefined;
  attemptStartedAt: string | null | undefined;
  resumed: boolean;
}): Promise<ClaudeTranscriptCompletionEvidence> {
  const sessionId = string(input.sessionId);
  const attemptStartedAt = timestamp(input.attemptStartedAt);
  const attemptStartedAtMs = attemptStartedAt === null ? null : Date.parse(attemptStartedAt);
  const unavailable = (reason: string): ClaudeTranscriptCompletionEvidence => ({
    schema: "paperclip.claude-transcript-completion-evidence.v1",
    status: "unavailable",
    source: "claude_config_transcript",
    sessionId,
    toolSchemaProjection: "prompt_snapshot_safe_structure.v1",
    attempt: { startedAt: attemptStartedAt, resumed: input.resumed },
    transcriptTrace: {
      schema: "paperclip.claude-sanitized-transcript-trace.v1",
      status: "unavailable",
      scope: "timestamped_records_at_or_after_attempt_start",
      ordering: "source_file_then_line",
      records: [],
      recordSetSha256: null,
      parseGaps: [reason],
    },
    files: [],
    parseGaps: [reason],
  });
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return unavailable("invalid_session_id");
  if (attemptStartedAtMs === null) return unavailable("attempt_start_unavailable");
  const configDir = string(input.configDir);
  if (!configDir) return unavailable("claude_config_dir_unavailable");
  const configRoot = await realpath(configDir).catch(() => null);
  if (!configRoot) return unavailable("claude_config_dir_missing");
  const projectsRoot = path.join(configRoot, "projects");
  const parent = await findParentTranscript(projectsRoot, sessionId);
  if (!parent || !await regularFileInside(configRoot, parent)) {
    return unavailable("parent_transcript_unavailable");
  }

  const files: ClaudeTranscriptCompletionEvidence["files"] = [];
  const parseGaps: string[] = [];
  const traceGaps: string[] = [];
  const addTraceGap = (gap: string) => {
    if (traceGaps.length < 16 && !traceGaps.includes(gap)) traceGaps.push(gap);
  };
  const trace: TraceCollector = { records: [], addGap: addTraceGap };
  const parentContents = await readFile(parent, "utf8").catch(() => null);
  if (parentContents === null) return unavailable("parent_transcript_unreadable");
  const parentEvidence = inspectTranscript(parentContents, "parent", path.basename(parent), attemptStartedAtMs, trace);
  files.push(parentEvidence);
  if (parentEvidence.malformedRecordCount > 0) {
    parseGaps.push("parent_transcript_malformed_records");
  }
  if (parentEvidence.effortStatus === "unavailable") {
    parseGaps.push("parent_effort_unavailable");
  }
  if (parentEvidence.toolSchemaStatus === "unavailable") {
    parseGaps.push("parent_tool_schema_unavailable");
  }

  const subagentsDir = path.join(path.dirname(parent), sessionId, "subagents");
  const entries = await readdir(subagentsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !/^agent-[A-Za-z0-9-]+\.jsonl$/.test(entry.name)
    ) continue;
    const child = path.join(subagentsDir, entry.name);
    if (!await regularFileInside(configRoot, child)) {
      parseGaps.push(`child_transcript_unsafe:${entry.name}`);
      continue;
    }
    const contents = await readFile(child, "utf8").catch(() => null);
    if (contents === null) {
      parseGaps.push(`child_transcript_unreadable:${entry.name}`);
      continue;
    }
    const childEvidence = inspectTranscript(contents, "child", entry.name, attemptStartedAtMs, trace);
    files.push(childEvidence);
    if (childEvidence.malformedRecordCount > 0) {
      parseGaps.push(`child_transcript_malformed_records:${entry.name}`);
    }
    if (childEvidence.effortStatus === "unavailable") {
      parseGaps.push(`child_effort_unavailable:${entry.name}`);
    }
    if (childEvidence.toolSchemaStatus === "unavailable") {
      parseGaps.push(`child_tool_schema_unavailable:${entry.name}`);
    }
  }

  if (trace.records.length === 0) addTraceGap("current_attempt_trace_records_unavailable");
  const recordSetSha256 = trace.records.length > 0
    ? createHash("sha256").update(canonicalJson(trace.records)).digest("hex")
    : null;
  const traceStatus = trace.records.length > 0 ? "partial" as const : "unavailable" as const;
  return {
    schema: "paperclip.claude-transcript-completion-evidence.v1",
    status: traceStatus === "unavailable"
      ? "unavailable"
      : parseGaps.length > 0 || traceGaps.length > 0 ? "partial" : "available",
    source: "claude_config_transcript",
    sessionId,
    toolSchemaProjection: "prompt_snapshot_safe_structure.v1",
    attempt: { startedAt: attemptStartedAt, resumed: input.resumed },
    transcriptTrace: {
      schema: "paperclip.claude-sanitized-transcript-trace.v1",
      status: traceStatus,
      scope: "timestamped_records_at_or_after_attempt_start",
      ordering: "source_file_then_line",
      records: trace.records,
      recordSetSha256,
      parseGaps: traceStatus === "partial"
        ? ["transcript_derived_not_wire_trace", ...traceGaps]
        : traceGaps,
    },
    files,
    parseGaps: [...parseGaps, ...traceGaps],
  };
}
