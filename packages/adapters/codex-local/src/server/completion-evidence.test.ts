import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureCodexRolloutCompletionEvidence } from "./completion-evidence.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-evidence-"));
  roots.push(root);
  const sessionId = "019cabcd-1234-7abc-8def-0123456789ab";
  const rolloutDir = path.join(root, "sessions", "2026", "09", "27");
  await mkdir(rolloutDir, { recursive: true });
  return { root, sessionId, rollout: path.join(rolloutDir, `rollout-2026-09-27T00-00-00-${sessionId}.jsonl`) };
}

function metadata(sessionId: string, dynamicTools: unknown[] = []) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { session_id: sessionId, dynamic_tools: dynamicTools, base_instructions: "must never be retained" },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-sol", effort: "high", turn_id: "turn-safe" } }),
  ].join("\n");
}

describe("captureCodexRolloutCompletionEvidence", () => {
  it("projects only resolved rollout metadata and marks dynamic-tool coverage partial", async () => {
    const { root, sessionId, rollout } = await fixture();
    await writeFile(rollout, metadata(sessionId, [{
      name: "mcp__company__read_issue",
      inputSchema: {
        type: "object", required: ["issueId"], properties: { issueId: { type: "string", description: "secret" } },
        enum: ["do-not-retain"], examples: ["do-not-retain"], additionalProperties: false,
      },
    }]));

    const evidence = await captureCodexRolloutCompletionEvidence({ codexHome: root, sessionId });
    expect(evidence).toMatchObject({
      status: "partial", source: "codex_rollout_session", toolSchemaCoverage: "dynamic_tools_only_partial",
      rollout: { models: ["gpt-6-sol"], effort: ["high"], effortStatus: "available", dynamicToolSchemaStatus: "available" },
    });
    expect(evidence.rollout?.dynamicTools[0]).toMatchObject({
      name: "mcp__company__read_issue",
      inputSchemaShape: { type: ["object"], required: ["issueId"], properties: ["issueId"], enumCount: 1 },
      inputSchemaShapeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(evidence.parseGaps).toContain("builtin_tool_schema_not_in_rollout_dynamic_tools");
    expect(JSON.stringify(evidence)).not.toContain("secret");
    expect(JSON.stringify(evidence)).not.toContain("do-not-retain");
    expect(evidence.rollout).toMatchObject({
      sessionBinding: "session_meta.payload.session_id",
      fieldProvenance: { model: "turn_context", effort: "turn_context", dynamicTools: "session_meta" },
    });
    expect(JSON.stringify(evidence)).not.toContain("base_instructions");
  });

  it("rejects malformed session identifiers and never traverses from them", async () => {
    const { root } = await fixture();
    await expect(captureCodexRolloutCompletionEvidence({ codexHome: root, sessionId: "../outside" }))
      .resolves.toMatchObject({ status: "unavailable", parseGaps: ["invalid_session_id"] });
  });

  it("does not use a same-named rollout that contains another session", async () => {
    const { root, sessionId, rollout } = await fixture();
    await writeFile(rollout, metadata("019cffff-1234-7abc-8def-0123456789ab"));
    const evidence = await captureCodexRolloutCompletionEvidence({ codexHome: root, sessionId });
    expect(evidence).toMatchObject({ status: "unavailable", parseGaps: ["codex_rollout_session_meta_mismatch_or_conflict"] });
  });

  it("keeps malformed rows explicit and unavailable fields unavailable", async () => {
    const { root, sessionId, rollout } = await fixture();
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { session_id: sessionId, dynamic_tools: [] } }),
      "{not-json}",
      JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-safe" } }),
    ].join("\n"));
    const evidence = await captureCodexRolloutCompletionEvidence({ codexHome: root, sessionId });
    expect(evidence).toMatchObject({
      status: "partial",
      rollout: { effortStatus: "unavailable", dynamicToolSchemaStatus: "unavailable", malformedRecordCount: 1 },
    });
    expect(evidence.parseGaps).toEqual(expect.arrayContaining([
      "codex_rollout_malformed_records", "codex_rollout_effort_unavailable", "codex_rollout_dynamic_tools_unavailable",
    ]));
  });

  it("refuses a rollout symlink even when its target has a matching session", async () => {
    const { root, sessionId, rollout } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-evidence-outside-"));
    roots.push(outside);
    const target = path.join(outside, path.basename(rollout));
    await writeFile(target, metadata(sessionId));
    await symlink(target, rollout, "file");
    await expect(captureCodexRolloutCompletionEvidence({ codexHome: root, sessionId }))
      .resolves.toMatchObject({ status: "unavailable", parseGaps: ["codex_rollout_unavailable"] });
  });

  it("ignores spoofed non-native record kinds and rejects mixed session metadata", async () => {
    const { root, sessionId, rollout } = await fixture();
    await writeFile(rollout, [
      metadata(sessionId),
      JSON.stringify({ type: "response_item", payload: { session_id: sessionId, effort: "max", dynamic_tools: [{ name: "spoof" }] } }),
      JSON.stringify({ type: "event_msg", payload: { session_id: sessionId, effort: "max" } }),
    ].join("\n"));
    const evidence = await captureCodexRolloutCompletionEvidence({ codexHome: root, sessionId });
    expect(evidence.rollout?.effort).toEqual(["high"]);
    expect(evidence.rollout?.dynamicTools.map((tool) => tool.name)).not.toContain("spoof");

    await writeFile(rollout, metadata(sessionId) + "\n" + JSON.stringify({
      type: "session_meta", payload: { session_id: "019cffff-1234-7abc-8def-0123456789ab", dynamic_tools: [] },
    }));
    await expect(captureCodexRolloutCompletionEvidence({ codexHome: root, sessionId }))
      .resolves.toMatchObject({ status: "unavailable", parseGaps: ["codex_rollout_session_meta_mismatch_or_conflict"] });
  });
});
