import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensurePaperclipSkillSymlink } from "@paperclipai/adapter-utils/server-utils";
import { buildCodexExecArgs } from "./codex-args.js";
import { writeManagedCodexMcpConfig } from "./codex-home.js";

describe("native Windows readiness configuration", () => {
  it.each(["unelevated", "elevated"])("selects %s without disabling the sandbox", (mode) => {
    const { args } = buildCodexExecArgs({ windowsSandbox: mode });
    expect(args).toContain(`windows.sandbox="${mode}"`);
    expect(args).toContain('sandbox_mode="workspace-write"');
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });
  it("leaves an omitted Windows setting unchanged and rejects invalid settings", () => {
    expect(buildCodexExecArgs({}).args.some((arg) => arg.startsWith("windows.sandbox="))).toBe(false);
    expect(() => buildCodexExecArgs({ windowsSandbox: "disabled" })).toThrow("windowsSandbox");
  });
  it("writes the HTTP authentication header key recognized by Codex", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-mcp-header-"));
    try {
      await writeManagedCodexMcpConfig({ codexHome: root, apiBaseUrl: "http://127.0.0.1:8210", gateways: [
        { name: "paperclip", endpointPath: "/mcp", bearerToken: 'test-token' },
      ] });
      const content = await fs.readFile(path.join(root, "config.toml"), "utf8");
      expect(content).toContain('http_headers = { Authorization = "Bearer test-token" }');
      expect(content).not.toMatch(/^headers\s*=/m);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("makes a readable skill directory link and preserves an existing real directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-skill-link-"));
    const source = path.join(root, "source");
    const target = path.join(root, "runtime-skill");
    const existing = path.join(root, "existing");
    try {
      await fs.mkdir(source); await fs.writeFile(path.join(source, "SKILL.md"), "# Source skill");
      expect(await ensurePaperclipSkillSymlink(source, target)).toBe("created");
      expect(await fs.readFile(path.join(target, "SKILL.md"), "utf8")).toBe("# Source skill");
      expect(await ensurePaperclipSkillSymlink(source, target)).toBe("skipped");
      await fs.mkdir(existing); await fs.writeFile(path.join(existing, "SKILL.md"), "# User skill");
      expect(await ensurePaperclipSkillSymlink(source, existing)).toBe("skipped");
      expect(await fs.readFile(path.join(existing, "SKILL.md"), "utf8")).toBe("# User skill");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
