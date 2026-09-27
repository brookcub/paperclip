import { createHash } from "node:crypto";

type RecordValue = Record<string, unknown>;
type TraceMetadata = {
  id: string;
  status: string;
  expiresAt: Date;
  deletedAt: Date | null;
} | null;
type ToolSchemaShape = {
  type: string[];
  required: string[];
  properties: Record<string, ToolSchemaShape>;
  items: ToolSchemaShape | null;
  variants: ToolSchemaShape[];
  additionalProperties: boolean | null;
  enumCount: number | null;
};
type EvidenceAvailability = "available" | "unavailable";
type TranscriptFile = {
  role: "parent" | "child";
  fileName: string;
  sha256: string;
  bytes: number;
  models: string[];
  effort: string[];
  effortStatus: EvidenceAvailability;
  toolSchemaStatus: EvidenceAvailability;
  promptSnapshotTools: Array<{
    timestamp: string | null;
    tools: Array<{
      name: string;
      inputSchemaShape: ToolSchemaShape | null;
      inputSchemaShapeSha256: string | null;
    }>;
  }>;
  malformedRecordCount: number;
};
type ClaudeTranscriptCompletionEvidence = {
  schema: "paperclip.claude-transcript-completion-evidence.v1";
  status: "available" | "partial" | "unavailable";
  source: "claude_config_transcript";
  sessionId: string | null;
  toolSchemaProjection: "prompt_snapshot_safe_structure.v1";
  attempt: { startedAt: string | null; resumed: boolean };
  transcriptTrace: ClaudeTranscriptTrace;
  files: TranscriptFile[];
  parseGaps: string[];
};
type ClaudeTranscriptTrace = {
  schema: "paperclip.claude-sanitized-transcript-trace.v1";
  status: "partial" | "unavailable";
  scope: "timestamped_records_at_or_after_attempt_start";
  ordering: "source_file_then_line";
  records: Array<{
    fileName: string;
    fileSha256: string;
    role: "parent" | "child";
    line: number;
    recordType: string | null;
    timestamp: string;
    model: string | null;
    effort: string | null;
    toolSchemaHashes: string[];
  }>;
  recordSetSha256: string | null;
  parseGaps: string[];
};
type DurableTranscriptFile = Omit<TranscriptFile, "promptSnapshotTools"> & {
  promptSnapshotToolProjections: string[];
  toolSchemaProjectionStatus: "complete" | "partial";
};
type DurableClaudeTranscriptEvidence = Omit<
  ClaudeTranscriptCompletionEvidence,
  "files" | "parseGaps" | "transcriptTrace"
> & {
  files: DurableTranscriptFile[];
  transcriptTrace: DurableClaudeTranscriptTrace;
  parseGaps: string[];
};
type DurableClaudeTranscriptTrace = ClaudeTranscriptTrace & {
  traceLocator: {
    kind: "heartbeat_run_event_json_pointer";
    runId: string;
    eventType: "completion_evidence";
    jsonPointer: "/transcript/transcriptTrace";
    traceSchema: "paperclip.claude-sanitized-transcript-trace.v1";
    recordSetSha256: string;
  } | null;
};
type CodexDynamicTool = {
  name: string;
  inputSchemaShape: {
    type: string[];
    required: string[];
    properties: string[];
    hasItems: boolean;
    variants: string[];
    additionalProperties: boolean | null;
    enumCount: number | null;
  } | null;
  inputSchemaShapeSha256: string | null;
};
type DurableCodexRolloutEvidence = {
  schema: "paperclip.codex-rollout-completion-evidence.v1";
  status: "partial" | "unavailable";
  source: "codex_rollout_session";
  sessionId: string | null;
  toolSchemaCoverage: "dynamic_tools_only_partial";
  rollout: null | {
    fileName: string;
    sha256: string;
    bytes: number;
    sessionBinding: "session_meta.payload.session_id";
    fieldProvenance: { model: "turn_context"; effort: "turn_context"; dynamicTools: "session_meta" };
    models: string[];
    effort: string[];
    effortStatus: EvidenceAvailability;
    dynamicToolSchemaStatus: EvidenceAvailability;
    dynamicTools: CodexDynamicTool[];
    malformedRecordCount: number;
  };
  parseGaps: string[];
};

