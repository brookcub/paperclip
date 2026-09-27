import { describe, expect, it } from "vitest";
import { buildClaudeExecutionPermissionArgs, buildClaudeProbePermissionArgs, resolveClaudeStaticToolPolicy } from "./permissions.js";

const SANDBOX_ALLOWED_TOOLS =
  "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

describe("claude-local remote permission args", () => {
  it("reports local auto mode as conditional rather than granting every Bash command", () => {
    expect(resolveClaudeStaticToolPolicy({
      config: { dangerouslySkipPermissions: false }, tool: "Bash", targetIsRemote: false,
    })).toMatchObject({ present: true, authorization: "conditional" });
  });

  it("honors explicit static denials and treats custom settings as unknown", () => {
    expect(resolveClaudeStaticToolPolicy({
      config: { dangerouslySkipPermissions: false, extraArgs: ["--disallowed-tools=Bash"] }, tool: "Bash", targetIsRemote: false,
    })).toMatchObject({ present: false, authorization: "denied", reason: "tool_disallowed" });
    expect(resolveClaudeStaticToolPolicy({
      config: { extraArgs: ["--settings", "local.json"] }, tool: "Bash", targetIsRemote: false,
    })).toMatchObject({ authorization: "unknown", reason: "custom_settings_override" });
  });

  it("does not treat dontAsk as a conditional grant", () => {
    expect(resolveClaudeStaticToolPolicy({
      config: { dangerouslySkipPermissions: false, extraArgs: ["--permission-mode", "dontAsk"] }, tool: "Bash", targetIsRemote: false,
    })).toMatchObject({ present: true, authorization: "denied" });
  });

  it("fails closed for an empty tools selection, variadic flags, and command selectors", () => {
    expect(resolveClaudeStaticToolPolicy({
      config: { extraArgs: ["--tools", ""] }, tool: "Bash", targetIsRemote: false,
    })).toMatchObject({ present: false, authorization: "denied", reason: "tool_not_selected" });
    expect(resolveClaudeStaticToolPolicy({
      config: { extraArgs: ["--disallowedTools", "Read", "Bash"] }, tool: "Bash", targetIsRemote: false,
    })).toMatchObject({ authorization: "unknown", reason: "unsupported_permission_override" });
    expect(resolveClaudeStaticToolPolicy({
      config: { extraArgs: ["--disallowedTools=Bash(*)"] }, tool: "Bash", targetIsRemote: false,
    })).toMatchObject({ authorization: "unknown", reason: "unsupported_permission_override" });
  });

  it("does not infer local tool presence from the remote allowlist or ambient settings", () => {
    expect(resolveClaudeStaticToolPolicy({
      config: {}, tool: "WebSearch", targetIsRemote: false,
    })).toMatchObject({ authorization: "unknown", reason: "tool_presence_not_qualified" });
    expect(resolveClaudeStaticToolPolicy({
      config: { managedAiConnection: true }, tool: "Bash", targetIsRemote: false,
    })).toMatchObject({ authorization: "unknown", reason: "ambient_settings_source" });
  });

  it("uses the canonical Bash tool grant for remote execution", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: true })).toEqual([
      "--allowedTools",
      SANDBOX_ALLOWED_TOOLS,
    ]);
  });

  it("uses the canonical Bash tool grant for remote probes", () => {
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: true })).toEqual([
      "--allowedTools",
      SANDBOX_ALLOWED_TOOLS,
    ]);
  });

  it("does not use Bash(*) because Claude Code treats Bash grants as command-prefix patterns", () => {
    const [, allowedTools] = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsRemote: true,
    });

    expect(allowedTools.split(" ")).toContain("Bash");
    expect(allowedTools).not.toContain("Bash(*)");
  });

  it("does not pass permission flags when skip-permissions is disabled", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true })).toEqual([]);
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true })).toEqual([]);
  });

  it("uses dangerously-skip-permissions for non-root local execution", () => {
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 1000,
      }),
    ).toEqual(["--dangerously-skip-permissions"]);
  });

  it("uses dangerously-skip-permissions for non-root local probes", () => {
    expect(
      buildClaudeProbePermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 1000,
      }),
    ).toEqual(["--dangerously-skip-permissions"]);
  });

  it("uses allowedTools for local root execution because Claude refuses dangerously-skip-permissions as root", () => {
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 0,
      }),
    ).toEqual(["--allowedTools", SANDBOX_ALLOWED_TOOLS]);
  });

  it("uses allowedTools for local root probes because Claude refuses dangerously-skip-permissions as root", () => {
    expect(
      buildClaudeProbePermissionArgs({
        dangerouslySkipPermissions: true,
        targetIsRemote: false,
        localProcessUid: 0,
      }),
    ).toEqual(["--allowedTools", SANDBOX_ALLOWED_TOOLS]);
  });
});
