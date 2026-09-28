import { randomUUID } from "node:crypto";
import { conversationRecoveryActionPredicate, getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { persistActivity } from "./activity-log.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { logger } from "../middleware/logger.js";
import { and, asc, eq, gt, inArray, isNull, not, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  chatActions,
  environmentLeases,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import {
  queuedCommentIdsFromWakePayload,
  withQueuedCommentIdsInRunContext,
  withQueuedCommentIdsInWakePayload,
} from "./issue-queued-comment-queue.js";
import {
  EXECUTION_RECONCILIATION_CAUSES,
  type ExecutionReconciliation,
} from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { isSupersededConversationRun } from "./agent-conversations.js";
import {
  projectSourceAuthority,
  readSourceAuthorityBinding,
  sourceAuthorityMatches,
} from "./source-authority-binding.js";

type RecoveryActionCoalescingInput = Pick<
  typeof issueRecoveryActions.$inferSelect,
  "companyId" | "evidence" | "id" | "sourceIssueId"
>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function matchingNotPerformedReconciliation(
  value: unknown,
  decision: ExecutionReconciliation,
) {
  const candidate = record(value);
  return decision.providerStopped === true &&
    decision.actionOutcome === "not_performed" &&
    candidate.runId === decision.runId &&
    candidate.providerStopped === true &&
    candidate.actionOutcome === "not_performed" &&
    candidate.outcomeEvidence === decision.outcomeEvidence;
}

function adoptedDeferredWake(evidence: Record<string, unknown>) {
  const adoption = record(evidence.adoptedDeferredWake);
  const wakeId = typeof adoption.wakeId === "string" ? adoption.wakeId : null;
  const commentIds = Array.isArray(adoption.commentIds)
    ? adoption.commentIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  return wakeId && commentIds.length ? { wakeId, commentIds } : null;
}

/** An operator records observed outcomes; this is not permission to blindly retry. */
export async function validateExecutionReconciliation(input: {
  db: Db;
  companyId: string;
  issueId: string;
  agentId: string | null;
  sourceRunId: unknown;
  decision: ExecutionReconciliation | undefined;
}) {
  const { db, companyId, issueId, agentId, decision } = input;
  if (!decision || decision.runId !== input.sourceRunId || !agentId) {
    throw conflict(
      "Reconcile the recorded execution and its action outcomes before continuing this task.",
    );
  }
  const [run] = await db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.id, decision.runId),
      ),
    );
  const [task] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  const review =
    task?.status === "in_review"
      ? parseIssueExecutionState(task.executionState)
      : null;
  const isCurrentReviewer =
    review?.status === "pending" &&
    review.currentParticipant?.type === "agent" &&
    review.currentParticipant.agentId === run?.agentId;
  if (
    !run ||
    !task ||
    task.assigneeAgentId !== agentId ||
    (run.agentId !== agentId && !isCurrentReviewer) ||
    (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== issueId ||
    !["failed", "interrupted", "timed_out", "cancelled"].includes(run.status)
  ) {
    throw conflict(
      "The recovery source or task owner changed. Inspect the current execution before continuing.",
    );
  }
  for (const pid of [
    run.processPid,
    run.processGroupId ? -run.processGroupId : null,
  ]) {
    if (!pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
      throw conflict(
        "The previous provider's process ownership cannot be verified.",
      );
    }
    throw conflict(
      "The previous provider is still running. Stop it before continuing.",
    );
  }
  const [coordinator] = await db
    .select()
    .from(nativeRunFinalizations)
    .where(
      and(
        eq(nativeRunFinalizations.companyId, companyId),
        eq(nativeRunFinalizations.runId, run.id),
      ),
    );
  if (coordinator?.leaseOwner || coordinator?.failureDetail?.successorRunId)
    throw conflict(
      "This execution still has a coordinator or a linked continuation. Inspect that run first.",
    );
  const leases = await db
    .select({ id: environmentLeases.id })
    .from(environmentLeases)
    .where(
      and(
        eq(environmentLeases.companyId, companyId),
        eq(environmentLeases.heartbeatRunId, run.id),
        isNull(environmentLeases.releasedAt),
      ),
    )
    .limit(1);
  if (leases.length)
    throw conflict(
      "The previous execution environment has not finished releasing its authority.",
    );
  await buildExecutionContinuation({
    db,
    companyId,
    issueId,
    agentId,
    context: { previousRunId: run.id },
    summary: null,
    exposeLowTrustRaw: false,
  });
  return run;
}

