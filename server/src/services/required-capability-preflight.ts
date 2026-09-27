import { resolveClaudeStaticToolPolicy } from "@paperclipai/adapter-claude-local/server";
import { resolveCodexShellPolicy } from "@paperclipai/adapter-codex-local/server";
import { PERMISSION_KEYS } from "@paperclipai/shared";

type Requirement =
  | { kind: "skill"; key: string }
  | { kind: "permission"; key: string }
  | { kind: "tool"; runtime: "claude_cli" | "codex_cli" | "paperclip_mcp"; name: string; authorization: "conditional_ok" | "must_not_prompt" }
  | { kind: "invalid"; id: string };

export type CapabilityPreflightResult = {
  admitted: boolean;
  requirements: Requirement[];
  unmet: Array<{ id: string; state: "missing" | "unknown"; reason: string }>;
  admittedPolicy: Array<{ id: string; authorization: "unprompted" | "conditional" }>;
};

export type CapabilityPreflightSnapshot = {
  issueId: string;
  issueUpdatedAt: string;
  executionPolicy: string;
  agentUpdatedAt: string;
  adapterType: string;
  adapterConfig: string;
  agentPermissionKeys: string[];
};

export type CapabilityPreflight = {
  result: CapabilityPreflightResult;
  snapshot: CapabilityPreflightSnapshot;
};

export function stableCapabilitySnapshot(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableCapabilitySnapshot).join(",")}]`;
  const object = record(value);
  const keys = Object.keys(object).sort();
  return keys.length === 0 && (typeof value !== "object" || value === null)
    ? JSON.stringify(value)
    : `{${keys.map((key) => `${JSON.stringify(key)}:${stableCapabilitySnapshot(object[key])}`).join(",")}}`;
}

export function capabilityPreflightSnapshotIsCurrent(
  snapshot: CapabilityPreflightSnapshot,
  current: CapabilityPreflightSnapshot,
): boolean {
  return snapshot.issueId === current.issueId &&
    snapshot.issueUpdatedAt === current.issueUpdatedAt &&
    snapshot.executionPolicy === current.executionPolicy &&
    snapshot.agentUpdatedAt === current.agentUpdatedAt &&
    snapshot.adapterType === current.adapterType &&
    snapshot.adapterConfig === current.adapterConfig &&
    snapshot.agentPermissionKeys.length === current.agentPermissionKeys.length &&
    snapshot.agentPermissionKeys.every((key, index) => key === current.agentPermissionKeys[index]);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function readRequiredCapabilities(value: unknown): Requirement[] {
  const policy = record(value);
  const required = record(policy.requiredCapabilities);
  if (required.version !== 1 || !Array.isArray(required.items)) return [];
  const seen = new Set<string>();
  const items: Requirement[] = [];
  let invalid = false;
  for (const raw of required.items) {
    const item = record(raw);
    if (item.kind === "skill" && typeof item.key === "string") {
      const key = item.key.trim();
      if (key) items.push({ kind: "skill", key }); else invalid = true;
    } else if (item.kind === "permission" && typeof item.key === "string" && PERMISSION_KEYS.includes(item.key as (typeof PERMISSION_KEYS)[number])) {
      const key = item.key.trim();
      if (key) items.push({ kind: "permission", key }); else invalid = true;
    } else if (item.kind === "tool" &&
      (item.runtime === "claude_cli" || item.runtime === "codex_cli" || item.runtime === "paperclip_mcp") &&
      typeof item.name === "string" &&
      (item.authorization === "conditional_ok" || item.authorization === "must_not_prompt")) {
      const name = item.name.trim();
      if (name) items.push({ kind: "tool", runtime: item.runtime, name, authorization: item.authorization }); else invalid = true;
    } else invalid = true;
  }
  if (invalid) items.push({ kind: "invalid", id: "required_capability_catalog_invalid" });
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function capabilityRequirementId(requirement: Requirement): string {
  return requirement.kind === "tool"
    ? `tool:${requirement.runtime}:${requirement.name}`
    : requirement.kind === "invalid"
      ? requirement.id
      : `${requirement.kind}:${requirement.key}`;
}

export function evaluateRequiredCapabilities(input: {
  requirements: Requirement[];
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  targetIsRemote: boolean;
  selectedSkillKeys: Iterable<string>;
  agentPermissionKeys: Iterable<string>;
  managedMcpToolNames: Iterable<string>;
}): CapabilityPreflightResult {
  const skills = new Set(input.selectedSkillKeys);
  const permissions = new Set(input.agentPermissionKeys);
  const mcp = new Set(input.managedMcpToolNames);
  const unmet: CapabilityPreflightResult["unmet"] = [];
  const admittedPolicy: CapabilityPreflightResult["admittedPolicy"] = [];
  for (const requirement of input.requirements) {
    const id = capabilityRequirementId(requirement);
    if (requirement.kind === "invalid") {
      unmet.push({ id, state: "unknown", reason: "required_capability_catalog_invalid" });
      continue;
    }
    if (requirement.kind === "skill") {
      if (!skills.has(requirement.key)) unmet.push({ id, state: "missing", reason: "skill_not_selected" });
      continue;
    }
    if (requirement.kind === "permission") {
      if (!permissions.has(requirement.key)) unmet.push({ id, state: "missing", reason: "agent_grant_missing" });
      continue;
    }
    if (requirement.runtime === "paperclip_mcp") {
      if (!mcp.has(requirement.name)) unmet.push({ id, state: "missing", reason: "managed_mcp_tool_not_granted" });
      else if (requirement.authorization === "must_not_prompt") {
        unmet.push({ id, state: "missing", reason: "unprompted_authorization_required" });
      } else admittedPolicy.push({ id, authorization: "conditional" });
      continue;
    }
    const policy = requirement.runtime === "claude_cli"
      ? input.adapterType === "claude_local"
        ? resolveClaudeStaticToolPolicy({ config: input.adapterConfig, tool: requirement.name, targetIsRemote: input.targetIsRemote })
        : { present: false, authorization: "unknown" as const, reason: "adapter_mismatch" }
      : input.adapterType === "codex_local" && requirement.name === "shell"
        ? resolveCodexShellPolicy(input.adapterConfig)
        : { present: false, authorization: "unknown" as const, reason: "adapter_mismatch" };
    if (!policy.present || policy.authorization === "denied") {
      unmet.push({ id, state: "missing", reason: policy.reason });
    } else if (policy.authorization === "unknown") {
      unmet.push({ id, state: "unknown", reason: policy.reason });
    } else if (requirement.authorization === "must_not_prompt" && policy.authorization !== "unprompted") {
      unmet.push({ id, state: "missing", reason: "unprompted_authorization_required" });
    } else {
      admittedPolicy.push({ id, authorization: policy.authorization });
    }
  }
  return { admitted: unmet.length === 0, requirements: input.requirements, unmet, admittedPolicy };
}
