// Explicit allowlist of Claude Code tools we permit when running on a remote
// target. We use this instead of `--dangerously-skip-permissions` for remote
// targets because the permission-approval prompts can't be answered by a
// human inside a non-interactive run, but blanket-allowing every tool would
// defeat the point of having a separate hosted/sandbox code path.
//
// Maintenance: this list must be reviewed when Claude Code releases a new
// tool. The canonical list of built-in tools is documented at
// https://docs.claude.com/en/docs/claude-code/built-in-tools — when a tool
// is added there, decide whether it should be allowed in remote runs and
// either add it here or document the deliberate exclusion. Omitting a tool
// silently disables it inside remote targets, which can look like the tool is
// "broken" rather than intentionally gated.
export const SANDBOX_ALLOWED_TOOLS =
  "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

// The local pilot has exercised this bounded built-in subset. Do not derive
// local presence from the remote-target allowlist above.
const LOCAL_CLI_PROVEN_TOOLS = new Set(["Bash", "Read", "Grep", "Glob"]);

function shouldUseAllowedTools(input: { targetIsRemote: boolean; localProcessUid?: number | null }): boolean {
  // Claude Code refuses `--dangerously-skip-permissions` when the process runs
  // as root. Use the same explicit allowlist that remote targets use so local
  // Docker/root probes and executions fail safe instead of hard-failing before
  // auth/runtime validation can complete.
  return input.targetIsRemote || input.localProcessUid === 0;
}

export type StaticToolAuthorization = "unprompted" | "conditional" | "denied" | "unknown";
export type StaticToolPolicy = {
  present: boolean;
  authorization: StaticToolAuthorization;
  reason: string;
};

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function configuredArgs(config: Record<string, unknown>): string[] {
  const extra = strings(config.extraArgs);
  return extra.length > 0 ? extra : strings(config.args);
}

type FlagValues = { found: boolean; values: string[]; unsupported: boolean };

function flagValues(args: string[], flags: string[]): FlagValues {
  const values: string[] = [];
  let found = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const flag = flags.find((candidate) => arg === candidate || arg.startsWith(`${candidate}=`));
    if (!flag) continue;
    if (arg === flag) {
      found = true;
      const next = args[index + 1];
      if (typeof next !== "string" || next.startsWith("-")) return { found, values, unsupported: true };
      values.push(next);
      index += 1;
      if (typeof args[index + 1] === "string" && !args[index + 1]!.startsWith("-")) {
        return { found, values, unsupported: true };
      }
    } else {
      found = true;
      values.push(arg.slice(flag.length + 1));
    }
  }
  return {
    found,
    values: values.flatMap((value) => value.split(/[\s,]+/).filter(Boolean)),
    unsupported: false,
  };
}

function hasUnsupportedSelector(values: string[]): boolean {
  return values.some((value) => /[()*?]/.test(value));
}

/**
 * A deliberately small projection of the invocation flags Paperclip itself
 * passes to Claude. It says whether a built-in is present and whether the
 * current policy can run it without a prompt; it never predicts a Bash
 * argument-level decision.
 */
export function resolveClaudeStaticToolPolicy(input: {
  config: Record<string, unknown>;
  tool: string;
  targetIsRemote: boolean;
  localProcessUid?: number | null;
}): StaticToolPolicy {
  const extraArgs = configuredArgs(input.config);
  if (extraArgs.some((arg) => /^(--settings|--setting-sources)(?:=|$)/.test(arg))) {
    return { present: false, authorization: "unknown", reason: "custom_settings_override" };
  }
  if (input.config.managedAiConnection === true ||
    Object.prototype.hasOwnProperty.call(record(input.config.env), "CLAUDE_CONFIG_DIR")) {
    return { present: false, authorization: "unknown", reason: "ambient_settings_source" };
  }
  const tools = flagValues(extraArgs, ["--tools"]);
  const allow = flagValues(extraArgs, ["--allowedTools", "--allowed-tools"]);
  const deny = flagValues(extraArgs, ["--disallowedTools", "--disallowed-tools"]);
  const mode = flagValues(extraArgs, ["--permission-mode"]);
  if (tools.unsupported || allow.unsupported || deny.unsupported || mode.unsupported || mode.values.length > 1 ||
    hasUnsupportedSelector(tools.values) || hasUnsupportedSelector(allow.values) || hasUnsupportedSelector(deny.values)) {
    return { present: false, authorization: "unknown", reason: "unsupported_permission_override" };
  }
  const builtin = input.targetIsRemote
    ? new Set(SANDBOX_ALLOWED_TOOLS.split(" "))
    : LOCAL_CLI_PROVEN_TOOLS;
  const exactDenied = deny.values.some((entry) => entry === input.tool);
  const explicitlyPresent = tools.found
    ? tools.values.includes(input.tool)
    : builtin.has(input.tool);
  if (!builtin.has(input.tool)) {
    return { present: false, authorization: "unknown", reason: "tool_presence_not_qualified" };
  }
  if (!explicitlyPresent || exactDenied) {
    return { present: false, authorization: "denied", reason: exactDenied ? "tool_disallowed" : "tool_not_selected" };
  }
  const bypass = asBoolean(input.config.dangerouslySkipPermissions, true) &&
    !shouldUseAllowedTools(input);
  if (bypass) return { present: true, authorization: "unprompted", reason: "dangerously_skip_permissions" };
  if (allow.values.includes(input.tool)) return { present: true, authorization: "unprompted", reason: "explicit_allowed_tool" };
  if (mode.values[0] === "dontAsk") return { present: true, authorization: "denied", reason: "permission_mode_dont_ask" };
  return { present: true, authorization: "conditional", reason: "provider_permission_policy" };
}

export function buildClaudeProbePermissionArgs(input: {
  dangerouslySkipPermissions: boolean;
  targetIsRemote: boolean;
  localProcessUid?: number | null;
}): string[] {
  if (!input.dangerouslySkipPermissions) return [];
  // For remote targets and local root processes, mirror the execution path:
  // pass `--allowedTools` with the curated allowlist instead of dropping the
  // flag entirely. The hello probe is a one-shot prompt that should never
  // trigger a tool, but if a future probe prompt does, we don't want Claude CLI
  // to stall on an interactive permission prompt that no human can answer.
  if (shouldUseAllowedTools(input)) return ["--allowedTools", SANDBOX_ALLOWED_TOOLS];
  return ["--dangerously-skip-permissions"];
}

export function buildClaudeExecutionPermissionArgs(input: {
  dangerouslySkipPermissions: boolean;
  targetIsRemote: boolean;
  localProcessUid?: number | null;
}): string[] {
  if (!input.dangerouslySkipPermissions) return [];
  if (shouldUseAllowedTools(input)) {
    return ["--allowedTools", SANDBOX_ALLOWED_TOOLS];
  }
  return ["--dangerously-skip-permissions"];
}
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";
