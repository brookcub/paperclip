import { describe, expect, it, vi } from "vitest";

// This server package resolves the checked-in adapter declaration, while the
// focused adapter suites exercise their source implementations. Keep this
// unit test about the preflight's classification and snapshot contract.
vi.mock("@paperclipai/adapter-claude-local/server", () => ({
  resolveClaudeStaticToolPolicy: ({ config, tool }: { config: Record<string, unknown>; tool: string }) =>
    tool !== "Bash"
      ? { present: false, authorization: "denied", reason: "tool_not_selected" }
      : config.dangerouslySkipPermissions === false
        ? { present: true, authorization: "conditional", reason: "provider_permission_policy" }
        : { present: true, authorization: "unprompted", reason: "dangerously_skip_permissions" },
}));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({
  resolveCodexShellPolicy: (config: Record<string, unknown>) =>
    config.engine === "cli"
      ? { present: true, authorization: "conditional", reason: "codex_approval_policy" }
      : { present: false, authorization: "unknown", reason: "codex_cli_engine_not_selected" },
}));
vi.mock("@paperclipai/shared", () => {
  return {
    requiredCapabilitiesSchema: {
      safeParse: (value: unknown) => {
        const catalog = value as { version?: unknown; items?: unknown };
        const valid = Array.isArray(catalog?.items) && catalog.items.length > 0 && catalog.items.every((item) => {
          const row = item as Record<string, unknown>;
          const when = row.when as Record<string, unknown> | undefined;
          const validWhen = when === undefined || (Object.keys(when).length === 1 && typeof when.agentId === "string" && when.agentId.length > 0);
          return validWhen && (
            (row.kind === "skill" && typeof row.key === "string") ||
            (row.kind === "permission" && row.key === "agents:suggest-changes") ||
            (row.kind === "tool" && ["claude_cli", "codex_cli", "paperclip_mcp"].includes(row.runtime as string) && typeof row.name === "string" && ["conditional_ok", "must_not_prompt"].includes(row.authorization as string))
          );
        });
        if (catalog?.version !== 1 || !valid) return { success: false };
        return { success: true, data: catalog as { version: 1; items: Array<Record<string, unknown>> } };
      },
    },
  };
});
import {
  capabilityPreflightSnapshotIsCurrent,
  evaluateRequiredCapabilities,
  readRequiredCapabilities,
  stableCapabilitySnapshot,
} from "./required-capability-preflight.js";

