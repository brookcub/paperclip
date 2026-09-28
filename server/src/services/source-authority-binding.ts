import { type issues } from "@paperclipai/db";
import { ISSUE_STATUSES } from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

export type SourceAuthorityBinding = {
  status: string;
  statusVersion: number;
  lastStatusDecisionId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionRunId: string | null;
  checkoutRunId: string | null;
  hiddenAt: string | null;
  reviewStageId: string | null;
  reviewParticipantAgentId: string | null;
  reviewParticipantUserId: string | null;
};

type Issue = typeof issues.$inferSelect;
const ISSUE_STATUS_SET = new Set<string>(ISSUE_STATUSES);

export function projectSourceAuthority(
  task: Issue,
  releaseRunId?: string,
): SourceAuthorityBinding {
  const review = task.status === "in_review" ? parseIssueExecutionState(task.executionState) : null;
  const participant = review?.currentParticipant;
  return {
    status: task.status,
    statusVersion: task.statusVersion,
    lastStatusDecisionId: task.lastStatusDecisionId,
    assigneeAgentId: task.assigneeAgentId,
    assigneeUserId: task.assigneeUserId,
    executionRunId: task.executionRunId === releaseRunId ? null : (task.executionRunId ?? null),
    checkoutRunId: task.checkoutRunId === releaseRunId ? null : (task.checkoutRunId ?? null),
    hiddenAt: task.hiddenAt?.toISOString() ?? null,
    reviewStageId: review?.currentStageId ?? null,
    reviewParticipantAgentId: participant?.type === "agent" ? (participant.agentId ?? null) : null,
    reviewParticipantUserId: participant?.type === "user" ? (participant.userId ?? null) : null,
  };
}

export function readSourceAuthorityBinding(
  value: unknown,
): SourceAuthorityBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const binding = value as Record<string, unknown>;
  const nullableString = (key: keyof SourceAuthorityBinding) =>
    binding[key] === null || typeof binding[key] === "string" ? binding[key] : undefined;
  const fields: (keyof SourceAuthorityBinding)[] = [
    "lastStatusDecisionId", "assigneeAgentId", "assigneeUserId", "executionRunId",
    "checkoutRunId", "hiddenAt", "reviewStageId", "reviewParticipantAgentId", "reviewParticipantUserId",
  ];
  if (
    typeof binding.status !== "string" ||
    !ISSUE_STATUS_SET.has(binding.status) ||
    typeof binding.statusVersion !== "number" ||
    !Number.isSafeInteger(binding.statusVersion) ||
    binding.statusVersion < 0 ||
    fields.some((key) => nullableString(key) === undefined)
  ) return null;
  return binding as SourceAuthorityBinding;
}

export function sourceAuthorityMatches(
  task: Issue,
  binding: SourceAuthorityBinding,
): boolean {
  const current = projectSourceAuthority(task);
  return (Object.keys(current) as (keyof SourceAuthorityBinding)[])
    .every((key) => current[key] === binding[key]);
}