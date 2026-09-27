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

export type ClaudeTranscriptCompletionEvidence = {
  schema: "paperclip.claude-transcript-completion-evidence.v1";
  status: EvidenceStatus;
  source: "claude_config_transcript";
  sessionId: string | null;
  /** Safe structural projection: never descriptions, defaults, examples, or enum values. */
  toolSchemaProjection: "prompt_snapshot_safe_structure.v1";
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

function object(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
) {
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

  for (const line of contents.split(/\r?\n/)) {
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
    const model = string(message?.model);
    if (model) models.add(model);
    const selectedEffort = string(record.effort);
    if (selectedEffort) effort.add(selectedEffort);
    const tools = promptSnapshotToolEntries(record);
    if (tools) promptSnapshotTools.push({ timestamp: string(record.timestamp), tools });
  }

  return {
    role,
    fileName,
    sha256: createHash("sha256").update(contents).digest("hex"),
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
}): Promise<ClaudeTranscriptCompletionEvidence> {
  const sessionId = string(input.sessionId);
  const unavailable = (reason: string): ClaudeTranscriptCompletionEvidence => ({
    schema: "paperclip.claude-transcript-completion-evidence.v1",
    status: "unavailable",
    source: "claude_config_transcript",
    sessionId,
    toolSchemaProjection: "prompt_snapshot_safe_structure.v1",
    files: [],
    parseGaps: [reason],
  });
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return unavailable("invalid_session_id");
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
  const parentContents = await readFile(parent, "utf8").catch(() => null);
  if (parentContents === null) return unavailable("parent_transcript_unreadable");
  const parentEvidence = inspectTranscript(parentContents, "parent", path.basename(parent));
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
    const childEvidence = inspectTranscript(contents, "child", entry.name);
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

  return {
    schema: "paperclip.claude-transcript-completion-evidence.v1",
    status: parseGaps.length > 0 ? "partial" : "available",
    source: "claude_config_transcript",
    sessionId,
    toolSchemaProjection: "prompt_snapshot_safe_structure.v1",
    files,
    parseGaps,
  };
}
