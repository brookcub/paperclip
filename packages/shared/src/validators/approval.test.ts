import { describe, expect, it } from "vitest";
import {
  addApprovalCommentSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
} from "./approval.js";

describe("approval validators", () => {
  it("passes real line breaks through unchanged", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\n\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\n\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
  });

  it("accepts null and omitted optional decision notes", () => {
    expect(resolveApprovalSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(resolveApprovalSchema.parse({}).decisionNote).toBeUndefined();
    expect(requestApprovalRevisionSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(requestApprovalRevisionSchema.parse({}).decisionNote).toBeUndefined();
  });

  it("preserves real CRLF line breaks in approval comments and decision notes", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\r\n\r\nApproved." }).body)
      .toBe("Looks good\r\n\r\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\r\n\r\nApproved." }).decisionNote)
      .toBe("Decision\r\n\r\nApproved.");
    expect(requestApprovalRevisionSchema.parse({ decisionNote: "Decision\r\nRevise." }).decisionNote)
      .toBe("Decision\r\nRevise.");
  });

  it("preserves literal escape text in approval notes after JSON parsing", () => {
    const decisionNote = JSON.parse('{"note":"Decision\\\\r\\\\nRevise."}').note;

    expect(resolveApprovalSchema.parse({ decisionNote }).decisionNote)
      .toBe("Decision\\r\\nRevise.");
  });
});