/** Durable delivery marker lives on the existing source-scoped recovery action. */
export async function markExecutionReconciliation(
  db: Db,
  action: Pick<
    typeof issueRecoveryActions.$inferSelect,
    "companyId" | "id" | "evidence" | "sourceIssueId"
  >,
  decision: ExecutionReconciliation,
  actorId: string,
  deliveryOwner?: { kind: "chat_failed_run_retry"; actionId: string },
) {
  if (deliveryOwner) {
    const [retry] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, action.companyId),
          eq(chatActions.id, deliveryOwner.actionId),
        ),
      );
    if (
      deliveryOwner.kind !== "chat_failed_run_retry" ||
      !retry ||
      retry.kind !== "failed_run_retry" ||
      !["issued", "processing", "processed"].includes(retry.status) ||
      retry.payload.version !== 1 ||
      retry.payload.failedRunId !== decision.runId ||
      retry.payload.issueId !== action.sourceIssueId
    ) {
      throw conflict("The authorized chat retry owner is no longer valid.");
    }
  }
  await db
    .update(nativeRunFinalizations)
    .set({
      failureDetail: sql`coalesce(${nativeRunFinalizations.failureDetail}, '{}'::jsonb) || ${JSON.stringify({ replacementDenied: "operator_reconciled" })}::jsonb`,
    })
    .where(
      and(
        eq(nativeRunFinalizations.companyId, action.companyId),
        eq(nativeRunFinalizations.runId, decision.runId),
      ),
    );
  await db
    .update(issueRecoveryActions)
    .set({
      evidence: {
        ...action.evidence,
        automaticRecovery: undefined,
        executionReconciliation: {
          ...decision,
          actorId,
          recordedAt: new Date().toISOString(),
        },
        continuationDelivery: deliveryOwner ? "delegated" : "pending",
        ...(deliveryOwner ? { continuationDeliveryOwner: deliveryOwner } : {}),
      },
    })
    .where(
      and(
        eq(issueRecoveryActions.companyId, action.companyId),
        eq(issueRecoveryActions.id, action.id),
      ),
  );
}

/**
 * Fold an older no-replay hold into the one already-authorized continuation.
 * This is deliberately narrower than ordinary reconciliation: it reserves the
 * exact saved user comment before the old hold stops blocking queue promotion.
 */
