import { afterEach, describe, expect, it, vi } from "vitest";
import { issueExecutionPolicySchema, type IssueExecutionPolicy } from "@paperclipai/shared";
import { buildExecutionPolicy } from "./issue-execution-policy";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const retainedFields = {
  requiredCapabilities: {
    version: 1,
    items: [{ kind: "tool", runtime: "codex_cli", name: "shell", authorization: "conditional_ok", when: { agentId: AGENT_ID } }],
  },
  reviewPreset: { id: "low_trust_review", version: 1, rawOutputDisposition: "quarantine" },
  authorizationPolicy: { trustPreset: "low_trust_review" },
  maxReviewRounds: 5,
} satisfies Partial<IssueExecutionPolicy>;
const monitor = { nextCheckAt: "2026-09-28T12:00:00.000Z", notes: "Check again", scheduledBy: "board" } as const;

describe("buildExecutionPolicy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates schema-valid UUIDs when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = index;
        }
        return bytes;
      },
    });

    const policy = buildExecutionPolicy({
      existingPolicy: null,
      reviewerValues: [`agent:${AGENT_ID}`],
      approverValues: ["user:local-board"],
    });

    expect(policy).not.toBeNull();
    expect(issueExecutionPolicySchema.safeParse(policy).success).toBe(true);
    expect(policy?.stages).toHaveLength(2);

    for (const stage of policy?.stages ?? []) {
      expect(stage.id).toMatch(UUID_PATTERN);
      expect(stage.participants).toHaveLength(1);
      expect(stage.participants[0]?.id).toMatch(UUID_PATTERN);
    }
  });

  it("preserves unrelated policy fields and the monitor in participant replacement payloads", () => {
    const existingPolicy: IssueExecutionPolicy = { mode: "normal", commentRequired: true, stages: [], ...retainedFields, monitor };
    const before = JSON.stringify(existingPolicy);
    const added = buildExecutionPolicy({ existingPolicy, reviewerValues: [`agent:${AGENT_ID}`], approverValues: [] });
    expect(added).toEqual({ ...existingPolicy, stages: [expect.objectContaining({ type: "review" })] });
    expect(issueExecutionPolicySchema.safeParse(added).success).toBe(true);
    const replaced = buildExecutionPolicy({ existingPolicy: added, reviewerValues: [], approverValues: ["user:local-board"] });
    expect(replaced).toEqual({ ...existingPolicy, stages: [expect.objectContaining({ type: "approval" })] });
    expect(JSON.stringify(existingPolicy)).toBe(before);
  });

  it.each(["requiredCapabilities", "reviewPreset", "authorizationPolicy"] as const)(
    "keeps a %s-only policy when the last participant is removed",
    (key) => {
      const existingPolicy: IssueExecutionPolicy = {
        mode: "normal", commentRequired: true, stages: [], [key]: retainedFields[key],
      };
      const withReviewer = buildExecutionPolicy({ existingPolicy, reviewerValues: [`agent:${AGENT_ID}`], approverValues: [] });
      expect(buildExecutionPolicy({ existingPolicy: withReviewer, reviewerValues: [], approverValues: [] })).toEqual(existingPolicy);
    },
  );

  it("preserves unrelated fields through monitor add, replace and clear payloads", () => {
    const existingPolicy = buildExecutionPolicy({
      existingPolicy: { mode: "normal", commentRequired: true, stages: [], ...retainedFields },
      reviewerValues: [`agent:${AGENT_ID}`], approverValues: [],
    });
    const selections = { reviewerValues: [`agent:${AGENT_ID}`], approverValues: [] };
    const added = buildExecutionPolicy({ existingPolicy, ...selections, monitor });
    expect(added).toEqual({ ...existingPolicy, monitor });
    const replacement = { ...monitor, nextCheckAt: "2026-09-29T12:00:00.000Z" };
    const replaced = buildExecutionPolicy({ existingPolicy: added, ...selections, monitor: replacement });
    expect(replaced).toEqual({ ...existingPolicy, monitor: replacement });
    const cleared = buildExecutionPolicy({ existingPolicy: replaced, ...selections, monitor: null });
    expect(cleared).toEqual(existingPolicy);
    expect(cleared).not.toHaveProperty("monitor");
    expect(added?.monitor).toEqual(monitor);
    expect(issueExecutionPolicySchema.safeParse(cleared).success).toBe(true);
  });

  it("returns null for genuinely empty policies and clearing a monitor-only policy", () => {
    const selections = { reviewerValues: [], approverValues: [] };
    expect(buildExecutionPolicy({ existingPolicy: null, ...selections })).toBeNull();
    const monitorOnly = buildExecutionPolicy({ existingPolicy: null, ...selections, monitor });
    expect(monitorOnly).toEqual({ mode: "normal", commentRequired: true, stages: [], monitor });
    expect(buildExecutionPolicy({ existingPolicy: monitorOnly, ...selections, monitor: null })).toBeNull();
    const reviewerOnly = buildExecutionPolicy({ existingPolicy: null, reviewerValues: [`agent:${AGENT_ID}`], approverValues: [] });
    expect(buildExecutionPolicy({ existingPolicy: reviewerOnly, ...selections })).toBeNull();
  });
});
