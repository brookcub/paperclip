import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.ts", async () => ({
  ...(await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts")),
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
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seed(policy: Record<string, unknown>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Capability test", issuePrefix: "CAP", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Runner", role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: { engine: "cli" }, runtimeConfig: { heartbeat: { wakeOnDemand: true } }, permissions: {},
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Required capability", status: "todo", priority: "medium", assigneeAgentId: agentId, executionPolicy: policy });
    return { companyId, agentId, issueId };
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
});