export async function coalesceStaleExecutionReconciliation(
  db: Db,
  action: RecoveryActionCoalescingInput,
  task: typeof issues.$inferSelect,
  decision: ExecutionReconciliation,
) {
  const automatic = record(action.evidence.automaticRecovery);
  if (automatic.replay !== "blocked") return false;

  const actions = await db
    .select()
    .from(issueRecoveryActions)
    .where(and(
      eq(issueRecoveryActions.companyId, action.companyId),
      eq(issueRecoveryActions.sourceIssueId, action.sourceIssueId),
    ))
    .orderBy(asc(issueRecoveryActions.id))
    .for("update");
  const stale = actions.find((candidate) => candidate.id === action.id);
  if (
    !stale ||
    stale.status !== "active" ||
    record(stale.evidence.automaticRecovery).replay !== "blocked" ||
    stale.evidence.runId !== decision.runId
  ) {
    throw conflict("The historical recovery hold changed. Inspect the current recovery records before continuing.");
  }

  const siblings = actions.filter((candidate) =>
    candidate.id !== stale.id &&
    candidate.kind === stale.kind &&
    candidate.cause === stale.cause &&
    candidate.fingerprint === stale.fingerprint &&
    candidate.returnOwnerAgentId === stale.returnOwnerAgentId &&
    candidate.evidence.runId === decision.runId,
  );
  if (!siblings.length) return false;
  if (siblings.length !== 1) {
    throw conflict("Multiple matching recovery continuations remain. Inspect them before continuing.");
  }
  const canonical = siblings[0]!;
  const canonicalBinding = readSourceAuthorityBinding(canonical.evidence.sourceAuthorityBinding);
  const staleBinding = readSourceAuthorityBinding(stale.evidence.sourceAuthorityBinding);
  if (
    canonical.status !== "resolved" ||
    canonical.evidence.continuationDelivery !== "pending" ||
    adoptedDeferredWake(canonical.evidence) !== null ||
    !matchingNotPerformedReconciliation(canonical.evidence.executionReconciliation, decision) ||
    !canonical.returnOwnerAgentId ||
    task.assigneeAgentId !== canonical.returnOwnerAgentId ||
    task.executionRunId !== null ||
    task.checkoutRunId !== null ||
    ["done", "cancelled"].includes(task.status) ||
    (canonicalBinding !== null && !sourceAuthorityMatches(task, canonicalBinding)) ||
    (staleBinding !== null && !sourceAuthorityMatches(task, staleBinding))
  ) {
    throw conflict("The current task authority no longer matches the recorded continuation.");
  }

  const liveWakes = await db
    .select()
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, task.companyId),
      inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${task.id}`,
    ))
    .orderBy(asc(agentWakeupRequests.id))
    .for("update");
  if (liveWakes.length !== 1 || liveWakes[0]!.agentId !== canonical.returnOwnerAgentId) {
    throw conflict("Another live wake exists for this task. Preserve the existing delivery before resolving the historical hold.");
  }
  const deferred = liveWakes[0]!;
  const deferredPayload = record(deferred.payload);
  const deferredContext = record(deferredPayload._paperclipWakeContext);
  const commentIds = queuedCommentIdsFromWakePayload(deferred.payload);
  if (
    deferred.status !== "deferred_issue_execution" ||
    deferred.requestedByActorType !== "user" ||
    !deferred.requestedByActorId ||
    deferred.idempotencyKey !== null ||
    !["issue_commented", "issue_reopened_via_comment"].includes(
      String(deferredContext.wakeReason ?? deferred.reason),
    ) ||
    deferredPayload.queuedCommentInterrupt ||
    deferredPayload.interactionId ||
    deferredContext.interactionId ||
    deferredContext.explicitNativeContinuation ||
    commentIds.length !== 1
  ) {
    throw conflict("The saved wake is no longer the exact user-comment continuation to adopt.");
  }
  const comments = await db
    .select({
      id: issueComments.id,
      authorUserId: issueComments.authorUserId,
      authorType: issueComments.authorType,
      authorAgentId: issueComments.authorAgentId,
      onBehalfOfUserId: issueComments.onBehalfOfUserId,
      createdByRunId: issueComments.createdByRunId,
      derivedAuthorAgentId: issueComments.derivedAuthorAgentId,
      derivedCreatedByRunId: issueComments.derivedCreatedByRunId,
      derivedAuthorSource: issueComments.derivedAuthorSource,
      deletedAt: issueComments.deletedAt,
    })
    .from(issueComments)
    .where(and(
      eq(issueComments.companyId, task.companyId),
      eq(issueComments.issueId, task.id),
      inArray(issueComments.id, commentIds),
    ));
  if (
    comments.length !== commentIds.length ||
    comments.some((comment) =>
      comment.deletedAt ||
      comment.authorType !== "user" ||
      comment.authorAgentId !== null ||
      comment.onBehalfOfUserId !== null ||
      comment.createdByRunId !== null ||
      comment.derivedAuthorAgentId !== null ||
      comment.derivedCreatedByRunId !== null ||
      comment.derivedAuthorSource !== null ||
      comment.authorUserId !== deferred.requestedByActorId,
    )
  ) {
    throw conflict("The saved comment no longer matches its original user authority.");
  }

  const [reserved] = await db
    .update(agentWakeupRequests)
    .set({ status: "coalesced", updatedAt: new Date() })
    .where(and(
      eq(agentWakeupRequests.id, deferred.id),
      eq(agentWakeupRequests.companyId, task.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
      isNull(agentWakeupRequests.runId),
    ))
    .returning({ id: agentWakeupRequests.id });
  if (!reserved) throw conflict("The saved wake changed before it could be reserved.");

  const [updatedCanonical] = await db
    .update(issueRecoveryActions)
    .set({ evidence: {
      ...canonical.evidence,
      adoptedDeferredWake: { wakeId: deferred.id, commentIds },
    } })
    .where(and(
      eq(issueRecoveryActions.id, canonical.id),
      eq(issueRecoveryActions.companyId, canonical.companyId),
      eq(issueRecoveryActions.status, "resolved"),
      sql`${issueRecoveryActions.evidence} = ${JSON.stringify(canonical.evidence)}::jsonb`,
    ))
    .returning({ id: issueRecoveryActions.id });
  if (!updatedCanonical) throw conflict("The canonical continuation changed before the saved comment could be adopted.");

  const { automaticRecovery: _automaticRecovery, ...staleEvidence } = stale.evidence;
  const [updatedStale] = await db
    .update(issueRecoveryActions)
    .set({ evidence: {
      ...staleEvidence,
      continuationDelivery: "coalesced",
      coalescedIntoRecoveryActionId: canonical.id,
    } })
    .where(and(
      eq(issueRecoveryActions.id, stale.id),
      eq(issueRecoveryActions.companyId, stale.companyId),
      eq(issueRecoveryActions.status, "active"),
      sql`${issueRecoveryActions.evidence} = ${JSON.stringify(stale.evidence)}::jsonb`,
    ))
    .returning({ id: issueRecoveryActions.id });
  if (!updatedStale) throw conflict("The historical hold changed before it could be coalesced.");
  await persistActivity(db, {
    companyId: task.companyId,
    actorType: "system",
    actorId: "execution-recovery",
    action: "issue.execution_recovery_coalesced",
    entityType: "issue",
    entityId: task.id,
    details: { recoveryActionId: stale.id, canonicalRecoveryActionId: canonical.id, deferredWakeId: deferred.id },
  });
  return true;
}

export async function deliverReconciledExecutions(
  db: Db,
  wake: ReturnType<typeof import("./heartbeat.js").heartbeatService>["wakeup"],
) {
  const pending = await db
    .select()
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
      ),
    )
    .limit(25);
  for (const action of pending) {
    try {
      const decision = action.evidence.executionReconciliation as
        ExecutionReconciliation | undefined;
      if (!decision || !action.returnOwnerAgentId) continue;
      const adoption = adoptedDeferredWake(action.evidence);
      const pendingDecision = and(
        eq(issueRecoveryActions.companyId, action.companyId),
        eq(issueRecoveryActions.id, action.id),
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
        sql`${issueRecoveryActions.evidence}->'executionReconciliation' = ${JSON.stringify(decision)}::jsonb`,
      );
      const [task] = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, action.companyId),
            eq(issues.id, action.sourceIssueId),
          ),
        );
      if (
        !task ||
        task.assigneeAgentId !== action.returnOwnerAgentId ||
        ["done", "cancelled"].includes(task.status)
      ) {
        await db
          .update(issueRecoveryActions)
          .set({
            evidence: sql`${issueRecoveryActions.evidence} || '{"continuationDelivery":"invalidated"}'::jsonb`,
          })
          .where(pendingDecision);
        continue;
      }
      const wakePayload = adoption
        ? withQueuedCommentIdsInWakePayload(
            { issueId: task.id, recoveryActionId: action.id },
            adoption.commentIds,
          )
        : { issueId: task.id, recoveryActionId: action.id };
      const wakeContextBase = {
        issueId: task.id,
        taskId: task.id,
        recoveryActionId: action.id,
        previousRunId: decision.runId,
        retryOfRunId: decision.runId,
        forceFreshSession: true,
        reconciliationAdoptedDeferredWake: action.evidence.adoptedDeferredWake ?? null,
        wakeReason: "issue_recovery_action_restored",
        source: "execution.reconciled",
      };
      const wakeContext = adoption
        ? withQueuedCommentIdsInRunContext(wakeContextBase, adoption.commentIds)
        : wakeContextBase;
      const run = await wake(action.returnOwnerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_recovery_action_restored",
        idempotencyKey: `execution-reconciliation:${action.id}`,
        payload: wakePayload,
        requestedByActorType: "system",
        requestedByActorId: "execution-recovery",
        contextSnapshot: wakeContext,
      });
      if (run)
        await db.transaction(async (tx) => {
          await tx
            .update(heartbeatRuns)
            .set({ retryOfRunId: decision.runId })
            .where(
              and(
                eq(heartbeatRuns.companyId, action.companyId),
                eq(heartbeatRuns.id, run.id),
                eq(heartbeatRuns.agentId, action.returnOwnerAgentId!),
                sql`${heartbeatRuns.contextSnapshot}->>'recoveryActionId' = ${action.id}`,
                sql`${heartbeatRuns.contextSnapshot}->>'previousRunId' = ${decision.runId}`,
              ),
            );
          await tx
            .update(issueRecoveryActions)
            .set({
              evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify(
                {
                  continuationDelivery: "delivered",
                  continuationRunId: run.id,
                },
              )}::jsonb`,
            })
            .where(pendingDecision);
          if (adoption) {
            const [adopted] = await tx
              .update(agentWakeupRequests)
              .set({ runId: run.id, updatedAt: new Date() })
              .where(and(
                eq(agentWakeupRequests.id, adoption.wakeId),
                eq(agentWakeupRequests.companyId, action.companyId),
                eq(agentWakeupRequests.status, "coalesced"),
                isNull(agentWakeupRequests.runId),
              ))
              .returning({ id: agentWakeupRequests.id });
            if (!adopted) throw new Error("adopted_deferred_wake_changed");
          }
        });
    } catch {
      logger.warn(
        { recoveryActionId: action.id },
        "Reconciled execution continuation remains pending for retry",
      );
    }
  }
}

