import { describe, expect, it } from "vitest";
import { multilineTextSchema } from "./text.js";

describe("multiline text", () => {
  it("preserves literal backslashes in ordinary text, code, JSON, and Windows paths", () => {
    const values = [
      String.raw`C:\reports\weekly.txt`,
      String.raw`.\node_modules\package.json`,
      String.raw`const report = "C:\reports\weekly.txt";`,
      String.raw`{"path":"C:\\new\\report.json","literal":"\\n"}`,
    ];

    for (const value of values) {
      expect(multilineTextSchema.parse(value)).toBe(value);
    }
  });

  it("preserves real CRLF, CR, and LF line endings without changing literal escape text", () => {
    expect(multilineTextSchema.parse("first\r\nsecond\rthird\nfourth"))
      .toBe("first\r\nsecond\rthird\nfourth");
    expect(multilineTextSchema.parse(String.raw`first\r\nsecond`))
      .toBe(String.raw`first\r\nsecond`);
  });
});
