import { describe, expect, it, vi } from "vitest";
import { redactEventPayload } from "../redaction.js";
import { boundHeartbeatRunEventPayloadForStorage } from "./run-event-payload-bounds.js";
import {
  buildRunCompletionEvidence,
  persistCompletionEvidenceBeforeScratchCleanup,
} from "./run-completion-evidence.js";

const transcript = {
  schema: "paperclip.claude-transcript-completion-evidence.v1" as const,
  status: "partial" as const,
  source: "claude_config_transcript" as const,
  sessionId: "session-123",
  toolSchemaProjection: "prompt_snapshot_safe_structure.v1" as const,
  files: [{
    role: "child" as const,
    fileName: "agent-child.jsonl",
    sha256: "a".repeat(64),
    bytes: 42,
    models: ["claude-sonnet"],
    effort: ["low"],
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
    expect(JSON.parse(stored.transcript.files[0].promptSnapshotToolProjections[0]))
      .toMatchObject({ name: "Read" });
    expect(JSON.stringify(stored)).not.toContain('"_truncated":true');
  });

  it("keeps storage limits explicit and readable", () => {
    const manyTools = Array.from({ length: 51 }, (_, index) => ({
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
            promptSnapshotTools: [{ timestamp: null, tools: manyTools }],
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

  it("does not claim a Claude transcript for another adapter", () => {
    const evidence = buildRunCompletionEvidence({
      adapterType: "codex_local",
      adapterResultJson: { completionEvidence: transcript },
      providerTrace: null,
      providerTraceRequested: false,
    });
    expect(evidence.transcript).toEqual({
      status: "not_applicable",
      reason: "adapter_not_claude_local",
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
