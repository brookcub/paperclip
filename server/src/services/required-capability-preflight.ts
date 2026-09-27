import { resolveClaudeStaticToolPolicy } from "@paperclipai/adapter-claude-local/server";
import { resolveCodexShellPolicy } from "@paperclipai/adapter-codex-local/server";
import { requiredCapabilitiesSchema } from "@paperclipai/shared";

type Requirement =
  | { kind: "skill"; key: string; when?: { agentId: string } }
  | { kind: "permission"; key: string; when?: { agentId: string } }
  | { kind: "tool"; runtime: "claude_cli" | "codex_cli" | "paperclip_mcp"; name: string; authorization: "conditional_ok" | "must_not_prompt"; when?: { agentId: string } }
  | { kind: "invalid"; id: string };

export type CapabilityPreflightResult = {
  admitted: boolean;
  requirements: Requirement[];
  unmet: Array<{ id: string; state: "missing" | "unknown"; reason: string }>;
  admittedCatalog: string[];
  admittedPolicy: Array<{ id: string; authorization: "unprompted" | "conditional" }>;
};

export type CapabilityPreflightSnapshot = {
  issueId: string;
  agentId: string;
  issueUpdatedAt: string;
  executionPolicy: string;
  agentUpdatedAt: string;
  adapterType: string;
  adapterConfig: string;
  permissionKeys: string[];
  allowedAgentPermissionKeys: string[];
  managedMcpRevision: string;
  executionTargetRevision: string;
  skillRevisions: Array<{ key: string; versionId: string | null; currentVersionId: string | null; updatedAt: string }>;
  skillVersionPinsEnabled: boolean | null;
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
    snapshot.agentId === current.agentId &&
    snapshot.issueUpdatedAt === current.issueUpdatedAt &&
    snapshot.executionPolicy === current.executionPolicy &&
    snapshot.agentUpdatedAt === current.agentUpdatedAt &&
    snapshot.adapterType === current.adapterType &&
    snapshot.adapterConfig === current.adapterConfig &&
    snapshot.permissionKeys.length === current.permissionKeys.length &&
    snapshot.permissionKeys.every((key, index) => key === current.permissionKeys[index]) &&
    snapshot.allowedAgentPermissionKeys.length === current.allowedAgentPermissionKeys.length &&
    snapshot.allowedAgentPermissionKeys.every((key, index) => key === current.allowedAgentPermissionKeys[index]) &&
    snapshot.managedMcpRevision === current.managedMcpRevision &&
    snapshot.executionTargetRevision === current.executionTargetRevision &&
    (snapshot.skillVersionPinsEnabled === null || snapshot.skillVersionPinsEnabled === current.skillVersionPinsEnabled) &&
    stableCapabilitySnapshot(snapshot.skillRevisions) === stableCapabilitySnapshot(current.skillRevisions);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function readRequiredCapabilities(value: unknown): Requirement[] {
  const policy = record(value);
  if (policy.requiredCapabilities === undefined || policy.requiredCapabilities === null) return [];
  const parsed = requiredCapabilitiesSchema.safeParse(policy.requiredCapabilities);
  if (!parsed.success) return [{ kind: "invalid", id: "required_capability_catalog_invalid" }];
  const seen = new Set<string>();
  const items: Requirement[] = [];
  for (const item of parsed.data.items) {
    if (item.kind === "skill") {
      items.push({ kind: "skill", key: item.key, ...(item.when ? { when: item.when } : {}) });
    } else if (item.kind === "permission") {
      items.push({ kind: "permission", key: item.key, ...(item.when ? { when: item.when } : {}) });
    } else {
      items.push({ kind: "tool", runtime: item.runtime, name: item.name, authorization: item.authorization, ...(item.when ? { when: item.when } : {}) });
    }
  }
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function capabilityRequirementId(requirement: Requirement): string {
  const id = requirement.kind === "tool"
    ? `tool:${requirement.runtime}:${requirement.name}`
    : requirement.kind === "invalid"
      ? requirement.id
      : `${requirement.kind}:${requirement.key}`;
  return requirement.kind !== "invalid" && requirement.when
    ? `${id}@agent:${requirement.when.agentId}`
    : id;
}

export function evaluateRequiredCapabilities(input: {
  requirements: Requirement[];
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  agentId: string;
  targetIsRemote: boolean | null;
  selectedSkillKeys: Iterable<string>;
  skillSelectionsVerified: boolean;
  unverifiedSkillKeys?: Iterable<string>;
  agentPermissionKeys: Iterable<string>;
  managedMcpToolNames: Iterable<string>;
}): CapabilityPreflightResult {
  const skills = new Set(input.selectedSkillKeys);
  const unverifiedSkills = new Set(input.unverifiedSkillKeys ?? []);
  const permissions = new Set(input.agentPermissionKeys);
  const mcp = new Set(input.managedMcpToolNames);
  const unmet: CapabilityPreflightResult["unmet"] = [];
  const admittedCatalog: CapabilityPreflightResult["admittedCatalog"] = [];
  const admittedPolicy: CapabilityPreflightResult["admittedPolicy"] = [];
  const applicable = input.requirements.filter((requirement) =>
    requirement.kind === "invalid" || !requirement.when || requirement.when.agentId === input.agentId,
  );
  if (applicable.length === 0) {
    unmet.push({ id: `agent:${input.agentId}`, state: "missing", reason: "actor_requirements_missing" });
  }
  for (const requirement of applicable) {
    const id = capabilityRequirementId(requirement);
    if (requirement.kind === "invalid") {
      unmet.push({ id, state: "unknown", reason: "required_capability_catalog_invalid" });
      continue;
    }
    if (requirement.kind === "skill") {
      if (!skills.has(requirement.key) && unverifiedSkills.has(requirement.key)) {
        unmet.push({ id, state: "unknown", reason: "skill_source_unavailable" });
      } else if (!skills.has(requirement.key)) unmet.push({ id, state: "missing", reason: "skill_not_selected" });
      else if (!input.skillSelectionsVerified) unmet.push({ id, state: "unknown", reason: "skill_revision_not_rechecked" });
      else admittedCatalog.push(id);
      continue;
    }
    if (requirement.kind === "permission") {
      if (!permissions.has(requirement.key)) unmet.push({ id, state: "missing", reason: "agent_grant_missing" });
      else admittedCatalog.push(id);
      continue;
    }
    if (requirement.runtime === "paperclip_mcp") {
      if (!mcp.has(requirement.name)) unmet.push({ id, state: "missing", reason: "managed_mcp_tool_not_granted" });
      else if (requirement.authorization === "must_not_prompt") {
        unmet.push({ id, state: "missing", reason: "unprompted_authorization_required" });
      } else {
        admittedCatalog.push(id);
        admittedPolicy.push({ id, authorization: "conditional" });
      }
      continue;
    }
    if (input.targetIsRemote === null) {
      unmet.push({ id, state: "unknown", reason: "execution_target_unresolved" });
      continue;
    }
    if (input.targetIsRemote && requirement.runtime === "codex_cli") {
      unmet.push({ id, state: "unknown", reason: "remote_codex_policy_unqualified" });
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
      admittedCatalog.push(id);
      admittedPolicy.push({ id, authorization: policy.authorization });
    }
  }
  return { admitted: unmet.length === 0, requirements: input.requirements, unmet, admittedCatalog, admittedPolicy };
}
