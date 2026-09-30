import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareClaudePromptBundle } from "./prompt-cache.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test("replaces a legacy prompt-cache junction without touching its skill source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-cache-"));
  roots.push(root);
  const source = path.join(root, "authoritative-skill");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "SKILL.md"), "# skill\n", "utf8");
  await fs.writeFile(path.join(source, "source-sentinel"), "unchanged", "utf8");
  const oldHome = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = path.join(root, "home");
  try {
    const input = { companyId: "company", skills: [{ key: "skill", runtimeName: "skill", source }], instructionsContents: null, onLog: async () => {} };
    const first = await prepareClaudePromptBundle(input);
    const target = path.join(first.rootDir, ".claude", "skills", "skill");
    await fs.rm(target, { recursive: true, force: true });
    await fs.symlink(source, target, "junction");
    await prepareClaudePromptBundle(input);
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(false);
    await expect(fs.readFile(path.join(target, "SKILL.md"), "utf8")).resolves.toBe("# skill\n");
    await expect(fs.readFile(path.join(source, "source-sentinel"), "utf8")).resolves.toBe("unchanged");
    expect((await fs.lstat(source)).isDirectory()).toBe(true);
  } finally {
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldHome;
  }
});
