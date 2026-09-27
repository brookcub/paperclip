import { z } from "zod";

export function normalizeEscapedLineBreaks(value: string): string {
  return value;
}

export const multilineTextSchema = z.string();
