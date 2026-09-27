import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import type { RunLogStore } from "../services/run-log-store.ts";

const mockedRunLogStore = vi.hoisted(() => ({
  append: vi.fn(),
  begin: vi.fn(),
  finalize: vi.fn(),
  read: vi.fn(),
}));

vi.mock("../services/run-log-store.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/run-log-store.ts")>();
  return {
    ...actual,
    getRunLogStore: () => mockedRunLogStore as unknown as RunLogStore,
  };
});

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const TEST_ADAPTER_TYPE = "run_log_append_rejection";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat run-log finalization tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat run-log finalization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldPaperclipHome: string | undefined;
  let oldPaperclipApiUrl: string | undefined;
  let paperclipHome: string | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-run-log-finalization-");
    db = createDb(tempDb.connectionString);
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-finalization-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    oldPaperclipApiUrl = process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100/api";
    registerServerAdapter({
      type: TEST_ADAPTER_TYPE,
      execute: async (ctx) => {
        // Remote progress callbacks may intentionally not await the promise.
        // Retain the rejection locally so the test itself does not emit an
        // unhandled rejection; heartbeat must still surface it at finalization.
        void ctx.onLog("stdout", "provider progress\n").catch(() => undefined);
        return { exitCode: 0, signal: null, timedOut: false };
      },
      testEnvironment: async () => ({
        adapterType: TEST_ADAPTER_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 60_000);

  afterEach(async () => {
    mockedRunLogStore.append.mockReset();
    mockedRunLogStore.begin.mockReset();
    mockedRunLogStore.finalize.mockReset();
    mockedRunLogStore.read.mockReset();
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "environment_leases",
        "environments",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skill_versions",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    unregisterServerAdapter(TEST_ADAPTER_TYPE);
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (oldPaperclipApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = oldPaperclipApiUrl;
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it("fails a successful adapter result when a fire-and-forget log append rejects", async () => {
    mockedRunLogStore.begin.mockResolvedValue({ store: "local_file", logRef: "rejected.ndjson" });
    mockedRunLogStore.append.mockRejectedValue(new Error("synthetic run-log append failure"));
    mockedRunLogStore.finalize.mockResolvedValue({ bytes: 0, compressed: false });

    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Run log rejection",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Run log rejection adapter",
      role: "engineer",
      status: "idle",
      adapterType: TEST_ADAPTER_TYPE,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    const terminal = await waitForRunToFinish(heartbeat, run!.id);
    await heartbeat.waitForRunExecutionDrain(run!.id);

    expect(terminal).toMatchObject({ status: "failed" });
    expect(mockedRunLogStore.append).toHaveBeenCalledTimes(1);
    expect(mockedRunLogStore.finalize).not.toHaveBeenCalled();
  });
});
