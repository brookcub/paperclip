import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { redactEventPayload } from "../redaction.js";
import { boundHeartbeatRunEventPayloadForStorage } from "./run-event-payload-bounds.js";
import {
  buildRunCompletionEvidence,
  persistCompletionEvidenceBeforeScratchCleanup,
} from "./run-completion-evidence.js";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const traceRecords = [{
  fileName: "agent-child.jsonl",
  fileSha256: "a".repeat(64),
  role: "child" as const,
  line: 2,
  recordType: "assistant",
  timestamp: "2026-09-27T00:00:00Z",
  model: "claude-sonnet",
  effort: "low",
  toolSchemaHashes: ["b".repeat(64)],
}];
function traceWith(records: typeof traceRecords) {
  return {
    schema: "paperclip.claude-sanitized-transcript-trace.v1" as const,
    status: "partial" as const,
    scope: "timestamped_records_at_or_after_attempt_start" as const,
    ordering: "source_file_then_line" as const,
    records,
    recordSetSha256: createHash("sha256").update(canonicalJson(records)).digest("hex"),
    parseGaps: ["trace_is_transcript_derived"],
  };
}
const transcript = {
  schema: "paperclip.claude-transcript-completion-evidence.v1" as const,
  status: "partial" as const,
  source: "claude_config_transcript" as const,
  sessionId: "session-123",
  toolSchemaProjection: "prompt_snapshot_safe_structure.v1" as const,
  attempt: { startedAt: "2026-09-26T23:59:59Z", resumed: false },
  transcriptTrace: traceWith(traceRecords),
  files: [{
    role: "child" as const,
    fileName: "agent-child.jsonl",
    sha256: "a".repeat(64),
    bytes: 42,
    models: ["claude-sonnet"],
    effort: ["low"],
    effortStatus: "available" as const,
    toolSchemaStatus: "available" as const,
    promptSnapshotTools: [{
      timestamp: null,
      tools: [{
        name: "Read",
        inputSchemaShape: null,
        inputSchemaShapeSha256: null,
      }],
    }],
    malformedRecordCount: 1,
  }],
  parseGaps: ["child_transcript_malformed_records:agent-child.jsonl"],
};

const codexRollout = {
  schema: "paperclip.codex-rollout-completion-evidence.v1" as const,
  status: "partial" as const,
  source: "codex_rollout_session" as const,
  sessionId: "019cabcd-1234-7abc-8def-0123456789ab",
  toolSchemaCoverage: "dynamic_tools_only_partial" as const,
  rollout: {
    fileName: "rollout-2026-09-27T00-00-00-019cabcd-1234-7abc-8def-0123456789ab.jsonl",
    sha256: "b".repeat(64), bytes: 42, models: ["gpt-6-sol"], effort: ["high"],
    sessionBinding: "session_meta.payload.session_id" as const,
    fieldProvenance: { model: "turn_context" as const, effort: "turn_context" as const, dynamicTools: "session_meta" as const },
    effortStatus: "available" as const, dynamicToolSchemaStatus: "available" as const,
    dynamicTools: [{
      name: "mcp__company__read_issue",
      inputSchemaShape: {
        type: ["object"], required: ["issueId"], properties: ["issueId"], hasItems: false,
        variants: [], additionalProperties: false, enumCount: null,
      },
      inputSchemaShapeSha256: "a".repeat(64),
    }],
    malformedRecordCount: 0,
  },
  parseGaps: ["builtin_tool_schema_not_in_rollout_dynamic_tools"],
};

