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

    const evidence = await captureClaudeTranscriptCompletionEvidence({ configDir: root, sessionId });
    expect(evidence.status).toBe("available");
    expect(evidence.files).toHaveLength(2);
    expect(evidence).toMatchObject({
      toolSchemaProjection: "prompt_snapshot_safe_structure.v1",
    });
    expect(evidence.files[1]).toMatchObject({
      role: "child",
      models: ["claude-sonnet"],
      effort: ["low"],
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
  });

  it("keeps malformed transcript chunks explicit", async () => {
    const { root, sessionId, project } = await fixture();
    await writeFile(path.join(project, `${sessionId}.jsonl`), "{not json}\n" + JSON.stringify({ type: "assistant", message: { model: "claude-opus" } }));
    const evidence = await captureClaudeTranscriptCompletionEvidence({ configDir: root, sessionId });
    expect(evidence.status).toBe("partial");
    expect(evidence.parseGaps).toContain("parent_transcript_malformed_records");
    expect(evidence.files[0]?.malformedRecordCount).toBe(1);
  });

  it("rejects a session path instead of traversing outside the Claude config", async () => {
    const { root } = await fixture();
    const evidence = await captureClaudeTranscriptCompletionEvidence({ configDir: root, sessionId: "../outside" });
    expect(evidence).toMatchObject({ status: "unavailable", files: [], parseGaps: ["invalid_session_id"] });
  });
});
