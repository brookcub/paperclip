import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeManagedCodexMcpConfig } from "./codex-home.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const gateway = { name: "paperclip-projects", endpointPath: "/mcp/projects", bearerToken: "fixture-token" };
const policy = { server: gateway.name, tool: "create_task", approvalMode: "approve" };
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-mcp-policy-"));
  roots.push(root);
  const configPath = path.join(root, "config.toml");
  const original = 'cli_auth_credentials_store = "file"\n';
  await fs.writeFile(configPath, original);
  return { root, configPath, original, input: { codexHome: root, apiBaseUrl: "http://127.0.0.1:8210", gateways: [gateway] } };
}

describe("managed Codex per-tool approvals", () => {
  it("sets only the selected tool and removes obsolete grants on rewrite", async () => {
    const f = await fixture();
    await writeManagedCodexMcpConfig({ ...f.input, toolApprovals: [policy] });
    const content = await fs.readFile(f.configPath, "utf8");
    expect(content).toContain('[mcp_servers."paperclip-projects".tools."create_task"]\napproval_mode = "approve"');
    expect(content).toContain('http_headers = { Authorization = "Bearer fixture-token" }');
    expect(content).toContain(f.original);
    expect(content).not.toContain("default_tools_approval_mode");
    expect(content).not.toContain("sandbox_mode");
    await writeManagedCodexMcpConfig(f.input);
    const cleared = await fs.readFile(f.configPath, "utf8");
    expect(cleared).not.toContain("approval_mode");
    expect(cleared).toContain('url = "http://127.0.0.1:8210/mcp/projects"');
  });

  it("targets the renamed managed server, leaving colliding unmanaged policy untouched", async () => {
    const f = await fixture();
    const original = '[mcp_servers."paperclip-projects"]\nurl = "http://example.invalid/mcp"\n';
    await fs.writeFile(f.configPath, original);
    await writeManagedCodexMcpConfig({ ...f.input, toolApprovals: [policy] });
    const content = await fs.readFile(f.configPath, "utf8");
    expect(content).toContain(original);
    expect(content).toContain('[mcp_servers."paperclip-paperclip-projects".tools."create_task"]');
    expect(content).not.toContain('[mcp_servers."paperclip-projects".tools.');
  });

  it.each(["auto", "prompt", "writes", "approve"])("serializes supported mode %s", async (approvalMode) => {
    const f = await fixture();
    await writeManagedCodexMcpConfig({ ...f.input, toolApprovals: [{ ...policy, approvalMode }] });
    expect(await fs.readFile(f.configPath, "utf8")).toContain(`approval_mode = "${approvalMode}"`);
  });

  it.each([
    null, {}, [null], ["approve"], [{ ...policy, url: "http://example.invalid" }],
    [{ ...policy, server: "unmanaged" }], [{ ...policy, server: "*" }],
    [{ ...policy, tool: "*" }], [{ ...policy, tool: 'create_task"\n[evil]' }],
    [{ ...policy, approvalMode: "bypass" }], [{ server: gateway.name, tool: "create_task" }],
    [policy, policy],
  ])("rejects invalid policy without modifying configuration: %j", async (toolApprovals) => {
    const f = await fixture();
    await expect(writeManagedCodexMcpConfig({ ...f.input, toolApprovals })).rejects.toThrow("managedMcpToolApprovals");
    expect(await fs.readFile(f.configPath, "utf8")).toBe(f.original);
  });

  it("rejects absent or ambiguous active gateways and does not grant another agent access", async () => {
    const f = await fixture();
    for (const gateways of [[], [gateway, gateway]]) {
      await expect(writeManagedCodexMcpConfig({ ...f.input, gateways, toolApprovals: [policy] })).rejects.toThrow("exactly one");
      expect(await fs.readFile(f.configPath, "utf8")).toBe(f.original);
    }
    const other = await fixture();
    await writeManagedCodexMcpConfig({ ...f.input, toolApprovals: [policy] });
    await writeManagedCodexMcpConfig(other.input);
    expect(await fs.readFile(other.configPath, "utf8")).not.toContain("approval_mode");
    await writeManagedCodexMcpConfig({ ...f.input, gateways: [], toolApprovals: [] });
    expect(await fs.readFile(f.configPath, "utf8")).toBe(f.original);
  });
});
