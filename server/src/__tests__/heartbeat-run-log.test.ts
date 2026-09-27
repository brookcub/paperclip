import { describe, expect, it } from "vitest";
import {
  compactRunLogChunk,
  createRunLogChunkNormalizer,
} from "../services/heartbeat.js";

describe("compactRunLogChunk", () => {
  it("redacts inline base64 image data from structured log chunks", () => {
    const base64 = "A".repeat(4096);
    const chunk = `{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","data":"${base64}"}}]}}\n`;

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).not.toContain(base64);
    expect(compacted).toContain("[omitted base64 image data: 4096 chars]");
  });

  it("truncates oversized chunks after sanitizing them", () => {
    const chunk = `${"x".repeat(90_000)}tail`;

    const compacted = compactRunLogChunk(chunk, 16_384);

    expect(compacted.length).toBeLessThan(chunk.length);
    expect(compacted).toContain("[paperclip truncated run log chunk:");
    expect(compacted.endsWith("tail")).toBe(true);
  });

  it("redacts Paperclip credential shapes before persisting run-log chunks", () => {
    const chunk = [
      "Authorization: Bearer live-bearer-token-value",
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `auth {"refresh_token":"refresh-token-fixture-secret"}`,
      `payload {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      "--paperclip-api-key=paperclip-flag-secret",
    ].join("\n");

    const compacted = compactRunLogChunk(chunk);

    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("live-bearer-token-value");
    expect(compacted).not.toContain("paperclip-shell-secret");
    expect(compacted).not.toContain("refresh-token-fixture-secret");
    expect(compacted).not.toContain("paperclip-json-secret");
    expect(compacted).not.toContain("paperclip-flag-secret");
  });
});

describe("createRunLogChunkNormalizer", () => {
  const currentUserRedactionOptions = { enabled: false };

  it("structurally redacts a complete provider JSON frame split at every boundary", () => {
    const secret = "provider-bearer-token-fixture";
    const frame = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: `Authorization: Bearer ${secret}`,
      },
      apiKey: "provider-api-key-fixture",
    });

    for (let boundary = 0; boundary <= frame.length; boundary += 1) {
      const normalizer = createRunLogChunkNormalizer({ currentUserRedactionOptions });
      expect(normalizer.push("stdout", frame.slice(0, boundary))).toEqual([]);
      const output = normalizer.push("stdout", `${frame.slice(boundary)}\n`);

      expect(output).toHaveLength(1);
      expect(() => JSON.parse(output[0])).not.toThrow();
      expect(output[0]).toContain("***REDACTED***");
      expect(output[0]).not.toContain(secret);
      expect(output[0]).not.toContain("provider-api-key-fixture");
    }
  });

  it("keeps stdout and stderr frames independent and handles multiple lines", () => {
    const normalizer = createRunLogChunkNormalizer({ currentUserRedactionOptions });
    const stdoutOne = JSON.stringify({ type: "assistant", text: "one" });
    const stdoutTwo = JSON.stringify({ type: "assistant", text: "two" });
    const stderr = JSON.stringify({ type: "error", message: "three" });

    expect(normalizer.push("stdout", `${stdoutOne}\n${stdoutTwo.slice(0, 12)}`)).toEqual([
      `${stdoutOne}\n`,
    ]);
    expect(normalizer.push("stderr", `${stderr}\n`)).toEqual([`${stderr}\n`]);
    expect(normalizer.push("stdout", `${stdoutTwo.slice(12)}\n`)).toEqual([
      `${stdoutTwo}\n`,
    ]);
  });

  it("flushes a final complete provider frame without a newline", () => {
    const normalizer = createRunLogChunkNormalizer({ currentUserRedactionOptions });
    const frame = JSON.stringify({ type: "result", token: "must-not-survive" });

    expect(normalizer.push("stderr", frame)).toEqual([]);
    expect(normalizer.flush()).toEqual([
      {
        stream: "stderr",
        chunk: expect.stringContaining("***REDACTED***"),
      },
    ]);
  });

  it("drops an oversized unterminated line through its newline before resuming", () => {
    const secret = "oversized-line-secret";
    const normalizer = createRunLogChunkNormalizer({
      currentUserRedactionOptions,
      maxLineChars: 64,
    });
    const safeFrame = JSON.stringify({ type: "assistant", text: "recovered" });

    const first = normalizer.push("stdout", `${"x".repeat(65)}${secret}`);
    const second = normalizer.push(
      "stdout",
      `${secret}\n${safeFrame}\n`,
    );

    expect(first).toEqual([
      "[paperclip unavailable run-log line: exceeded 64 chars; discarded through next newline]\n",
    ]);
    expect(second).toEqual([`${safeFrame}\n`]);
    expect([...first, ...second].join("")).not.toContain(secret);
  });

  it("keeps the existing bounded compaction marker for a complete oversized frame", () => {
    const normalizer = createRunLogChunkNormalizer({
      currentUserRedactionOptions,
      maxLineChars: 128,
    });
    const frame = JSON.stringify({ type: "assistant", text: "x".repeat(300) });

    const output = normalizer.push("stdout", `${frame}\n`).join("");

    expect(output).toContain("[paperclip truncated run log chunk:");
    expect(output.length).toBeLessThan(frame.length);
  });

  it("keeps malformed quote and backtick text on the raw fail-closed scanner", () => {
    const normalizer = createRunLogChunkNormalizer({ currentUserRedactionOptions });
    const malformed = [
      'Authorization: Bearer malformed-bearer-secret"',
      "Bearer malformed-backtick-secret`embedded-tail",
    ].join("\n");

    const output = normalizer.push("stderr", `${malformed}\n`).join("");

    expect(output).toContain("***REDACTED***");
    expect(output).not.toContain("malformed-bearer-secret");
    expect(output).not.toContain("malformed-backtick-secret");
  });

  it("omits inline base64 after structural redaction without re-scanning JSON text", () => {
    const normalizer = createRunLogChunkNormalizer({ currentUserRedactionOptions });
    const base64 = "A".repeat(4096);
    const frame = JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "image", source: { type: "base64", data: base64 } }],
      },
    });

    const output = normalizer.push("stdout", `${frame}\n`)[0];

    expect(output).not.toContain(base64);
    expect(output).toContain("[omitted base64 image data: 4096 chars]");
    expect(() => JSON.parse(output)).not.toThrow();
  });
});