describe("run completion evidence", () => {
  it("keeps the terminal failure record readable after cleanup", async () => {
    const evidence = buildRunCompletionEvidence({
      adapterType: "claude_local",
      adapterResultJson: {
        completionEvidence: { ...transcript, prompt: "must not be copied" },
      },
      providerTrace: null,
      providerTraceRequested: true,
    });
    const cleanup = vi.fn(async () => undefined);

    await persistCompletionEvidenceBeforeScratchCleanup({
      append: async () => undefined,
      cleanup,
    });

    expect(cleanup).toHaveBeenCalledOnce();
    expect(evidence).toMatchObject({
      transcript: {
        status: "partial",
        toolSchemaProjection: "prompt_snapshot_safe_structure.v1",
        parseGaps: ["child_transcript_malformed_records:agent-child.jsonl"],
      },
      providerTrace: {
        status: "unavailable",
        reason: "provider_trace_metadata_unavailable",
      },
    });
    expect(JSON.stringify(evidence)).not.toContain("must not be copied");
  });

  it("writes evidence before scratch cleanup", async () => {
    const order: string[] = [];
    await persistCompletionEvidenceBeforeScratchCleanup({
      append: async () => { order.push("evidence"); },
      cleanup: async () => { order.push("cleanup"); return "cleaned"; },
    });
    expect(order).toEqual(["evidence", "cleanup"]);
  });

  it("retains scratch when the completion write fails", async () => {
    const cleanup = vi.fn(async () => undefined);
    await expect(persistCompletionEvidenceBeforeScratchCleanup({
      append: async () => { throw new Error("event sink unavailable"); },
      cleanup,
    })).rejects.toThrow("event sink unavailable");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("uses a trace metadata pointer without copying the trace", () => {
    const evidence = buildRunCompletionEvidence({
      adapterType: "claude_local",
      adapterResultJson: { completionEvidence: transcript },
      providerTrace: {
        id: "trace-42",
        status: "complete",
        expiresAt: new Date(Date.now() + 60_000),
        deletedAt: null,
      },
      providerTraceRequested: true,
    });
    expect(evidence.providerTrace).toEqual({
      status: "available",
      pointer: "provider-trace:trace-42",
      traceStatus: "complete",
    });
  });

  it("survives the actual event bound, redaction, and durable JSON round trip", () => {
    const evidence = buildRunCompletionEvidence({
      adapterType: "claude_local",
      adapterResultJson: { completionEvidence: transcript },
      providerTrace: null,
      providerTraceRequested: false,
    });
    const stored = JSON.parse(JSON.stringify(redactEventPayload(
      boundHeartbeatRunEventPayloadForStorage(evidence),
    )));

    expect(stored).toMatchObject({
      schema: "paperclip.run-completion-evidence.v1",
      transcript: {
        schema: "paperclip.claude-transcript-completion-evidence.v1",
        toolSchemaProjection: "prompt_snapshot_safe_structure.v1",
        files: [{
          fileName: "agent-child.jsonl",
          toolSchemaProjectionStatus: "complete",
        }],
      },
    });
    expect(stored.transcript.files[0].promptSnapshotToolProjections).toHaveLength(1);
    expect(stored.transcript.transcriptTrace).toMatchObject({
      status: "partial",
      scope: "timestamped_records_at_or_after_attempt_start",
      records: [expect.objectContaining({ fileSha256: "a".repeat(64), line: 2 })],
      traceLocator: null,
    });
    expect(JSON.parse(stored.transcript.files[0].promptSnapshotToolProjections[0]))
      .toMatchObject({ name: "Read" });
    expect(JSON.stringify(stored)).not.toContain('"_truncated":true');
  });

  it("locates the persisted transcript trace by run without inventing an event id", () => {
    const evidence = buildRunCompletionEvidence({
      adapterType: "claude_local",
      adapterResultJson: { completionEvidence: transcript },
      providerTrace: null,
      providerTraceRequested: true,
      runId: "00000000-0000-4000-8000-000000000001",
    });
    expect(evidence.transcript).toMatchObject({
      transcriptTrace: {
        status: "partial",
        traceLocator: {
          kind: "heartbeat_run_event_json_pointer",
          runId: "00000000-0000-4000-8000-000000000001",
          eventType: "completion_evidence",
          jsonPointer: "/transcript/transcriptTrace",
        },
      },
    });
    expect(JSON.stringify(evidence)).not.toContain("eventId");
    expect(evidence.providerTrace).toEqual({
      status: "unavailable",
      reason: "provider_trace_metadata_unavailable",
    });
  });

  it("rejects trace records that predate the attempt or cite a different selected file", () => {
    for (const records of [
      [{ ...traceRecords[0]!, timestamp: "2026-09-26T23:59:58Z" }],
      [{ ...traceRecords[0]!, fileSha256: "c".repeat(64) }],
    ]) {
      const evidence = buildRunCompletionEvidence({
        adapterType: "claude_local",
        adapterResultJson: {
          completionEvidence: { ...transcript, transcriptTrace: traceWith(records) },
        },
        providerTrace: null,
        providerTraceRequested: false,
      });
      expect(evidence.transcript).toMatchObject({
        status: "unavailable",
        parseGaps: ["adapter_did_not_report_transcript_evidence"],
      });
    }
  });

  it("keeps storage limits explicit and readable", () => {
    const manyTools = Array.from({ length: 30 }, (_, index) => ({
      name: `Tool${index}`,
      inputSchemaShape: null,
      inputSchemaShapeSha256: null,
    }));
    const evidence = buildRunCompletionEvidence({
      adapterType: "claude_local",
      adapterResultJson: {
        completionEvidence: {
          ...transcript,
          status: "available",
          prompt: "must not be copied",
          files: [{
            ...transcript.files[0],
            promptSnapshotTools: [
              { timestamp: null, tools: manyTools },
              { timestamp: null, tools: manyTools },
            ],
          }],
        },
      },
      providerTrace: null,
      providerTraceRequested: false,
    });
    const stored = JSON.parse(JSON.stringify(redactEventPayload(
      boundHeartbeatRunEventPayloadForStorage(evidence),
    )));
    const file = stored.transcript.files[0];
    expect(file.toolSchemaProjectionStatus).toBe("partial");
    expect(stored.transcript.status).toBe("partial");
    expect(file.promptSnapshotToolProjections).toHaveLength(50);
    expect(JSON.parse(file.promptSnapshotToolProjections[0])).toMatchObject({
      name: "Tool0",
    });
    expect(JSON.stringify(stored)).not.toContain("must not be copied");
    expect(JSON.stringify(stored)).not.toContain('"_truncated":true');
  });

  it("marks excess transcript files partial before the event array bound drops them", () => {
    const evidence = buildRunCompletionEvidence({
      adapterType: "claude_local",
      adapterResultJson: {
        completionEvidence: {
          ...transcript,
          status: "available",
          files: [
            transcript.files[0],
            ...Array.from({ length: 50 }, (_, index) => ({
              ...transcript.files[0],
              fileName: `agent-${index}.jsonl`,
            })),
          ],
        },
      },
      providerTrace: null,
      providerTraceRequested: false,
    });
    const stored = JSON.parse(JSON.stringify(redactEventPayload(
      boundHeartbeatRunEventPayloadForStorage(evidence),
    )));
    expect(stored.transcript).toMatchObject({ status: "partial" });
    expect(stored.transcript.files).toHaveLength(50);
    expect(stored.transcript.parseGaps).toContain(
      "transcript_file_projection_truncated",
    );
    expect(JSON.stringify(stored)).not.toContain('"_truncated":true');
  });

  it("rehashes the final safe schema shape rather than retaining a stale source hash", () => {
    const evidence = buildRunCompletionEvidence({
      adapterType: "claude_local",
      adapterResultJson: {
        completionEvidence: {
          ...transcript,
          files: [{
            ...transcript.files[0],
            promptSnapshotTools: [{
              timestamp: null,
              tools: [{
                name: "Read",
                inputSchemaShape: {
                  type: ["object"], required: ["path"],
                  properties: { path: { type: ["string"], required: [], properties: {}, items: null, variants: [], additionalProperties: null, enumCount: null } },
                  items: null, variants: [], additionalProperties: false, enumCount: null,
                },
                inputSchemaShapeSha256: "a".repeat(64),
              }],
            }],
          }],
        },
      },
      providerTrace: null,
      providerTraceRequested: false,
    });
    expect(evidence.transcript.status).not.toBe("not_applicable");
    if (!("files" in evidence.transcript)) {
      throw new Error("Expected Claude transcript evidence");
    }
    const [file] = evidence.transcript.files;
    if (!file) throw new Error("Expected a Claude transcript file");
    const [serializedProjection] = file.promptSnapshotToolProjections;
    if (!serializedProjection) throw new Error("Expected a tool schema projection");
    const projection = JSON.parse(serializedProjection);
    expect(projection.inputSchemaShapeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(projection.inputSchemaShapeSha256).not.toBe("a".repeat(64));
  });

  it("marks a depth-capped safe schema projection partial", () => {
    let deepShape: Record<string, unknown> = {
      type: ["string"], required: [], properties: {}, items: null,
      variants: [], additionalProperties: null, enumCount: null,
    };
    for (let index = 0; index < 10; index += 1) {
      deepShape = {
        type: ["object"], required: ["next"], properties: { next: deepShape },
        items: null, variants: [], additionalProperties: null, enumCount: null,
      };
    }
    const evidence = buildRunCompletionEvidence({
      adapterType: "claude_local",
      adapterResultJson: {
        completionEvidence: {
          ...transcript,
          status: "available",
          files: [{
            ...transcript.files[0],
            promptSnapshotTools: [{ timestamp: null, tools: [{
              name: "Read", inputSchemaShape: deepShape,
              inputSchemaShapeSha256: "a".repeat(64),
            }] }],
          }],
        },
      },
      providerTrace: null,
      providerTraceRequested: false,
    });
    expect(evidence.transcript).toMatchObject({
      status: "partial",
      files: [{ toolSchemaProjectionStatus: "partial" }],
    });
  });

  it("keeps Codex dynamic-tool evidence explicitly partial and omits trace invention", () => {
    const evidence = buildRunCompletionEvidence({
      adapterType: "codex_local",
      adapterResultJson: { completionEvidence: codexRollout },
      providerTrace: null,
      providerTraceRequested: false,
    });
    expect(evidence).toMatchObject({
      transcript: {
        schema: "paperclip.codex-rollout-completion-evidence.v1",
        status: "partial",
        toolSchemaCoverage: "dynamic_tools_only_partial",
        parseGaps: ["builtin_tool_schema_not_in_rollout_dynamic_tools"],
      },
      providerTrace: { status: "unavailable", reason: "provider_trace_not_requested" },
    });
    expect(JSON.stringify(evidence)).not.toContain("a".repeat(64));
  });

  it("rejects non-string Codex session identifiers while retaining explicit-null unavailability", () => {
    for (const sessionId of [123, true]) {
      const evidence = buildRunCompletionEvidence({
        adapterType: "codex_local",
        adapterResultJson: { completionEvidence: { ...codexRollout, sessionId } },
        providerTrace: null,
        providerTraceRequested: false,
      });
      expect(evidence.transcript).toMatchObject({
        status: "unavailable",
        parseGaps: ["adapter_did_not_report_rollout_evidence"],
      });
    }
    const explicitUnavailable = buildRunCompletionEvidence({
      adapterType: "codex_local",
      adapterResultJson: {
        completionEvidence: {
          ...codexRollout,
          status: "unavailable",
          sessionId: null,
          rollout: null,
          parseGaps: ["codex_run_session_not_observed"],
        },
      },
      providerTrace: null,
      providerTraceRequested: false,
    });
    expect(explicitUnavailable.transcript).toMatchObject({
      status: "unavailable",
      sessionId: null,
      parseGaps: ["codex_run_session_not_observed"],
    });
  });

  it("marks incomplete or expired trace metadata without a usable pointer", () => {
    const incomplete = buildRunCompletionEvidence({
      adapterType: "claude_local",
      adapterResultJson: { completionEvidence: transcript },
      providerTrace: {
        id: "trace-43",
        status: "incomplete",
        expiresAt: new Date(Date.now() + 60_000),
        deletedAt: null,
      },
      providerTraceRequested: true,
    });
    const expired = buildRunCompletionEvidence({
      adapterType: "claude_local",
      adapterResultJson: { completionEvidence: transcript },
      providerTrace: {
        id: "trace-44",
        status: "complete",
        expiresAt: new Date(0),
        deletedAt: null,
      },
      providerTraceRequested: true,
    });
    expect(incomplete.providerTrace).toMatchObject({
      status: "partial",
      pointer: "provider-trace:trace-43",
      reason: "provider_trace_incomplete",
    });
    expect(expired.providerTrace).toEqual({
      status: "unavailable",
      reason: "provider_trace_expired",
    });
  });
});
