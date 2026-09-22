import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readVerifiedLocalAiCredential } from "../services/local-ai-credentials.js";

const mocks = vi.hoisted(() => ({ configDir: vi.fn(), token: vi.fn(), quota: vi.fn() }));
vi.mock("@paperclipai/adapter-claude-local/server", () => ({
  claudeConfigDir: mocks.configDir,
  readClaudeToken: mocks.token,
  fetchClaudeQuota: mocks.quota,
}));

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-host-claude-"));
  mocks.configDir.mockReturnValue(home);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  vi.resetAllMocks();
});

const document = JSON.stringify({
  claudeAiOauth: { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: 123456789, scopes: ["user:inference"] },
  other: { preserved: true },
});

describe("explicit host Claude subscription import", () => {
  it.each([".credentials.json", "credentials.json"])("preserves the complete %s document using a real host file", async (filename) => {
    await writeFile(path.join(home, filename), document, { mode: 0o600 });
    await expect(readVerifiedLocalAiCredential("anthropic")).resolves.toBe(document);
    expect(mocks.quota).toHaveBeenCalledExactlyOnceWith("fixture-access");
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it("prefers the primary document over alternate credentials and Keychain", async () => {
    await writeFile(path.join(home, ".credentials.json"), document, { mode: 0o600 });
    await writeFile(path.join(home, "credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "other-account" } }), { mode: 0o600 });
    mocks.token.mockResolvedValue("keychain-account");
    await expect(readVerifiedLocalAiCredential("anthropic")).resolves.toBe(document);
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it.each(["malformed", JSON.stringify({ claudeAiOauth: { accessToken: "" } })])("tries the alternate file after an invalid primary document", async (invalid) => {
    await writeFile(path.join(home, ".credentials.json"), invalid, { mode: 0o600 });
    await writeFile(path.join(home, "credentials.json"), document, { mode: 0o600 });
    await expect(readVerifiedLocalAiCredential("anthropic")).resolves.toBe(document);
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it("retains the legacy token/Keychain fallback when no document is available", async () => {
    mocks.token.mockResolvedValue("fixture-legacy");
    await expect(readVerifiedLocalAiCredential("anthropic")).resolves.toBe("fixture-legacy");
    expect(mocks.token).toHaveBeenCalledExactlyOnceWith({ allowKeychain: true });
    expect(mocks.quota).toHaveBeenCalledExactlyOnceWith("fixture-legacy");
  });

  it("does not fall back to another identity when document verification fails, or disclose credentials", async () => {
    await writeFile(path.join(home, ".credentials.json"), document, { mode: 0o600 });
    mocks.quota.mockRejectedValue(new Error(document));
    mocks.token.mockResolvedValue("different-account");
    await expect(readVerifiedLocalAiCredential("anthropic")).rejects.toThrow(/^Could not verify the local subscription\. Run claude auth login/);
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it("never reads the host account when a selected isolated login is missing", async () => {
    await writeFile(path.join(home, ".credentials.json"), document, { mode: 0o600 });
    mocks.token.mockResolvedValue("host-account");
    await expect(readVerifiedLocalAiCredential("anthropic", path.join(home, "missing-isolated"))).rejects.toThrow("sign-in command shown");
    expect(mocks.configDir).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.quota).not.toHaveBeenCalled();
  });
});
