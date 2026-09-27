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
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { companySkillService } from "../services/company-skills.js";
import { getTaskDrainStatus, heartbeatService } from "../services/heartbeat.js";
import { withAgentStartLock } from "../services/agent-start-lock.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { PAPERCLIP_OPERATIONAL_SKILL_KEY } from "@paperclipai/adapter-utils/server-utils";

const execute = vi.hoisted(() => vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "capability test", provider: "test", model: "test" })));
const agentStartLockProbe = vi.hoisted(() => ({
  onQueued: null as ((agentId: string) => void) | null,
}));
vi.mock("../adapters/index.js", async () => ({
  ...(await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js")),
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })),
}));
vi.mock("../services/agent-start-lock.js", async () => {
  const actual = await vi.importActual<typeof import("../services/agent-start-lock.js")>(
    "../services/agent-start-lock.js",
  );
  return {
    ...actual,
    withAgentStartLock: <T>(agentId: string, fn: () => Promise<T>) => {
      const promise = actual.withAgentStartLock(agentId, fn);
      agentStartLockProbe.onQueued?.(agentId);
      return promise;
    },
  };
});

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
    agentStartLockProbe.onQueued = null;
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
    expect(run?.runnerProfileJson ?? {}).not.toHaveProperty("capabilityPreflight");
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
    expect(run?.runnerProfileJson ?? {}).not.toHaveProperty("capabilityPreflight");
    expect(run?.resultJson).toMatchObject({
      requiredCapabilities: { admitted: false, admittedCatalog: [] },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not list missing skills or agent grants as admitted", async () => {
    const { companyId, agentId, issueId } = await seed({ requiredCapabilities: { version: 1, items: [
      { kind: "skill", key: "company/missing-skill" },
      { kind: "permission", key: "agents:suggest-changes" },
    ] } });
    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "capability-test", contextSnapshot: { issueId } });
    await heartbeat.drainActiveRunExecutions();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(run?.resultJson).toMatchObject({
      requiredCapabilities: {
        admitted: false,
        admittedCatalog: [],
        unmet: expect.arrayContaining([
          expect.objectContaining({ id: "skill:company/missing-skill", state: "missing" }),
          expect.objectContaining({ id: "permission:agents:suggest-changes", state: "missing" }),
        ]),
      },
    });
  });

  it("tracks a deferred wake promoted by lock-owned capability cancellation", async () => {
    const { companyId, agentId, issueId } = await seed({ requiredCapabilities: { version: 1, items: [
      { kind: "tool", runtime: "claude_cli", name: "Bash", authorization: "conditional_ok" },
    ] } });
    const [comment] = await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: "capability-test-user",
      body: "Deferred capability follow-up.",
    }).returning();
    const [primaryWake] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "capability-test",
      reason: "issue_commented",
      status: "queued",
      requestedByActorType: "user",
      requestedByActorId: "capability-test-user",
      payload: { issueId, commentId: comment!.id },
    }).returning();
    const [primaryRun] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "capability-test",
      status: "queued",
      responsibleUserId: "responsible-user",
      wakeupRequestId: primaryWake!.id,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
        wakeCommentIds: [comment!.id],
      },
    }).returning();
    await db.update(issues).set({
      executionRunId: primaryRun!.id,
      executionAgentNameKey: "runner",
      executionLockedAt: new Date(),
    }).where(eq(issues.id, issueId));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "capability-test",
      reason: "issue_execution_deferred",
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: "capability-test-user",
      payload: {
        issueId,
        commentId: comment!.id,
        _paperclipWakeContext: {
          issueId,
          wakeReason: "issue_commented",
          wakeCommentId: comment!.id,
          wakeCommentIds: [comment!.id],
        },
      },
    });
    async function awaitStage<T>(stage: string, promise: Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<T>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`${stage}: ${JSON.stringify(getTaskDrainStatus())}`));
            }, 4_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    let releaseFirstLock!: () => void;
    const firstLockGate = new Promise<void>((resolve) => { releaseFirstLock = resolve; });
    let firstLockEntered!: () => void;
    const firstLockEnteredPromise = new Promise<void>((resolve) => { firstLockEntered = resolve; });
    let releaseSecondLock!: () => void;
    const secondLockGate = new Promise<void>((resolve) => { releaseSecondLock = resolve; });
    let secondLock: Promise<void> | null = null;
    let resumer: Promise<void> | null = null;
    const heartbeat = heartbeatService(db);
    const firstLock = withAgentStartLock(agentId, async () => {
      firstLockEntered();
      await firstLockGate;
    });

    try {
      await awaitStage("first queue lock", firstLockEnteredPromise);
      let resumeLockQueued!: () => void;
      const resumeLockQueuedPromise = new Promise<void>((resolve) => { resumeLockQueued = resolve; });
      agentStartLockProbe.onQueued = (lockedAgentId) => {
        if (lockedAgentId === agentId) resumeLockQueued();
      };
      resumer = heartbeat.resumeQueuedRuns();
      await awaitStage("resume queue lock", resumeLockQueuedPromise);
      agentStartLockProbe.onQueued = null;
      secondLock = withAgentStartLock(agentId, async () => {
        await secondLockGate;
      });
      releaseFirstLock();
      await awaitStage("resume queued runs", resumer);
      expect(getTaskDrainStatus()).toMatchObject({
        activeRuns: 0,
        pendingWakes: 1,
        quiescent: false,
      });
      const [cancelled] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, primaryRun!.id));
      expect(cancelled).toMatchObject({
        status: "cancelled",
        startedAt: null,
        errorCode: "required_capabilities_unavailable",
      });

      releaseSecondLock();
      await awaitStage("second queue lock", secondLock);
      await awaitStage("lifecycle drain", heartbeat.drainActiveRunExecutions());
      expect(getTaskDrainStatus()).toMatchObject({
        activeRuns: 0,
        pendingWakes: 0,
        quiescent: true,
      });
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      expect(runs).toHaveLength(2);
      expect(runs.every((run) =>
        run.status === "cancelled" &&
        run.startedAt === null &&
        run.errorCode === "required_capabilities_unavailable",
      )).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      agentStartLockProbe.onQueued = null;
      releaseFirstLock();
      releaseSecondLock();
      await Promise.allSettled([firstLock, ...(secondLock ? [secondLock] : []), ...(resumer ? [resumer] : [])]);
      await heartbeat.drainActiveRunExecutions();
    }
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
    const stored = await heartbeat.getRun(run!.id);
    expect(stored?.runnerProfileJson).toMatchObject({
      capabilityPreflight: {
        version: 1,
        runId: run!.id,
        issueId,
        agentId,
        admitted: true,
        requirements: [{ kind: "tool", runtime: "codex_cli", name: "shell", authorization: "conditional_ok" }],
        admittedCatalog: ["tool:codex_cli:shell"],
        admittedPolicy: [{ id: "tool:codex_cli:shell", authorization: "conditional" }],
        unmet: [],
        decidedAt: expect.any(String),
      },
    });
    const receipt = (stored?.runnerProfileJson as Record<string, unknown> | null)?.capabilityPreflight as Record<string, unknown>;
    expect(new Date(receipt.decidedAt as string)).toEqual(stored?.startedAt);
    expect(Object.keys(receipt).sort()).toEqual([
      "admitted",
      "admittedCatalog",
      "admittedPolicy",
      "agentId",
      "decidedAt",
      "issueId",
      "requirements",
      "runId",
      "unmet",
      "version",
    ]);
  });

  it("does not retain an affirmative receipt without an issue preflight", async () => {
    const { agentId } = await seed({});
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "capability-test", contextSnapshot: {} });
    await expectExecuted(heartbeat, run);
    expect((await heartbeat.getRun(run!.id))?.runnerProfileJson ?? {}).not.toHaveProperty("capabilityPreflight");
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
      expect((await heartbeat.getRun(run!.id))?.runnerProfileJson).toMatchObject({
        capabilityPreflight: {
          admittedCatalog: [
            `skill:${key}`,
            "permission:agents:suggest-changes",
            "tool:codex_cli:shell",
          ],
        },
      });
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
