import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const execute = vi.hoisted(() => vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "capability test", provider: "test", model: "test" })));
vi.mock("../adapters/index.js", async () => ({
  ...(await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js")),
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })),
}));

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

describeEmbedded("heartbeat required capability admission", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-required-capabilities-");
    db = createDb(temp.connectionString);
  }, 20_000);
  afterAll(async () => { await temp?.cleanup(); });
  afterEach(async () => {
    execute.mockReset();
    execute.mockImplementation(async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "capability test", provider: "test", model: "test" }));
    await db.delete(heartbeatRuns);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seed(policy: Record<string, unknown>, adapterConfig: Record<string, unknown> = { engine: "cli" }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Capability test", issuePrefix: "CAP", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Runner", role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig, runtimeConfig: { heartbeat: { wakeOnDemand: true } }, permissions: {},
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Required capability", status: "todo", priority: "medium", assigneeAgentId: agentId, executionPolicy: policy });
    return { companyId, agentId, issueId };
  }

  async function grantAgentPermission(companyId: string, agentId: string, permissionKey: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey,
      grantedByUserId: null,
    });
  }

  async function installSelectedLocalSkill(companyId: string) {
    const key = `company/${companyId}/required-skill`;
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-required-skill-"));
    await fs.writeFile(path.join(source, "SKILL.md"), "# Required skill\n", "utf8");
    await db.insert(companySkills).values({
      companyId,
      key,
      slug: "required-skill",
      name: "Required skill",
      description: null,
      markdown: "# Required skill\n",
      sourceType: "local_path",
      sourceLocator: source,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "local_path" },
    });
    return { key, source };
  }

  async function wakeAutomation(
    heartbeat: ReturnType<typeof heartbeatService>,
    agentId: string,
    issueId: string,
    context: Record<string, unknown> = {},
    payload: Record<string, unknown> = {},
  ) {
    return heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "capability-test",
      reason: "issue_commented",
      payload: { issueId, ...payload },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", ...context },
      requestedByActorType: "user",
      requestedByActorId: "capability-test-user",
    });
  }

  async function expectUnstarted(companyId: string) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(run).toMatchObject({ status: "queued", startedAt: null });
    expect(execute).not.toHaveBeenCalled();
  }

  it("cancels an unmet catalog before startedAt or provider execution", async () => {
    const { companyId, agentId, issueId } = await seed({ requiredCapabilities: { version: 1, items: [
      { kind: "tool", runtime: "claude_cli", name: "Bash", authorization: "conditional_ok" },
    ] } });
    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "capability-test", contextSnapshot: { issueId } });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(run).toMatchObject({ status: "cancelled", startedAt: null, errorCode: "required_capabilities_unavailable" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves legacy execution when no catalog is declared", async () => {
    const { agentId, issueId } = await seed({});
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "capability-test", contextSnapshot: { issueId } });
    if (run) await heartbeat.waitForRunExecutionDrain(run.id);
    expect(execute).toHaveBeenCalled();
  });

  it("admits the selected local Codex shell capability", async () => {
    const { agentId, issueId } = await seed({ requiredCapabilities: { version: 1, items: [
      { kind: "tool", runtime: "codex_cli", name: "shell", authorization: "conditional_ok" },
    ] } });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "capability-test", contextSnapshot: { issueId } });
    if (run) await heartbeat.waitForRunExecutionDrain(run.id);
    expect(execute).toHaveBeenCalled();
  });

  it("admits a selected local skill and an active agent grant", async () => {
    const { companyId, agentId, issueId } = await seed({});
    const { key, source } = await installSelectedLocalSkill(companyId);
    await db.update(agents).set({
      adapterConfig: { engine: "cli", paperclipSkillSync: { desiredSkills: [key] } },
    }).where(eq(agents.id, agentId));
    await db.update(issues).set({ executionPolicy: { requiredCapabilities: { version: 1, items: [
      { kind: "skill", key },
      { kind: "permission", key: "agents:suggest-changes" },
      { kind: "tool", runtime: "codex_cli", name: "shell", authorization: "conditional_ok" },
    ] } }).where(eq(issues.id, issueId));
    await grantAgentPermission(companyId, agentId, "agents:suggest-changes");
    try {
      const heartbeat = heartbeatService(db);
      const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "capability-test", contextSnapshot: { issueId } });
      if (run) await heartbeat.waitForRunExecutionDrain(run.id);
      expect(execute).toHaveBeenCalled();
    } finally {
      await fs.rm(source, { recursive: true, force: true });
    }
  });

  it("does not start when requirements appear after a legacy phase-A read", async () => {
    const { companyId, agentId, issueId } = await seed({});
    let changed = false;
    const heartbeat = heartbeatService(db, {
      beforeChatControlRecoveryCheck: async ({ stage }) => {
        if (stage !== "claim" || changed) return;
        changed = true;
        await db.update(issues).set({ executionPolicy: { requiredCapabilities: { version: 1, items: [
          { kind: "tool", runtime: "claude_cli", name: "Bash", authorization: "conditional_ok" },
        ] } } }).where(eq(issues.id, issueId));
      },
    });
    await wakeAutomation(heartbeat, agentId, issueId);
    await expectUnstarted(companyId);
  });

  it("does not start when the phase-A agent config changes", async () => {
    const policy = { requiredCapabilities: { version: 1, items: [
      { kind: "tool", runtime: "codex_cli", name: "shell", authorization: "conditional_ok" },
    ] } };
    const { companyId, agentId, issueId } = await seed(policy);
    let changed = false;
    const heartbeat = heartbeatService(db, {
      beforeChatControlRecoveryCheck: async ({ stage }) => {
        if (stage !== "claim" || changed) return;
        changed = true;
        await db.update(agents).set({ adapterConfig: { engine: "cli", disable: "shell_tool" } }).where(eq(agents.id, agentId));
      },
    });
    await wakeAutomation(heartbeat, agentId, issueId);
    await expectUnstarted(companyId);
  });

  it("does not start when the active agent grant is revoked after phase A", async () => {
    const policy = { requiredCapabilities: { version: 1, items: [
      { kind: "permission", key: "agents:suggest-changes" },
    ] } };
    const { companyId, agentId, issueId } = await seed(policy);
    await grantAgentPermission(companyId, agentId, "agents:suggest-changes");
    let changed = false;
    const heartbeat = heartbeatService(db, {
      beforeChatControlRecoveryCheck: async ({ stage }) => {
        if (stage !== "claim" || changed) return;
        changed = true;
        await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, agentId));
      },
    });
    await wakeAutomation(heartbeat, agentId, issueId);
    await expectUnstarted(companyId);
  });

  it("does not start when the selected skill row changes after phase A", async () => {
    const { companyId, agentId, issueId } = await seed({});
    const { key, source } = await installSelectedLocalSkill(companyId);
    await db.update(agents).set({
      adapterConfig: { engine: "cli", paperclipSkillSync: { desiredSkills: [key] } },
    }).where(eq(agents.id, agentId));
    await db.update(issues).set({ executionPolicy: { requiredCapabilities: { version: 1, items: [{ kind: "skill", key }] } } }).where(eq(issues.id, issueId));
    let changed = false;
    const heartbeat = heartbeatService(db, {
      beforeChatControlRecoveryCheck: async ({ stage }) => {
        if (stage !== "claim" || changed) return;
        changed = true;
        await db.update(companySkills).set({ updatedAt: new Date(Date.now() + 1_000) }).where(eq(companySkills.key, key));
      },
    });
    try {
      await wakeAutomation(heartbeat, agentId, issueId);
      await expectUnstarted(companyId);
    } finally {
      await fs.rm(source, { recursive: true, force: true });
    }
  });

  it.each([
    ["legacy direct-comment", (commentId: string) => ({ context: { wakeCommentIds: [commentId] }, payload: { commentId } })],
    ["authoritative queued-message", (commentId: string) => ({ context: { wakeCommentIds: [commentId] }, payload: { _paperclipWakeContext: { wakeCommentIds: [commentId] } } })],
  ])("claims the %s queued-comment transition after preflight", async (_name, makeContext) => {
    const policy = { requiredCapabilities: { version: 1, items: [
      { kind: "tool", runtime: "codex_cli", name: "shell", authorization: "conditional_ok" },
    ] } };
    const { companyId, agentId, issueId } = await seed(policy);
    const [comment] = await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: "capability-test-user",
      body: "Please continue.",
    }).returning();
    const { context, payload } = makeContext(comment!.id);
    const heartbeat = heartbeatService(db);
    const run = await wakeAutomation(heartbeat, agentId, issueId, context, payload);
    if (run) await heartbeat.waitForRunExecutionDrain(run.id);
    expect(execute).toHaveBeenCalled();
  });
});