describe("required capability preflight", () => {
  const requirements = readRequiredCapabilities({ requiredCapabilities: { version: 1, items: [
    { kind: "skill", key: "ponytail-skill" },
    { kind: "tool", runtime: "claude_cli", name: "Bash", authorization: "conditional_ok" },
    { kind: "permission", key: "agents:suggest-changes" },
  ] } });

  it("admits local Claude auto policy while preserving its conditional status", () => {
    const result = evaluateRequiredCapabilities({ requirements, agentId: "agent-1", adapterType: "claude_local", adapterConfig: { dangerouslySkipPermissions: false }, targetIsRemote: false, selectedSkillKeys: ["ponytail-skill"], skillSelectionsVerified: true, agentPermissionKeys: ["agents:suggest-changes"], managedMcpToolNames: [] });
    expect(result).toMatchObject({ admitted: true, admittedPolicy: [{ id: "tool:claude_cli:Bash", authorization: "conditional" }] });
  });

  it("reports every missing requirement and does not use a human grant", () => {
    const result = evaluateRequiredCapabilities({ requirements, agentId: "agent-1", adapterType: "claude_local", adapterConfig: { dangerouslySkipPermissions: false }, targetIsRemote: false, selectedSkillKeys: [], skillSelectionsVerified: false, agentPermissionKeys: [], managedMcpToolNames: [] });
    expect(result.unmet).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "skill:ponytail-skill", state: "missing" }),
      expect.objectContaining({ id: "permission:agents:suggest-changes", state: "missing" }),
    ]));
  });

  it("requires a non-prompting policy only when declared", () => {
    const result = evaluateRequiredCapabilities({ requirements: [{ kind: "tool", runtime: "claude_cli", name: "Bash", authorization: "must_not_prompt" }], agentId: "agent-1", adapterType: "claude_local", adapterConfig: { dangerouslySkipPermissions: false }, targetIsRemote: false, selectedSkillKeys: [], skillSelectionsVerified: false, agentPermissionKeys: [], managedMcpToolNames: [] });
    expect(result.unmet).toContainEqual(expect.objectContaining({ reason: "unprompted_authorization_required" }));
  });

  it("does not treat managed MCP presence as a non-prompting authorization", () => {
    const result = evaluateRequiredCapabilities({
      requirements: [{ kind: "tool", runtime: "paperclip_mcp", name: "search", authorization: "must_not_prompt" }],
      agentId: "agent-1", adapterType: "paperclip_runner", adapterConfig: {}, targetIsRemote: false,
      selectedSkillKeys: [], skillSelectionsVerified: false, agentPermissionKeys: [], managedMcpToolNames: ["search"],
    });
    expect(result.unmet).toContainEqual(expect.objectContaining({ reason: "unprompted_authorization_required" }));
  });

  it("refuses a malformed persisted catalog instead of dropping its unknown item", () => {
    const malformed = readRequiredCapabilities({ requiredCapabilities: { version: 1, items: [
      { kind: "permission", key: "people:admin" },
    ] } });
    const result = evaluateRequiredCapabilities({
      requirements: malformed, agentId: "agent-1", adapterType: "claude_local", adapterConfig: {}, targetIsRemote: false,
      selectedSkillKeys: [], skillSelectionsVerified: false, agentPermissionKeys: [], managedMcpToolNames: [],
    });
    expect(result).toMatchObject({ admitted: false, unmet: [expect.objectContaining({ state: "unknown", reason: "required_capability_catalog_invalid" })] });
  });

  it("rejects a changed issue, adapter, or exact agent grant snapshot", () => {
    const snapshot = {
      issueId: "issue-1", agentId: "agent-1", issueUpdatedAt: "2026-09-27T00:00:00.000Z", executionPolicy: stableCapabilitySnapshot({ requiredCapabilities: { version: 1 } }),
      agentUpdatedAt: "2026-09-27T00:00:00.000Z", adapterType: "claude_local", adapterConfig: stableCapabilitySnapshot({ dangerouslySkipPermissions: false }),
      permissionKeys: ["agents:suggest-changes"], allowedAgentPermissionKeys: ["agents:suggest-changes"], managedMcpRevision: "mcp-1",
    };
    expect(capabilityPreflightSnapshotIsCurrent(snapshot, { ...snapshot })).toBe(true);
    expect(capabilityPreflightSnapshotIsCurrent(snapshot, { ...snapshot, allowedAgentPermissionKeys: [] })).toBe(false);
    expect(capabilityPreflightSnapshotIsCurrent(snapshot, { ...snapshot, adapterConfig: stableCapabilitySnapshot({ dangerouslySkipPermissions: true }) })).toBe(false);
  });

  it("keeps declared builder and reviewer requirements bound to their exact actors", () => {
    const handoff = readRequiredCapabilities({ requiredCapabilities: { version: 1, items: [
      { kind: "tool", runtime: "codex_cli", name: "shell", authorization: "conditional_ok", when: { agentId: "builder" } },
      { kind: "tool", runtime: "claude_cli", name: "Bash", authorization: "conditional_ok", when: { agentId: "reviewer" } },
    ] } });
    expect(evaluateRequiredCapabilities({
      requirements: handoff, agentId: "builder", adapterType: "codex_local", adapterConfig: { engine: "cli" }, targetIsRemote: false,
      selectedSkillKeys: [], skillSelectionsVerified: false, agentPermissionKeys: [], managedMcpToolNames: [],
    }).admitted).toBe(true);
    expect(evaluateRequiredCapabilities({
      requirements: handoff, agentId: "reviewer", adapterType: "claude_local", adapterConfig: { dangerouslySkipPermissions: false }, targetIsRemote: false,
      selectedSkillKeys: [], skillSelectionsVerified: false, agentPermissionKeys: [], managedMcpToolNames: [],
    }).admitted).toBe(true);
    expect(evaluateRequiredCapabilities({
      requirements: handoff, agentId: "replacement", adapterType: "claude_local", adapterConfig: {}, targetIsRemote: false,
      selectedSkillKeys: [], skillSelectionsVerified: false, agentPermissionKeys: [], managedMcpToolNames: [],
    }).unmet).toContainEqual(expect.objectContaining({ reason: "actor_requirements_missing" }));
  });
});
