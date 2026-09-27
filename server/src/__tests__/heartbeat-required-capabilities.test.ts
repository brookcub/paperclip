import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  environments,
  heartbeatRuns,
  issueComments,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { companySkillService } from "../services/company-skills.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { PAPERCLIP_OPERATIONAL_SKILL_KEY } from "@paperclipai/adapter-utils/server-utils";

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
  let oldPaperclipHome: string | undefined;
  let oldPaperclipApiUrl: string | undefined;
  let paperclipHome: string | null = null;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-required-capabilities-");
    db = createDb(temp.connectionString);
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-required-capabilities-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    oldPaperclipApiUrl = process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100/api";
  }, 60_000);
  afterAll(async () => {
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (oldPaperclipApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = oldPaperclipApiUrl;
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
    await db.$client?.end?.({ timeout: 0 });
    await temp?.cleanup();
  });
  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    execute.mockReset();
    execute.mockImplementation(async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "capability test", provider: "test", model: "test" }));
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "environment_leases",
        "environments",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "principal_permission_grants",
        "company_memberships",
        "issue_comments",
        "issues",
        "company_skill_versions",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  async function seed(policy: Record<string, unknown>, adapterConfig: Record<string, unknown> = { engine: "cli" }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Capability test",
      issuePrefix: `CAP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    // The embedded database initializes the single local environment allowed
    // by environments_local_driver_idx. Reuse it rather than adding a second.
    const local = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.driver, "local"))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!local) {
      await db.insert(environments).values({
        name: `Capability local ${companyId}`,
        driver: "local",
        status: "active",
        config: {},
        envVars: {},
      });
    }
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

  async function installSelectedLocalSkill(companyId: string, key = `company/${companyId}/required-skill`) {
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

  async function expectExecuted(
    heartbeat: ReturnType<typeof heartbeatService>,
    run: Awaited<ReturnType<typeof heartbeat.wakeup>>,
    timeoutMs = 10_000,
  ) {
    if (!run) throw new Error("Expected the capability-admitted run to be queued");
    const deadline = Date.now() + timeoutMs;
    let settled = await heartbeat.getRun(run.id);
    while (settled && ["queued", "running"].includes(settled.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      settled = await heartbeat.getRun(run.id);
    }
    await heartbeat.drainActiveRunExecutions();
    settled = await heartbeat.getRun(run.id);
    expect(settled?.status).toBe("succeeded");
    expect(execute).toHaveBeenCalled();
  }

  async function wakeQueuedAutomation(
    heartbeat: ReturnType<typeof heartbeatService>,
    companyId: string,
    agentId: string,
    issueId: string,
  ) {
    const [comment] = await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: "capability-test-user",
      body: "Please continue.",
    }).returning();
    return wakeAutomation(
      heartbeat,
      agentId,
      issueId,
      { wakeCommentIds: [comment!.id] },
      { commentId: comment!.id },
    );
  }

  it("cancels an unmet catalog before startedAt or provider execution", async () => {
    const { companyId, agentId, issueId } = await seed({ requiredCapabilities: { version: 1, items: [
      { kind: "tool", runtime: "claude_cli", name: "Bash", authorization: "conditional_ok" },
    ] } });
    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "capability-test", contextSnapshot: { issueId } });
    await heartbeat.drainActiveRunExecutions();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run).toMatchObject({ status: "cancelled", startedAt: null, errorCode: "required_capabilities_unavailable" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves legacy execution when no catalog is declared", async () => {
    const { agentId, issueId } = await seed({});
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "capability-test", contextSnapshot: { issueId } });
    await expectExecuted(heartbeat, run);
  });

  it("admits the selected local Codex shell capability", async () => {
    const { agentId, issueId } = await seed({ requiredCapabilities: { version: 1, items: [
      { kind: "tool", runtime: "codex_cli", name: "shell", authorization: "conditional_ok" },
    ] } });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "capability-test", contextSnapshot: { issueId } });
    await expectExecuted(heartbeat, run);
  });

  it("admits the dispatch-created local default for a required Codex tool", async () => {
    const { agentId, issueId } = await seed({ requiredCapabilities: { version: 1, items: [
      { kind: "tool", runtime: "codex_cli", name: "shell", authorization: "conditional_ok" },
    ] } });
    await db.delete(environments).where(eq(environments.driver, "local"));
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "capability-test", contextSnapshot: { issueId } });
    await expectExecuted(heartbeat, run);
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
    ] } } }).where(eq(issues.id, issueId));
    await grantAgentPermission(companyId, agentId, "agents:suggest-changes");
    try {
      const heartbeat = heartbeatService(db);
      const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "capability-test", contextSnapshot: { issueId } });
      await expectExecuted(heartbeat, run);
    } finally {
      await fs.rm(source, { recursive: true, force: true });
    }
  });

  it("admits the inventory-selected legacy default core skill", async () => {
    const { companyId, agentId, issueId } = await seed({
      requiredCapabilities: { version: 1, items: [{ kind: "skill", key: PAPERCLIP_OPERATIONAL_SKILL_KEY }] },
    });
    const beforeWake = await db
      .select({ key: companySkills.key })
      .from(companySkills)
      .where(and(
        eq(companySkills.companyId, companyId),
        eq(companySkills.key, PAPERCLIP_OPERATIONAL_SKILL_KEY),
      ));
    expect(beforeWake).toEqual([]);
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "capability-test", contextSnapshot: { issueId } });
    await expectExecuted(heartbeat, run, 30_000);
    const selected = await companySkillService(db).listRuntimeSkillEntries(companyId);
    expect(selected).toContainEqual(expect.objectContaining({
      key: PAPERCLIP_OPERATIONAL_SKILL_KEY,
      sourceStatus: "available",
    }));
  }, 45_000);

  it("refuses a Codex CLI capability on a selected remote target", async () => {
    const policy = { requiredCapabilities: { version: 1, items: [
      { kind: "tool", runtime: "codex_cli", name: "shell", authorization: "conditional_ok" },
    ] } };
    const { companyId, agentId, issueId } = await seed(policy);
    const [remote] = await db.insert(environments).values({
      name: `Capability remote ${companyId}`,
      driver: "sandbox",
      status: "active",
      config: {},
      envVars: {},
    }).returning();
    await db.update(agents).set({ defaultEnvironmentId: remote!.id }).where(eq(agents.id, agentId));
    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "capability-test", contextSnapshot: { issueId } });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(run).toMatchObject({ status: "cancelled", startedAt: null, errorCode: "required_capabilities_unavailable" });
    expect(execute).not.toHaveBeenCalled();
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
    await wakeQueuedAutomation(heartbeat, companyId, agentId, issueId);
    await heartbeat.drainActiveRunExecutions();
    expect(changed).toBe(true);
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
    await wakeQueuedAutomation(heartbeat, companyId, agentId, issueId);
    await heartbeat.drainActiveRunExecutions();
    expect(changed).toBe(true);
    await expectUnstarted(companyId);
  });

  it("does not start when the selected target changes after phase A", async () => {
    const policy = { requiredCapabilities: { version: 1, items: [
      { kind: "tool", runtime: "codex_cli", name: "shell", authorization: "conditional_ok" },
    ] } };
    const { companyId, agentId, issueId } = await seed(policy);
    const [local] = await db.select().from(environments).where(eq(environments.driver, "local"));
    let changed = false;
    const heartbeat = heartbeatService(db, {
      beforeChatControlRecoveryCheck: async ({ stage }) => {
        if (stage !== "claim" || changed) return;
        changed = true;
        await db.update(environments).set({ driver: "sandbox" }).where(eq(environments.id, local!.id));
      },
    });
    await wakeQueuedAutomation(heartbeat, companyId, agentId, issueId);
    await heartbeat.drainActiveRunExecutions();
    expect(changed).toBe(true);
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
    await wakeQueuedAutomation(heartbeat, companyId, agentId, issueId);
    await heartbeat.drainActiveRunExecutions();
    expect(changed).toBe(true);
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
      await wakeQueuedAutomation(heartbeat, companyId, agentId, issueId);
      await heartbeat.drainActiveRunExecutions();
      expect(changed).toBe(true);
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
    await expectExecuted(heartbeat, run);
  });
});
