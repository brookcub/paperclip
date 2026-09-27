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
  files: TranscriptFile[];
  parseGaps: string[];
};
type DurableTranscriptFile = Omit<TranscriptFile, "promptSnapshotTools"> & {
  promptSnapshotToolProjections: string[];
  toolSchemaProjectionStatus: "complete" | "partial";
};
type DurableClaudeTranscriptEvidence = Omit<
  ClaudeTranscriptCompletionEvidence,
  "files" | "parseGaps"
> & {
  files: DurableTranscriptFile[];
  parseGaps: string[];
};

const MAX_FILES = 64;
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
const ID_RE = /^[A-Za-z0-9-]{1,200}$/;
const FILE_RE = /^(?:[A-Za-z0-9-]+|agent-[A-Za-z0-9-]+)\.jsonl$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const VALUE_RE = /^[A-Za-z0-9_.:/@-]{1,200}$/;
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
  budget: { nodes: number } = { nodes: 0 },
): ToolSchemaShape | null {
  const shape = record(value);
  if (!shape || depth > MAX_SCHEMA_DEPTH || ++budget.nodes > MAX_SCHEMA_NODES) {
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
        const inputSchemaShape = item.inputSchemaShape === null
          ? null
          : safeShape(item.inputSchemaShape);
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

function transcriptEvidence(value: unknown): DurableClaudeTranscriptEvidence | null {
  const evidence = record(value);
  if (
    !evidence ||
    evidence.schema !== "paperclip.claude-transcript-completion-evidence.v1" ||
    evidence.source !== "claude_config_transcript" ||
    evidence.toolSchemaProjection !== "prompt_snapshot_safe_structure.v1" ||
    !["available", "partial", "unavailable"].includes(String(evidence.status)) ||
    !Array.isArray(evidence.files) ||
    evidence.files.length > MAX_FILES ||
    !Array.isArray(evidence.parseGaps) ||
    !ID_RE.test(String(evidence.sessionId ?? "")) && evidence.sessionId !== null
  ) {
    return null;
  }
  const files = evidence.files.map(transcriptFile);
  if (files.some((file) => file === null)) return null;
  const durableFiles = files as DurableTranscriptFile[];
  const parseGaps = [
    ...evidence.parseGaps
      .filter((gap): gap is string => typeof gap === "string" && VALUE_RE.test(gap))
      .slice(0, MAX_PARSE_GAPS),
    ...durableFiles
      .filter((file) => file.toolSchemaProjectionStatus === "partial")
      .map((file) => `tool_schema_projection_truncated:${file.fileName}`),
  ].slice(0, MAX_PARSE_GAPS);
  return {
    schema: "paperclip.claude-transcript-completion-evidence.v1",
    status: evidence.status === "available" && parseGaps.length > 0
      ? "partial"
      : evidence.status as DurableClaudeTranscriptEvidence["status"],
    source: "claude_config_transcript",
    sessionId: typeof evidence.sessionId === "string" ? evidence.sessionId : null,
    toolSchemaProjection: "prompt_snapshot_safe_structure.v1",
    files: durableFiles,
    parseGaps,
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
}) {
  const adapterResult = record(input.adapterResultJson);
  const transcript = input.adapterType === "claude_local"
    ? transcriptEvidence(adapterResult?.completionEvidence)
    : null;
  return {
    schema: "paperclip.run-completion-evidence.v1",
    transcript: input.adapterType === null
      ? { status: "unavailable" as const, reason: "adapter_type_unavailable" }
      : input.adapterType !== "claude_local"
      ? { status: "not_applicable" as const, reason: "adapter_not_claude_local" }
      : transcript ?? {
        schema: "paperclip.claude-transcript-completion-evidence.v1",
        status: "unavailable" as const,
        source: "claude_config_transcript" as const,
        sessionId: null,
        toolSchemaProjection: "prompt_snapshot_safe_structure.v1" as const,
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