/** Retire only holds whose own recorded blocked projection was later superseded. */
async function supersedeEffectiveResolvedHolds(db: Db, now: Date) {
  let afterId: string | null = null;
  for (;;) {
    const predicates = [
      not(conversationRecoveryActionPredicate()!),
      eq(issueRecoveryActions.status, "resolved"),
      eq(issueRecoveryActions.kind, "active_run_watchdog"),
      inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
      sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
      sql`${issueRecoveryActions.evidence} ? 'settledAuthorityProjection'`,
    ];
    if (afterId) predicates.push(gt(issueRecoveryActions.id, afterId));
    const candidates = await db
      .select({
        id: issueRecoveryActions.id,
        companyId: issueRecoveryActions.companyId,
        sourceIssueId: issueRecoveryActions.sourceIssueId,
      })
      .from(issueRecoveryActions)
      .where(and(...predicates))
      .orderBy(asc(issueRecoveryActions.id))
      .limit(25);
    if (!candidates.length) return;
    afterId = candidates[candidates.length - 1]!.id;
    for (const candidate of candidates) {
      try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
        );
        const [task] = await tx
          .select()
          .from(issues)
          .where(and(
            eq(issues.companyId, candidate.companyId),
            eq(issues.id, candidate.sourceIssueId),
          ))
          .for("update");
        const [action] = await tx
          .select()
          .from(issueRecoveryActions)
          .where(and(
            eq(issueRecoveryActions.companyId, candidate.companyId),
            eq(issueRecoveryActions.id, candidate.id),
          ))
          .for("update");
        if (
          !task ||
          !action ||
          action.sourceIssueId !== candidate.sourceIssueId ||
          action.status !== "resolved" ||
          record(action.evidence.automaticRecovery).replay !== "blocked"
        ) return;
        const projection = readSourceAuthorityBinding(
          action.evidence.settledAuthorityProjection,
        );
        // Old or malformed records do not establish which blocked projection this
        // recovery owned, so retain their conservative no-replay hold.
        if (!projection || sourceAuthorityMatches(task, projection)) return;
        const automatic = record(action.evidence.automaticRecovery);
        await tx
          .update(issueRecoveryActions)
          .set({
            nextAction: "Recovery hold superseded by a later task decision. Recorded work remains preserved and was not replayed.",
            resolutionNote: "A later material task decision superseded this recovery hold; unknown external outcomes remain preserved.",
            updatedAt: now,
            evidence: {
              ...action.evidence,
              automaticRecovery: {
                ...automatic,
                policy: "source_authority_changed_v1",
                replay: "superseded",
                recordedAt: now.toISOString(),
              },
            },
          })
          .where(and(
            eq(issueRecoveryActions.companyId, action.companyId),
            eq(issueRecoveryActions.id, action.id),
            eq(issueRecoveryActions.status, "resolved"),
            sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
          ));
        await persistActivity(tx as unknown as Db, {
          companyId: action.companyId,
          actorType: "system",
          actorId: "execution-recovery",
          action: "issue.execution_recovery_superseded",
          entityType: "issue",
          entityId: action.sourceIssueId,
          details: { recoveryActionId: action.id, replay: "superseded" },
        });
      });
      } catch (err) {
        logger.warn(
          { err, recoveryActionId: candidate.id },
          "Effective execution recovery hold remains pending for a later sweep",
        );
      }
    }
  }
}