const MAX_FILES = 64;
const MAX_DURABLE_FILES = 50;
const MAX_MODELS_PER_FILE = 32;
const MAX_EFFORTS_PER_FILE = 16;
const MAX_SNAPSHOTS_PER_FILE = 128;
// Each projection is stored in the existing event payload array (50 entries).
const MAX_TOOLS_PER_SNAPSHOT = 50;
const MAX_PARSE_GAPS = 128;
const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_PROPERTIES = 100;
const MAX_SCHEMA_VARIANTS = 20;
const MAX_SCHEMA_NODES = 64;
const MAX_PROJECTION_CHARS = 12_000;
const MAX_PROJECTIONS_PER_FILE = 50;
const MAX_TRACE_RECORDS = 32;
const MAX_TRACE_SCHEMA_HASHES = 16;
const ID_RE = /^[A-Za-z0-9-]{1,200}$/;
const FILE_RE = /^(?:[A-Za-z0-9-]+|agent-[A-Za-z0-9-]+|rollout-[A-Za-z0-9T:-]+-[A-Za-z0-9-]+)\.jsonl$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const VALUE_RE = /^[A-Za-z0-9_.:/@-]{1,200}$/;
const OFFSET_TIMESTAMP_RE = /(?:Z|[+-]\d{2}:\d{2})$/;
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:/-]{0,200}$/;
const PROPERTY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:/-]{0,128}$/;
const SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function safeValues(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string =>
    typeof entry === "string" && VALUE_RE.test(entry),
  ))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, limit);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const valueRecord = record(value);
  if (valueRecord) {
    return `{${Object.keys(valueRecord).sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(valueRecord[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeShape(
  value: unknown,
  depth = 0,
  budget: { nodes: number; truncated: boolean } = { nodes: 0, truncated: false },
): ToolSchemaShape | null {
  const shape = record(value);
  if (!shape) return null;
  if (depth > MAX_SCHEMA_DEPTH || ++budget.nodes > MAX_SCHEMA_NODES) {
    budget.truncated = true;
    return null;
  }
  const properties = record(shape.properties);
  const propertyEntries = Object.entries(properties ?? {})
    .filter(([name]) => PROPERTY_NAME_RE.test(name))
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_SCHEMA_PROPERTIES)
    .flatMap(([name, child]) => {
      const safeChild = safeShape(child, depth + 1, budget);
      return safeChild ? [[name, safeChild] as const] : [];
    });
  const variants = Array.isArray(shape.variants)
    ? shape.variants
      .slice(0, MAX_SCHEMA_VARIANTS)
      .map((variant) => safeShape(variant, depth + 1, budget))
      .filter((variant): variant is ToolSchemaShape => variant !== null)
    : [];
  const enumCount = typeof shape.enumCount === "number" &&
    Number.isSafeInteger(shape.enumCount) && shape.enumCount >= 0
    ? Math.min(shape.enumCount, MAX_SCHEMA_PROPERTIES)
    : null;
  return {
    type: safeValues(shape.type, 8).filter((type) => SCHEMA_TYPES.has(type)),
    required: safeValues(shape.required, MAX_SCHEMA_PROPERTIES)
      .filter((name) => PROPERTY_NAME_RE.test(name)),
    properties: Object.fromEntries(propertyEntries),
    items: safeShape(shape.items, depth + 1, budget),
    variants,
    additionalProperties: typeof shape.additionalProperties === "boolean"
      ? shape.additionalProperties
      : null,
    enumCount,
  };
}

function transcriptFile(value: unknown): DurableTranscriptFile | null {
  const file = record(value);
  if (
    !file ||
    (file.role !== "parent" && file.role !== "child") ||
    typeof file.fileName !== "string" ||
    !FILE_RE.test(file.fileName) ||
    typeof file.sha256 !== "string" ||
    !SHA256_RE.test(file.sha256) ||
    typeof file.bytes !== "number" ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0 ||
    file.bytes > 1024 * 1024 * 1024 ||
    !Array.isArray(file.promptSnapshotTools) ||
    (file.effortStatus !== "available" && file.effortStatus !== "unavailable") ||
    (file.toolSchemaStatus !== "available" && file.toolSchemaStatus !== "unavailable") ||
    typeof file.malformedRecordCount !== "number" ||
    !Number.isSafeInteger(file.malformedRecordCount) ||
    file.malformedRecordCount < 0
  ) {
    return null;
  }

  let toolSchemaProjectionStatus: "complete" | "partial" = "complete";
  if (file.promptSnapshotTools.length > MAX_SNAPSHOTS_PER_FILE) {
    toolSchemaProjectionStatus = "partial";
  }
  const allPromptSnapshotToolProjections = file.promptSnapshotTools
    .slice(0, MAX_SNAPSHOTS_PER_FILE)
    .flatMap((value) => {
      const snapshot = record(value);
      if (!snapshot || !Array.isArray(snapshot.tools)) return [];
      if (snapshot.tools.length > MAX_TOOLS_PER_SNAPSHOT) {
        toolSchemaProjectionStatus = "partial";
      }
      return snapshot.tools.slice(0, MAX_TOOLS_PER_SNAPSHOT).flatMap((tool) => {
        const item = record(tool);
        if (!item || typeof item.name !== "string" || !TOOL_NAME_RE.test(item.name)) {
          return [];
        }
        const shapeBudget = { nodes: 0, truncated: false };
        const inputSchemaShape = item.inputSchemaShape === null
          ? null
          : safeShape(item.inputSchemaShape, 0, shapeBudget);
        if (shapeBudget.truncated) toolSchemaProjectionStatus = "partial";
        const inputSchemaShapeSha256 = typeof item.inputSchemaShapeSha256 === "string" &&
          SHA256_RE.test(item.inputSchemaShapeSha256)
          ? item.inputSchemaShapeSha256.toLowerCase()
          : null;
        if ((inputSchemaShape === null) !== (inputSchemaShapeSha256 === null)) return [];
        const durableSchemaHash = inputSchemaShape
          ? createHash("sha256").update(canonicalJson(inputSchemaShape)).digest("hex")
          : null;
        const projection = JSON.stringify({
          timestamp: typeof snapshot.timestamp === "string" &&
            Number.isFinite(Date.parse(snapshot.timestamp))
            ? snapshot.timestamp
            : null,
          name: item.name,
          inputSchemaShape,
          inputSchemaShapeSha256: durableSchemaHash,
        });
        if (projection.length <= MAX_PROJECTION_CHARS) return [projection];
        toolSchemaProjectionStatus = "partial";
        return [JSON.stringify({
          timestamp: typeof snapshot.timestamp === "string" &&
            Number.isFinite(Date.parse(snapshot.timestamp))
            ? snapshot.timestamp
            : null,
          name: item.name,
          inputSchemaShape: null,
          inputSchemaShapeSha256: durableSchemaHash,
          reason: "safe_structure_exceeds_event_projection_limit",
        })];
      });
    });
  if (allPromptSnapshotToolProjections.length > MAX_PROJECTIONS_PER_FILE) {
    toolSchemaProjectionStatus = "partial";
  }
  const promptSnapshotToolProjections = allPromptSnapshotToolProjections
    .slice(0, MAX_PROJECTIONS_PER_FILE);

  return {
    role: file.role,
    fileName: file.fileName,
    sha256: file.sha256.toLowerCase(),
    bytes: file.bytes,
    models: safeValues(file.models, MAX_MODELS_PER_FILE),
    effort: safeValues(file.effort, MAX_EFFORTS_PER_FILE),
    effortStatus: file.effortStatus,
    toolSchemaStatus: file.toolSchemaStatus,
    promptSnapshotToolProjections,
    toolSchemaProjectionStatus,
    malformedRecordCount: file.malformedRecordCount,
  };
}

function transcriptTrace(value: unknown, runId: string | undefined): DurableClaudeTranscriptTrace | null {
  const trace = record(value);
  if (
    !trace || trace.schema !== "paperclip.claude-sanitized-transcript-trace.v1" ||
    (trace.status !== "partial" && trace.status !== "unavailable") ||
    trace.scope !== "timestamped_records_at_or_after_attempt_start" ||
    trace.ordering !== "source_file_then_line" ||
    !Array.isArray(trace.records) || trace.records.length > MAX_TRACE_RECORDS ||
    !Array.isArray(trace.parseGaps)
  ) return null;
  const records: ClaudeTranscriptTrace["records"] = trace.records.flatMap((value) => {
    const item = record(value);
    if (
      !item || !FILE_RE.test(String(item.fileName ?? "")) ||
      !SHA256_RE.test(String(item.fileSha256 ?? "")) ||
      (item.role !== "parent" && item.role !== "child") ||
      !Number.isSafeInteger(item.line) || item.line < 1 ||
      (item.recordType !== null && !VALUE_RE.test(String(item.recordType))) ||
      offsetTimestamp(item.timestamp) === null ||
      (item.model !== null && !VALUE_RE.test(String(item.model))) ||
      (item.effort !== null && !VALUE_RE.test(String(item.effort))) ||
      !Array.isArray(item.toolSchemaHashes) || item.toolSchemaHashes.length > MAX_TRACE_SCHEMA_HASHES ||
      item.toolSchemaHashes.some((hash) => typeof hash !== "string" || !SHA256_RE.test(hash))
    ) return [];
    return [{
      fileName: item.fileName as string,
      fileSha256: (item.fileSha256 as string).toLowerCase(),
      role: item.role as "parent" | "child",
      line: item.line as number,
      recordType: item.recordType === null ? null : item.recordType as string,
      timestamp: item.timestamp as string,
      model: item.model === null ? null : item.model as string,
      effort: item.effort === null ? null : item.effort as string,
      toolSchemaHashes: (item.toolSchemaHashes as string[]).map((hash) => hash.toLowerCase()),
    }];
  });
  if (records.length !== trace.records.length || (trace.status === "partial" && records.length === 0)) return null;
  const recordSetSha256 = records.length > 0
    ? createHash("sha256").update(canonicalJson(records)).digest("hex")
    : null;
  if (trace.recordSetSha256 !== recordSetSha256) return null;
  const parseGaps = trace.parseGaps
    .filter((gap): gap is string => typeof gap === "string" && VALUE_RE.test(gap))
    .slice(0, MAX_PARSE_GAPS);
  return {
    schema: "paperclip.claude-sanitized-transcript-trace.v1",
    status: trace.status,
    scope: "timestamped_records_at_or_after_attempt_start",
    ordering: "source_file_then_line",
    records,
    recordSetSha256,
    parseGaps,
    traceLocator: runId && ID_RE.test(runId) && recordSetSha256
      ? {
        kind: "heartbeat_run_event_json_pointer",
        runId,
        eventType: "completion_evidence",
        jsonPointer: "/transcript/transcriptTrace",
        traceSchema: "paperclip.claude-sanitized-transcript-trace.v1",
        recordSetSha256,
      }
      : null,
  };
}

function transcriptEvidence(value: unknown, runId: string | undefined): DurableClaudeTranscriptEvidence | null {
  const evidence = record(value);
  if (
    !evidence ||
    evidence.schema !== "paperclip.claude-transcript-completion-evidence.v1" ||
    evidence.source !== "claude_config_transcript" ||
    evidence.toolSchemaProjection !== "prompt_snapshot_safe_structure.v1" ||
    !["available", "partial", "unavailable"].includes(String(evidence.status)) ||
    !Array.isArray(evidence.files) ||
    evidence.files.length > MAX_FILES ||
    !record(evidence.attempt) ||
    (evidence.attempt.resumed !== true && evidence.attempt.resumed !== false) ||
    offsetTimestamp(evidence.attempt.startedAt) === null ||
    !Array.isArray(evidence.parseGaps) ||
    !ID_RE.test(String(evidence.sessionId ?? "")) && evidence.sessionId !== null
  ) {
    return null;
  }
  const files = evidence.files
    .slice(0, MAX_DURABLE_FILES)
    .map(transcriptFile);
  if (files.some((file) => file === null)) return null;
  const durableFiles = files as DurableTranscriptFile[];
  const durableTrace = transcriptTrace(evidence.transcriptTrace, runId);
  if (!durableTrace) return null;
  const parseGaps = [
    ...evidence.parseGaps
      .filter((gap): gap is string => typeof gap === "string" && VALUE_RE.test(gap))
      .slice(0, MAX_PARSE_GAPS),
    ...durableFiles
      .filter((file) => file.toolSchemaProjectionStatus === "partial")
      .map((file) => `tool_schema_projection_truncated:${file.fileName}`),
    ...(evidence.files.length > MAX_DURABLE_FILES
      ? ["transcript_file_projection_truncated"]
      : []),
  ].slice(0, MAX_PARSE_GAPS);
  return {
    schema: "paperclip.claude-transcript-completion-evidence.v1",
    status: evidence.status === "available" && parseGaps.length > 0
      ? "partial"
      : evidence.status as DurableClaudeTranscriptEvidence["status"],
    source: "claude_config_transcript",
    sessionId: typeof evidence.sessionId === "string" ? evidence.sessionId : null,
    toolSchemaProjection: "prompt_snapshot_safe_structure.v1",
    attempt: { startedAt: evidence.attempt.startedAt as string, resumed: evidence.attempt.resumed as boolean },
    transcriptTrace: durableTrace,
    files: durableFiles,
    parseGaps,
  };
}

function offsetTimestamp(value: unknown): string | null {
  return typeof value === "string" && OFFSET_TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function codexDynamicTool(value: unknown): CodexDynamicTool | null {
  const tool = record(value);
  if (!tool || typeof tool.name !== "string" || !TOOL_NAME_RE.test(tool.name)) return null;
  if (tool.inputSchemaShape === null && tool.inputSchemaShapeSha256 === null) {
    return { name: tool.name, inputSchemaShape: null, inputSchemaShapeSha256: null };
  }
  const shape = record(tool.inputSchemaShape);
  if (!shape || typeof tool.inputSchemaShapeSha256 !== "string" || !SHA256_RE.test(tool.inputSchemaShapeSha256)) return null;
  const type = safeValues(shape.type, 8).filter((entry) => SCHEMA_TYPES.has(entry));
  const required = safeValues(shape.required, MAX_SCHEMA_PROPERTIES)
    .filter((entry) => PROPERTY_NAME_RE.test(entry));
  const properties = safeValues(shape.properties, MAX_SCHEMA_PROPERTIES)
    .filter((entry) => PROPERTY_NAME_RE.test(entry));
  const variants = safeValues(shape.variants, MAX_SCHEMA_VARIANTS)
    .filter((entry) => ["oneOf", "anyOf", "allOf"].includes(entry));
  const enumCount = typeof shape.enumCount === "number" && Number.isSafeInteger(shape.enumCount) && shape.enumCount >= 0
    ? Math.min(shape.enumCount, MAX_SCHEMA_PROPERTIES)
    : null;
  if (typeof shape.hasItems !== "boolean") return null;
  if (shape.additionalProperties !== null && typeof shape.additionalProperties !== "boolean") return null;
  const inputSchemaShape = {
    type, required, properties, hasItems: shape.hasItems, variants,
    additionalProperties: shape.additionalProperties, enumCount,
  };
  return {
    name: tool.name,
    inputSchemaShape,
    inputSchemaShapeSha256: createHash("sha256").update(canonicalJson(inputSchemaShape)).digest("hex"),
  };
}

function codexRolloutEvidence(value: unknown): DurableCodexRolloutEvidence | null {
  const evidence = record(value);
  if (!evidence) return null;
  const rawSessionId = evidence.sessionId;
  const sessionId = rawSessionId === null
    ? null
    : typeof rawSessionId === "string" && ID_RE.test(rawSessionId)
    ? rawSessionId
    : null;
  if (rawSessionId !== null && sessionId === null) return null;
  if (
    evidence.schema !== "paperclip.codex-rollout-completion-evidence.v1" ||
    evidence.source !== "codex_rollout_session" || evidence.toolSchemaCoverage !== "dynamic_tools_only_partial" ||
    !["partial", "unavailable"].includes(String(evidence.status)) ||
    !Array.isArray(evidence.parseGaps)
  ) return null;
  if (evidence.rollout === null) {
    return {
      schema: "paperclip.codex-rollout-completion-evidence.v1", status: "unavailable", source: "codex_rollout_session",
      sessionId, toolSchemaCoverage: "dynamic_tools_only_partial", rollout: null,
      parseGaps: evidence.parseGaps.filter((gap): gap is string => typeof gap === "string" && VALUE_RE.test(gap)).slice(0, MAX_PARSE_GAPS),
    };
  }
  const rollout = record(evidence.rollout);
  const fieldProvenance = rollout ? record(rollout.fieldProvenance) : null;
  if (
    !rollout || typeof rollout.fileName !== "string" || !FILE_RE.test(rollout.fileName) ||
    typeof rollout.sha256 !== "string" || !SHA256_RE.test(rollout.sha256) ||
    typeof rollout.bytes !== "number" || !Number.isSafeInteger(rollout.bytes) || rollout.bytes < 0 ||
    rollout.sessionBinding !== "session_meta.payload.session_id" ||
    !fieldProvenance || fieldProvenance.model !== "turn_context" ||
    fieldProvenance.effort !== "turn_context" || fieldProvenance.dynamicTools !== "session_meta" ||
    (rollout.effortStatus !== "available" && rollout.effortStatus !== "unavailable") ||
    (rollout.dynamicToolSchemaStatus !== "available" && rollout.dynamicToolSchemaStatus !== "unavailable") ||
    !Array.isArray(rollout.dynamicTools) || rollout.dynamicTools.length > MAX_TOOLS_PER_SNAPSHOT ||
    typeof rollout.malformedRecordCount !== "number" || !Number.isSafeInteger(rollout.malformedRecordCount) || rollout.malformedRecordCount < 0
  ) return null;
  const dynamicTools = rollout.dynamicTools.map(codexDynamicTool);
  if (dynamicTools.some((tool) => tool === null)) return null;
  return {
    schema: "paperclip.codex-rollout-completion-evidence.v1", status: "partial", source: "codex_rollout_session",
    sessionId, toolSchemaCoverage: "dynamic_tools_only_partial",
    rollout: {
      fileName: rollout.fileName, sha256: rollout.sha256.toLowerCase(), bytes: rollout.bytes,
      sessionBinding: "session_meta.payload.session_id",
      fieldProvenance: { model: "turn_context", effort: "turn_context", dynamicTools: "session_meta" },
      models: safeValues(rollout.models, MAX_MODELS_PER_FILE), effort: safeValues(rollout.effort, MAX_EFFORTS_PER_FILE),
      effortStatus: rollout.effortStatus, dynamicToolSchemaStatus: rollout.dynamicToolSchemaStatus,
      dynamicTools: dynamicTools as CodexDynamicTool[], malformedRecordCount: rollout.malformedRecordCount,
    },
    parseGaps: evidence.parseGaps.filter((gap): gap is string => typeof gap === "string" && VALUE_RE.test(gap)).slice(0, MAX_PARSE_GAPS),
  };
}

function traceEvidence(trace: TraceMetadata, requested: boolean) {
  if (!trace) {
    return {
      status: "unavailable" as const,
      reason: requested
        ? "provider_trace_metadata_unavailable"
        : "provider_trace_not_requested",
    };
  }
  if (!ID_RE.test(trace.id) || !trace.status || !Number.isFinite(trace.expiresAt.getTime())) {
    return { status: "unavailable" as const, reason: "provider_trace_metadata_invalid" };
  }
  if (trace.deletedAt) {
    return { status: "unavailable" as const, reason: "provider_trace_deleted" };
  }
  if (trace.expiresAt.getTime() <= Date.now()) {
    return { status: "unavailable" as const, reason: "provider_trace_expired" };
  }
  const pointer = `provider-trace:${trace.id}`;
  if (trace.status === "complete") {
    return { status: "available" as const, pointer, traceStatus: trace.status };
  }
  if (["capturing", "incomplete", "truncated"].includes(trace.status)) {
    return {
      status: "partial" as const,
      pointer,
      traceStatus: trace.status,
      reason: `provider_trace_${trace.status}`,
    };
  }
  return { status: "unavailable" as const, reason: `provider_trace_${trace.status}` };
}

export function buildRunCompletionEvidence(input: {
  adapterType: string | null;
  adapterResultJson: unknown;
  providerTrace: TraceMetadata;
  providerTraceRequested: boolean;
  /** The caller may supply the terminal run ID; no event ID is fabricated here. */
  runId?: string;
}) {
  const adapterResult = record(input.adapterResultJson);
  const transcript = input.adapterType === "claude_local"
    ? transcriptEvidence(adapterResult?.completionEvidence, input.runId)
    : input.adapterType === "codex_local"
    ? codexRolloutEvidence(adapterResult?.completionEvidence)
    : null;
  return {
    schema: "paperclip.run-completion-evidence.v1",
    transcript: input.adapterType === null
      ? { status: "unavailable" as const, reason: "adapter_type_unavailable" }
      : input.adapterType !== "claude_local" && input.adapterType !== "codex_local"
      ? { status: "not_applicable" as const, reason: "adapter_does_not_report_completion_evidence" }
      : input.adapterType === "codex_local"
      ? transcript ?? {
        schema: "paperclip.codex-rollout-completion-evidence.v1" as const,
        status: "unavailable" as const,
        source: "codex_rollout_session" as const,
        sessionId: null,
        toolSchemaCoverage: "dynamic_tools_only_partial" as const,
        rollout: null,
        parseGaps: ["adapter_did_not_report_rollout_evidence"],
      }
      : transcript ?? {
        schema: "paperclip.claude-transcript-completion-evidence.v1",
        status: "unavailable" as const,
        source: "claude_config_transcript" as const,
        sessionId: null,
        toolSchemaProjection: "prompt_snapshot_safe_structure.v1" as const,
        attempt: { startedAt: null, resumed: false },
        transcriptTrace: {
          schema: "paperclip.claude-sanitized-transcript-trace.v1" as const,
          status: "unavailable" as const,
          scope: "timestamped_records_at_or_after_attempt_start" as const,
          ordering: "source_file_then_line" as const,
          records: [],
          recordSetSha256: null,
          parseGaps: ["adapter_did_not_report_transcript_evidence"],
          traceLocator: null,
        },
        files: [],
        parseGaps: ["adapter_did_not_report_transcript_evidence"],
      },
    providerTrace: traceEvidence(input.providerTrace, input.providerTraceRequested),
  };
}

/**
 * The artifact write is a cleanup precondition. If persistence fails, callers
 * retain scratch rather than deleting the only remaining provider evidence.
 */
export async function persistCompletionEvidenceBeforeScratchCleanup<T>(input: {
  append: () => Promise<unknown>;
  cleanup?: () => Promise<T>;
}): Promise<T | null> {
  await input.append();
  return input.cleanup ? input.cleanup() : null;
}
