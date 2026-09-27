import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureClaudeTranscriptCompletionEvidence } from "./completion-evidence.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-evidence-"));
  roots.push(root);
  const sessionId = "session-123";
  const project = path.join(root, "projects", "workspace");
  const subagents = path.join(project, sessionId, "subagents");
  await mkdir(subagents, { recursive: true });
  return { root, sessionId, project, subagents };
}

describe("captureClaudeTranscriptCompletionEvidence", () => {
  it("captures the allowlisted transcript metadata before cleanup", async () => {
    const { root, sessionId, project, subagents } = await fixture();
    await writeFile(path.join(project, `${sessionId}.jsonl`), [
      JSON.stringify({ type: "assistant", timestamp: "2026-09-27T00:00:00Z", effort: "high", message: { model: "claude-opus", content: [] } }),
      JSON.stringify({ type: "user", timestamp: "2026-09-27T00:00:01Z", prompt_snapshot: { tools: [{ name: "Read", description: "secret prompt must not be retained" }, { name: "Grep", input_schema: { token: "secret" } }] } }),
    ].join("\n"));
    await writeFile(path.join(subagents, "agent-child.jsonl"), [
      JSON.stringify({ type: "assistant", timestamp: "2026-09-27T00:00:02Z", effort: "low", message: { model: "claude-sonnet", content: [] } }),
      JSON.stringify({ type: "user", timestamp: "2026-09-27T00:00:03Z", prompt_snapshot: { tools: [{ name: "Read" }, { name: "SubagentHandback" }] } }),
    ].join("\n"));

    const evidence = await captureClaudeTranscriptCompletionEvidence({ configDir: root, sessionId, attemptStartedAt: "2026-09-26T23:59:59Z", resumed: false });
    expect(evidence.status).toBe("available");
    expect(evidence.files).toHaveLength(2);
    expect(evidence).toMatchObject({
      toolSchemaProjection: "prompt_snapshot_safe_structure.v1",
    });
    expect(evidence.files[1]).toMatchObject({
      role: "child",
      models: ["claude-sonnet"],
      effort: ["low"],
      effortStatus: "available",
      toolSchemaStatus: "available",
      promptSnapshotTools: [{
        tools: [{ name: "Read" }, { name: "SubagentHandback" }],
      }],
    });
    expect(evidence.files[0]?.promptSnapshotTools[0]?.tools[1]).toMatchObject({
      name: "Grep",
      inputSchemaShape: { type: [], required: [], properties: {} },
    });
    expect(JSON.stringify(evidence)).not.toContain("secret");
    expect(JSON.stringify(evidence)).not.toContain("input_schema");
    expect(evidence.transcriptTrace).toMatchObject({
      status: "partial",
      scope: "timestamped_records_at_or_after_attempt_start",
      ordering: "source_file_then_line",
    });
    expect(evidence.transcriptTrace.records.slice(0, 2)).toEqual([
      expect.objectContaining({ role: "parent", line: 1, recordType: "assistant", timestamp: "2026-09-27T00:00:00Z", model: "claude-opus" }),
      expect.objectContaining({ role: "parent", line: 2, recordType: "user", timestamp: "2026-09-27T00:00:01Z" }),
    ]);
    expect(evidence.transcriptTrace.records[1]?.toolSchemaHashes).toHaveLength(1);
    expect(evidence.transcriptTrace.recordSetSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps malformed transcript chunks explicit", async () => {
    const { root, sessionId, project } = await fixture();
    await writeFile(path.join(project, `${sessionId}.jsonl`), "{not json}\n" + JSON.stringify({ type: "assistant", message: { model: "claude-opus" } }));
    const evidence = await captureClaudeTranscriptCompletionEvidence({ configDir: root, sessionId, attemptStartedAt: "2026-09-26T23:59:59Z", resumed: false });
    expect(evidence.status).toBe("unavailable");
    expect(evidence.parseGaps).toContain("parent_transcript_malformed_records");
    expect(evidence.files[0]?.malformedRecordCount).toBe(1);
  });

  it("rejects a session path instead of traversing outside the Claude config", async () => {
    const { root } = await fixture();
    const evidence = await captureClaudeTranscriptCompletionEvidence({ configDir: root, sessionId: "../outside", attemptStartedAt: "2026-09-26T23:59:59Z", resumed: false });
    expect(evidence).toMatchObject({ status: "unavailable", files: [], parseGaps: ["invalid_session_id"] });
  });

  it("marks absent tool snapshots and effort unavailable instead of inventing them", async () => {
    const { root, sessionId, project } = await fixture();
    await writeFile(
      path.join(project, `${sessionId}.jsonl`),
      JSON.stringify({ type: "assistant", message: { model: "claude-opus" } }),
    );
    const evidence = await captureClaudeTranscriptCompletionEvidence({ configDir: root, sessionId, attemptStartedAt: "2026-09-26T23:59:59Z", resumed: false });
    expect(evidence).toMatchObject({
      status: "unavailable",
      files: [{ effortStatus: "unavailable", toolSchemaStatus: "unavailable" }],
    });
    expect(evidence.parseGaps).toEqual(expect.arrayContaining([
      "parent_effort_unavailable",
      "parent_tool_schema_unavailable",
    ]));
  });

  it("preserves a current names-only tool snapshot outside the hash-only trace", async () => {
    const { root, sessionId, project } = await fixture();
    await writeFile(
      path.join(project, `${sessionId}.jsonl`),
      JSON.stringify({ type: "user", timestamp: "2026-09-27T00:00:01Z", prompt_snapshot: { tools: [{ name: "Read" }, { name: "SubagentHandback" }] } }),
    );
    const evidence = await captureClaudeTranscriptCompletionEvidence({
      configDir: root,
      sessionId,
      attemptStartedAt: "2026-09-27T00:00:00Z",
      resumed: true,
    });
    expect(evidence).toMatchObject({
      status: "unavailable",
      files: [{ toolSchemaStatus: "available", promptSnapshotTools: [{ tools: [{ name: "Read" }, { name: "SubagentHandback" }] }] }],
      transcriptTrace: { status: "unavailable", records: [] },
    });
  });

  it("excludes earlier resumed-session metadata from this attempt", async () => {
    const { root, sessionId, project } = await fixture();
    await writeFile(path.join(project, `${sessionId}.jsonl`), [
      JSON.stringify({ type: "assistant", timestamp: "2026-09-26T23:59:59Z", effort: "old", message: { model: "claude-old" } }),
      JSON.stringify({ type: "user", timestamp: "2026-09-27T00:00:01+00:00", prompt_snapshot: { tools: [{ name: "Read", input_schema: { type: "object" } }] } }),
    ].join("\n"));
    const evidence = await captureClaudeTranscriptCompletionEvidence({
      configDir: root,
      sessionId,
      attemptStartedAt: "2026-09-27T00:00:00Z",
      resumed: true,
    });
    expect(evidence.attempt).toEqual({ startedAt: "2026-09-27T00:00:00Z", resumed: true });
    expect(evidence.files[0]).toMatchObject({ models: [], effort: [], effortStatus: "unavailable" });
    expect(evidence.files[0]?.promptSnapshotTools).toHaveLength(1);
    expect(evidence.transcriptTrace.records).toEqual([expect.objectContaining({ line: 2, model: null, effort: null })]);
    expect(evidence.parseGaps).toContain("trace_record_before_attempt_excluded");
    expect(JSON.stringify(evidence)).not.toContain("claude-old");
    expect(JSON.stringify(evidence)).not.toContain('"old"');
  });

  it("marks an attempt without timestamped current records unavailable", async () => {
    const { root, sessionId, project } = await fixture();
    await writeFile(path.join(project, `${sessionId}.jsonl`), JSON.stringify({ type: "assistant", message: { model: "claude-opus" } }));
    const evidence = await captureClaudeTranscriptCompletionEvidence({
      configDir: root,
      sessionId,
      attemptStartedAt: "2026-09-27T00:00:00Z",
      resumed: true,
    });
    expect(evidence).toMatchObject({ status: "unavailable" });
    expect(evidence.transcriptTrace).toMatchObject({ status: "unavailable", records: [] });
    expect(evidence.parseGaps).toContain("current_attempt_trace_records_unavailable");
  });
});