/**
 * Failed execution is a system responsibility, not a user questionnaire. After
 * automatic recovery is ruled out, preserve evidence and stop without replay.
 * This is NOT evidence that an external action succeeded or never happened.
 * The resolved record retains a dispatch hold until actual evidence clears it.
 */
export async function settleUnrecoverableExecutions(
  db: Db,
  now = new Date(),
  options: { failpoint?: (phase: "persisted") => void } = {},
) {
  // Fold obsolete conversation holds without waking historical work on upgrade.
  // Keep their evidence and record the policy change in the task's activity log.
  const obsoleteConversationHold = and(
    conversationRecoveryActionPredicate(),
    or(
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
    ),
  );
  await db.transaction(async tx => {
    const foldable = await tx.select().from(issueRecoveryActions).where(obsoleteConversationHold)
      .limit(25).for("update", { skipLocked: true });
    for (const candidate of foldable) {
      if (await getConversationOwnershipBlocker(tx as unknown as Db, candidate.companyId, candidate.sourceIssueId)) continue;
      const [action] = await tx.update(issueRecoveryActions).set({
        status: "resolved",
        outcome: "cancelled",
        resolvedAt: now,
        updatedAt: now,
        nextAction: "Automatic attempts stopped. Send a new message to continue the conversation.",
        resolutionNote: "Conversation continuation does not replay prior tool calls.",
        wakePolicy: null,
        monitorPolicy: null,
        evidence: sql`case when ${issueRecoveryActions.evidence} ? 'automaticRecovery'
          then jsonb_set(${issueRecoveryActions.evidence}, '{automaticRecovery,replay}', '"conversation_continuation"'::jsonb)
          else ${issueRecoveryActions.evidence} end`,
      }).where(and(obsoleteConversationHold, eq(issueRecoveryActions.id, candidate.id))).returning();
      if (!action) continue;
      await persistActivity(tx as unknown as Db, {
        companyId: action.companyId,
        actorType: "system",
        actorId: "execution-recovery",
        action: "issue.execution_recovery_settled",
        entityType: "issue",
        entityId: action.sourceIssueId,
        details: { recoveryActionId: action.id, outcome: "cancelled", continuation: "conversation" },
      });
    }
  });
  // Filter eligibility before applying the batch limit. A queue of sessions
  // awaiting replacement must not starve settled incidents behind it.
  const candidates = await db
    .select({ action: issueRecoveryActions })
    .from(issueRecoveryActions)
    .innerJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
        sql`${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'`,
        sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueRecoveryActions.sourceIssueId}::text`,
      ),
    )
    .leftJoin(
      nativeRunFinalizations,
      and(
        eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
        eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      ),
    )
    .where(
      and(
        not(conversationRecoveryActionPredicate()!),
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
        eq(issueRecoveryActions.kind, "active_run_watchdog"),
        inArray(issueRecoveryActions.cause, [
          ...EXECUTION_RECONCILIATION_CAUSES,
        ]),
        inArray(heartbeatRuns.status, [
          "failed",
          "timed_out",
          "interrupted",
          "cancelled",
        ]),
        isNull(nativeRunFinalizations.leaseOwner),
        isNull(nativeRunFinalizations.resultId),
        or(
          isNull(nativeRunFinalizations.runId),
          eq(nativeRunFinalizations.phase, "terminal_failure"),
        ),
        sql`coalesce(${nativeRunFinalizations.failureDetail}->>'successorRunId', '') = ''`,
        sql`(${heartbeatRuns.runtimeMode} <> 'native' or coalesce(${nativeRunFinalizations.failureCode}, '') <> 'native_provider_terminal_failed'
        or coalesce(${nativeRunFinalizations.failureDetail}->>'replacementDenied', '') <> '')`,
      ),
    )
    .limit(25);
  for (const { action: candidate } of candidates) {
    const runId = candidate.evidence.runId;
    if (typeof runId !== "string") continue;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
        );
        // Same issue -> coordinator -> run ordering as replacement/finalization.
        const [task] = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, candidate.companyId),
              eq(issues.id, candidate.sourceIssueId),
            ),
          )
          .for("update");
        const [coordinator] = await tx
          .select()
          .from(nativeRunFinalizations)
          .where(
            and(
              eq(nativeRunFinalizations.companyId, candidate.companyId),
              eq(nativeRunFinalizations.runId, runId),
            ),
          )
          .for("update");
        const [run] = await tx
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, candidate.companyId),
              eq(heartbeatRuns.id, runId),
            ),
          )
          .for("update");
        const [action] = await tx
          .select()
          .from(issueRecoveryActions)
          .where(eq(issueRecoveryActions.id, candidate.id))
          .for("update");
        if (
          !task ||
          !run ||
          !action ||
          action.evidence.runId !== runId ||
          !EXECUTION_RECONCILIATION_CAUSES.includes(
            action.cause as (typeof EXECUTION_RECONCILIATION_CAUSES)[number],
          ) ||
          !["active", "escalated"].includes(action.status) ||
          (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== task.id ||
          !["failed", "timed_out", "interrupted", "cancelled"].includes(
            run.status,
          )
        )
          return;
        // Give durable native recovery its chance; never preempt a resume,
        // replacement, result finalizer, or still-owned execution.
        if (
          coordinator?.leaseOwner ||
          coordinator?.resultId ||
          coordinator?.failureDetail?.successorRunId ||
          (coordinator && coordinator.phase !== "terminal_failure") ||
          (run.runtimeMode === "native" &&
            coordinator?.failureCode === "native_provider_terminal_failed" &&
            !coordinator.failureDetail?.replacementDenied)
        )
          return;
        const binding = readSourceAuthorityBinding(action.evidence.sourceAuthorityBinding);
        const sourceAuthorityChanged = binding !== null && !sourceAuthorityMatches(task, binding);
        const current =
          !sourceAuthorityChanged &&
          !isSupersededConversationRun(task, run) &&
          action.returnOwnerAgentId !== null &&
          task.assigneeAgentId === action.returnOwnerAgentId &&
          !["done", "cancelled"].includes(task.status) &&
          (!task.executionRunId || task.executionRunId === run.id) &&
          (!task.checkoutRunId || task.checkoutRunId === run.id);
        const note = current
          ? "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated."
          : "Recovery closed because the task's owner, execution, or status changed. No work was replayed.";
        let nativeFailureBlock = action.evidence.nativeFailureBlock;
        let settledAuthorityProjection = null;
        if (current) {
          const [projected] = await tx
            .update(issues)
            .set({
              status: "blocked",
              executionRunId: null,
              checkoutRunId: null,
              updatedAt: now,
            })
            .where(eq(issues.id, task.id)).returning();
          // Only a transition owned by this failure grants a recovery receipt.
          // An already-blocked task may have a separate human/dependency hold.
          if (task.status !== "blocked") {
            // This is the only blocked projection the recovery owns. A later
            // effective-hold scan compares against this post-update row rather
            // than mistaking this settlement write for a Board decision.
            settledAuthorityProjection = projectSourceAuthority(projected!);
            if (run.runtimeMode === "native") {
              nativeFailureBlock = { runId: run.id, statusVersion: projected!.statusVersion };
            }
          }
        }
        await tx
          .update(issueRecoveryActions)
          .set({
            status: "resolved",
            outcome: current ? "blocked" : "cancelled",
            resolvedAt: now,
            updatedAt: now,
            nextAction: note,
            resolutionNote: note,
            wakePolicy: null,
            monitorPolicy: null,
            evidence: {
              ...action.evidence,
              ...(nativeFailureBlock ? { nativeFailureBlock } : {}),
              ...(settledAuthorityProjection ? { settledAuthorityProjection } : {}),
              automaticRecovery: sourceAuthorityChanged
                ? {
                    ...record(action.evidence.automaticRecovery),
                    policy: "source_authority_changed_v1",
                    runId: run.id,
                    replay: "superseded",
                    recordedAt: now.toISOString(),
                  }
                : {
                    policy: "preserve_without_replay_v1",
                    runId: run.id,
                    replay: "blocked",
                    actionOutcome: "unknown",
                    recordedAt: now.toISOString(),
                  },
            },
          })
          .where(eq(issueRecoveryActions.id, action.id));
        await persistActivity(tx as unknown as Db, {
          companyId: run.companyId,
          actorType: "system",
          actorId: "execution-recovery",
          action: "issue.execution_recovery_settled",
          entityType: "issue",
          entityId: task.id,
          runId: run.id,
          details: {
            recoveryActionId: action.id,
            outcome: current ? "blocked" : "cancelled",
            replay: sourceAuthorityChanged ? "superseded" : "not_authorized",
          },
        });
        await tx
          .update(heartbeatRuns)
          .set({ executionStatusDeliveryId: randomUUID() })
          .where(eq(heartbeatRuns.id, run.id));
        await appendHeartbeatRunEvent(tx as unknown as Db, {
          companyId: run.companyId,
          agentId: run.agentId,
          runId: run.id,
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: note,
          payload: {
            recoveryActionId: action.id,
            cause: action.cause,
            automaticRecovery: sourceAuthorityChanged ? "source_authority_changed_v1" : "preserve_without_replay_v1",
            replay: sourceAuthorityChanged ? "superseded" : "blocked",
          },
        });
        options.failpoint?.("persisted");
      });
    } catch (err) {
      if (options.failpoint) throw err;
      logger.warn(
        { err, recoveryActionId: candidate.id },
        "Automatic recovery disposition remains pending",
      );
    }
  }
  await supersedeEffectiveResolvedHolds(db, now);
}
