import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_INLINE_PAPERCLIP_WAKE_PAYLOAD_UTF16_CODE_UNITS,
  PAPERCLIP_WAKE_PAYLOAD_JSON_ENV,
  PAPERCLIP_WAKE_PAYLOAD_PATH_ENV,
  preparePaperclipWakePayloadTransport,
} from "@paperclipai/adapter-utils/server-utils";
import {
  HEARTBEAT_RUN_SCRATCH_MARKER,
  buildHeartbeatRunScratchEnv,
  cleanupHeartbeatRunScratch,
  prepareHeartbeatRunScratch,
  prepareHeartbeatRunScratchForExecution,
  type HeartbeatRunScratch,
} from "./run-scratch.js";

const cleanupDirs = new Set<string>();

async function trackScratch(scratch: HeartbeatRunScratch) {
  cleanupDirs.add(scratch.dir);
  return scratch;
}

afterEach(async () => {
  await Promise.all(
    Array.from(cleanupDirs, (dir) =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
  cleanupDirs.clear();
});

describe("heartbeat run scratch cleanup", () => {
  it("removes only a marked run-owned scratch directory", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      issueId: "issue-1",
      issueIdentifier: "PAP-13071",
      now: new Date("2026-07-08T00:00:00.000Z"),
    }));
    await fs.writeFile(path.join(scratch.dir, "tool-cache.txt"), "cache");

    const result = await cleanupHeartbeatRunScratch({ scratch });

    expect(result).toEqual({ removed: true, dir: scratch.dir });
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves paperclip-named directories without the ownership marker", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-unmarked-"));
    cleanupDirs.add(dir);
    const scratch: HeartbeatRunScratch = {
      dir,
      markerPath: path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER),
      metadata: {
        version: 1,
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: null,
        issueIdentifier: null,
        createdAt: new Date("2026-07-08T00:00:00.000Z").toISOString(),
      },
    };

    const result = await cleanupHeartbeatRunScratch({ scratch });

    expect(result).toEqual({ removed: false, dir, reason: "unmarked" });
    await expect(fs.stat(dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("preserves marked scratch when the marker owner does not match the run", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));
    const mismatched = {
      ...scratch,
      metadata: {
        ...scratch.metadata,
        runId: "run-2",
      },
    };

    const result = await cleanupHeartbeatRunScratch({ scratch: mismatched });

    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "owner_mismatch" });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("skips cleanup while the run process group is still alive", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const result = await cleanupHeartbeatRunScratch({
      scratch,
      processGroupId: 123,
      isProcessGroupAlive: () => true,
    });

    expect(result).toEqual({ removed: false, dir: scratch.dir, reason: "process_group_alive" });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("builds explicit scratch env without clobbering configured temp dirs", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const result = buildHeartbeatRunScratchEnv({ TMPDIR: "/custom/tmp" }, scratch);

    expect(result.env.PAPERCLIP_RUN_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TASK_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TMPDIR).toBe(scratch.dir);
    expect(result.env.TMPDIR).toBeUndefined();
    expect(result.env.TEMP).toBe(scratch.dir);
    expect(result.env.TMP).toBe(scratch.dir);
    expect(result.tempKeysApplied).toEqual(["TEMP", "TMP"]);
  });

  it("keeps remote temp settings while supplying an owned scratch payload for remote staging", async () => {
    const preparation = await prepareHeartbeatRunScratchForExecution({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      executionTargetIsLocal: false,
      existingEnv: { TMPDIR: "/remote/tmp", TEMP: "/remote/temp", TMP: "/remote/tmp-win" },
    });
    await trackScratch(preparation.scratch);
    expect(preparation.env).toEqual({});
    expect(preparation.context).toMatchObject({
      type: "heartbeat_run",
      dir: preparation.scratch.dir,
      marker: HEARTBEAT_RUN_SCRATCH_MARKER,
      tempKeysApplied: [],
    });

    const wake = {
      reason: "issue_commented",
      issue: { id: "issue-1", identifier: "PAP-1", title: "wake", status: "in_progress", workMode: "standard" },
      comments: [{ id: "comment-1", body: "😀".repeat(5_000), author: { type: "user", id: "user-1" }, createdAt: "2026-09-26T00:00:00.000Z" }],
    };
    const transport = await preparePaperclipWakePayloadTransport({
      wake,
      scratch: preparation.context,
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    expect(transport.asset).toMatchObject({ key: "wake-payload", localDir: expect.stringContaining(preparation.scratch.dir) });
    const stagedPayload = await fs.readFile(path.join(transport.asset!.localDir, "payload.json"), "utf8");
    expect(stagedPayload.length).toBeGreaterThan(MAX_INLINE_PAPERCLIP_WAKE_PAYLOAD_UTF16_CODE_UNITS);

    const remoteEnv = {
      TMPDIR: "/remote/tmp",
      TEMP: "/remote/temp",
      TMP: "/remote/tmp-win",
      [PAPERCLIP_WAKE_PAYLOAD_JSON_ENV]: "stale-inline",
    };
    transport.applyToEnv(remoteEnv, {
      remote: true,
      remoteAssetDir: "/remote/.paperclip-runtime/claude/wake-payload",
    });
    expect(remoteEnv).toEqual({
      TMPDIR: "/remote/tmp",
      TEMP: "/remote/temp",
      TMP: "/remote/tmp-win",
      [PAPERCLIP_WAKE_PAYLOAD_PATH_ENV]: "/remote/.paperclip-runtime/claude/wake-payload/payload.json",
    });
  });
});
