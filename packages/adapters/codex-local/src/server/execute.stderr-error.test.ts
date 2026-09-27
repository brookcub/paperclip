import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const YOLO_WARNING = "YOLO mode is enabled. All tool calls will be automatically approved.";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareCodexRuntimeConfig,
  readPaperclipRuntimeSkillEntries,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  tempCodexHome,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  prepareCodexRuntimeConfig: vi.fn(async () => ({ cleanup: vi.fn(async () => undefined), notes: [] })),
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "codex"),
  runAdapterExecutionTargetProcess: vi.fn(),
  tempCodexHome: "/tmp/paperclip-codex-stderr-error-test-home",
}));

vi.mock("./acp.js", () => ({
  createCodexAcpExecutor: () => vi.fn(),
  formatCodexAcpFallbackMessage: (reason: string) =>
    `[paperclip] Codex ACP default unavailable; falling back to Codex CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`,
  resolveCodexExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    readPaperclipRuntimeSkillEntries,
  };
});

vi.mock("./codex-home.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-home.js")>("./codex-home.js");
  return {
    ...actual,
    evaluateCodexCredentialReadiness: vi.fn(async () => ({
      managed: true,
      authMode: "api",
      ready: true,
      effectiveHome: tempCodexHome,
      sharedSourceHome: tempCodexHome,
    })),
    isManagedCodexHomePath: vi.fn(() => true),
    prepareManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
    resolveManagedCodexHomeDir: vi.fn(() => tempCodexHome),
    seedManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
  };
});

vi.mock("./runtime-config.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-config.js")>("./runtime-config.js");
  return {
    ...actual,
    prepareCodexRuntimeConfig,
  };
});

import { execute, firstMeaningfulStderrLine } from "./execute.js";

function mockFailedProcess(stderr: string) {
  runAdapterExecutionTargetProcess.mockImplementation(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr,
    pid: 123,
    startedAt: new Date().toISOString(),
  }));
}

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Codex Coder",
      adapterType: "codex_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      outputInactivityTimeoutMs: null,
      env: { OPENAI_API_KEY: "test-key" },
      ...config,
    },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("codex_local stderr fallback error derivation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips the benign YOLO approvals warning and surfaces the real stderr error", async () => {
    mockFailedProcess(
      [
        YOLO_WARNING,
        "Error: unexpected status 400 Bad Request: {\"error\":{\"message\":\"The requested model 'gpt-5.3-codex-spark' does not exist.\",\"code\":\"model_not_found\"}}",
      ].join("\n"),
    );

    const result = await execute(buildContext() as never);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("model_not_found");
    expect(result.errorMessage).not.toContain("YOLO mode");
  });

  it("skips adapter-injected [paperclip] diagnostic lines when picking the fallback error", async () => {
    mockFailedProcess(
      [
        "[paperclip] Codex ACP default unavailable; falling back to Codex CLI. Set engine=acp to require ACP or engine=cli to silence this fallback.",
        YOLO_WARNING,
        "Error: stream disconnected before completion",
      ].join("\n"),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorMessage).toBe("Error: stream disconnected before completion");
  });

  it("falls back to the first non-empty stderr line when every line is benign", async () => {
    mockFailedProcess(`${YOLO_WARNING}\n`);

    const result = await execute(buildContext() as never);

    expect(result.errorMessage).toBe(YOLO_WARNING);
  });

  it("falls back to the exit-code message when stderr is empty", async () => {
    mockFailedProcess("\n  \n");

    const result = await execute(buildContext() as never);

    expect(result.errorMessage).toBe("Codex exited with code 1");
  });

  it("persists an explicit unavailable completion-evidence result when a timed-out attempt never reports thread.started", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    });

    const result = await execute(buildContext() as never);

    expect(result).toMatchObject({
      timedOut: true,
      resultJson: {
        completionEvidence: {
          schema: "paperclip.codex-rollout-completion-evidence.v1",
          status: "unavailable",
          parseGaps: ["codex_run_session_not_observed"],
        },
      },
    });
  });

  it("does not attribute an ordinary failed attempt to its older runtime session", async () => {
    const olderRuntimeSession = "019caaaa-1234-7abc-8def-0123456789ab";
    mockFailedProcess("Error: upstream failed before session start");
    const context = buildContext() as { runtime: { sessionId: string | null } };
    context.runtime.sessionId = olderRuntimeSession;

    const result = await execute(context as never);

    expect(result.sessionId).toBe(olderRuntimeSession);
    expect(result).toMatchObject({
      resultJson: {
        completionEvidence: {
          sessionId: null,
          status: "unavailable",
          parseGaps: ["codex_run_session_not_observed"],
        },
      },
    });
  });

  it("captures only the monitor attempt's observed thread ID", async () => {
    const threadId = "019cabcd-1234-7abc-8def-0123456789ab";
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    runAdapterExecutionTargetProcess.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[4] as {
        onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
        onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      };
      await options.onSpawn?.({ pid: 999_999, processGroupId: null, startedAt: new Date().toISOString() });
      const stdout = JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\n";
      await options.onLog?.("stdout", stdout);
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { exitCode: null, signal: "SIGTERM", timedOut: false, stdout, stderr: "", pid: 999_999, startedAt: new Date().toISOString() };
    });

    const result = await execute(buildContext({ outputInactivityTimeoutMs: 1 }) as never);

    expect(result).toMatchObject({
      errorCode: "codex_output_inactivity_monitor",
      resultJson: {
        completionEvidence: {
          sessionId: threadId,
          status: "unavailable",
        },
      },
    });
    expect(kill).toHaveBeenCalledWith(999_999, "SIGTERM");
  });
});

describe("firstMeaningfulStderrLine", () => {
  it("returns the first line that is not a known benign warning", () => {
    expect(firstMeaningfulStderrLine(`${YOLO_WARNING}\nError: boom`)).toBe("Error: boom");
    expect(firstMeaningfulStderrLine("[paperclip] Confining Codex with workspace scope.\nError: boom")).toBe(
      "Error: boom",
    );
  });

  it("keeps the first non-empty line when all lines are benign", () => {
    expect(firstMeaningfulStderrLine(`${YOLO_WARNING}\n[paperclip] note\n`)).toBe(YOLO_WARNING);
  });

  it("returns an empty string for blank input", () => {
    expect(firstMeaningfulStderrLine("")).toBe("");
    expect(firstMeaningfulStderrLine(" \n\t\n")).toBe("");
  });
});
