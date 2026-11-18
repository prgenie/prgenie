import { COMPUTE_JOB_DEFAULT_WATCHDOG, isComputeJob } from "./job-type-watchdog.js";
import {
  DEFAULT_WATCHDOG,
  WATCHDOG_RECOVERY_ATTEMPTS_MAX,
  type WatchdogPolicy,
} from "./runner-policy.js";
import { validateWatchdogPatch } from "./settings-validation.js";
import type { JobEffectiveSnapshot, JobRecord, JobStage, JobStageModels } from "./types.js";
import { ValidationError } from "./validation-error.js";

const EXTENDABLE_STAGES = new Set<JobStage>(["building", "reviewing", "fixing"]);

export type ExtendWatchdogErrorCode = "invalid_id" | "not_found" | "archived" | "not_running";

export class ExtendWatchdogError extends Error {
  readonly stage?: string;

  constructor(
    message: string,
    readonly code: ExtendWatchdogErrorCode,
    stage?: string,
  ) {
    super(message);
    this.name = "ExtendWatchdogError";
    this.stage = stage;
  }
}

export type ExtendWatchdogRequest = {
  /** New stage cap. Must be within the global bounds and at least the job's current cap. */
  stageCapMs?: number;
  /** Add one recovery attempt, up to the global maximum. */
  grantRecovery: boolean;
};

export type WatchdogExtension = {
  previousStageCapMs: number;
  previousRecoveryAttempts: number;
  stageCapMs: number;
  recoveryAttempts: number;
};

export type ExtendWatchdogResult = {
  ok: true;
  id: string;
  stage: string;
  watchdogStageCapMs: number;
  watchdogRecoveryAttempts: number;
  previousStageCapMs: number;
  previousRecoveryAttempts: number;
  /** Worker-monitor stage budget recomputed from the updated snapshot. */
  stageBudgetMs: number;
  watchdogCapApproaching: boolean;
};

export function parseExtendWatchdogRequest(raw: unknown): ExtendWatchdogRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("watchdog extension must be an object");
  }
  const body = raw as Record<string, unknown>;
  let stageCapMs: number | undefined;
  if (body.stageCapMs !== undefined) {
    stageCapMs = validateWatchdogPatch({ stageCapMs: body.stageCapMs })?.stageCapMs;
  }
  if (body.grantRecovery !== undefined && typeof body.grantRecovery !== "boolean") {
    throw new ValidationError("grantRecovery must be a boolean");
  }
  const grantRecovery = body.grantRecovery === true;
  if (stageCapMs === undefined && !grantRecovery) {
    throw new ValidationError("stageCapMs or grantRecovery is required");
  }
  return { stageCapMs, grantRecovery };
}

function stageModelsFor(job: JobRecord): JobStageModels {
  return (
    job.stageModels ??
    job.effectiveSnapshot?.stageModels ?? {
      build: job.model,
      review: job.model,
      fix: job.model,
    }
  );
}

function baselineWatchdog(job: JobRecord): WatchdogPolicy {
  return isComputeJob(job) ? COMPUTE_JOB_DEFAULT_WATCHDOG : DEFAULT_WATCHDOG;
}

function ensureSnapshot(job: JobRecord): JobEffectiveSnapshot {
  if (job.effectiveSnapshot) return job.effectiveSnapshot;
  const base = baselineWatchdog(job);
  job.effectiveSnapshot = {
    maxRounds: job.maxRounds,
    stageModels: stageModelsFor(job),
    baseRef: job.baseRef ?? null,
    watchdogInactivityMs: base.inactivityMs,
    watchdogStageCapMs: base.stageCapMs,
    watchdogRecoveryAttempts: base.recoveryAttempts,
  };
  return job.effectiveSnapshot;
}

/**
 * Raise a running job's snapshotted stage cap and/or grant one recovery.
 * Mutates `job` only after the request is valid.
 */
export function applyWatchdogExtension(
  job: JobRecord,
  request: ExtendWatchdogRequest,
): WatchdogExtension {
  if (job.archivedAt) {
    throw new ExtendWatchdogError(
      `job is archived; restore it before extending the watchdog: ${job.id}`,
      "archived",
    );
  }
  if (!EXTENDABLE_STAGES.has(job.stage)) {
    throw new ExtendWatchdogError(`job is not running (${job.stage})`, "not_running", job.stage);
  }
  const snap = ensureSnapshot(job);
  const previousStageCapMs = snap.watchdogStageCapMs;
  const previousRecoveryAttempts = snap.watchdogRecoveryAttempts;
  let stageCapMs = previousStageCapMs;
  let recoveryAttempts = previousRecoveryAttempts;
  if (request.stageCapMs !== undefined) {
    if (request.stageCapMs < previousStageCapMs) {
      throw new ValidationError(
        `watchdog.stageCapMs must be at least the current cap (${previousStageCapMs})`,
      );
    }
    stageCapMs = request.stageCapMs;
  }
  if (request.grantRecovery) {
    if (previousRecoveryAttempts >= WATCHDOG_RECOVERY_ATTEMPTS_MAX) {
      throw new ValidationError(
        `watchdog.recoveryAttempts is already at the maximum (${WATCHDOG_RECOVERY_ATTEMPTS_MAX})`,
      );
    }
    recoveryAttempts = previousRecoveryAttempts + 1;
  }
  if (stageCapMs === previousStageCapMs && recoveryAttempts === previousRecoveryAttempts) {
    throw new ValidationError(
      "watchdog.stageCapMs is already at that value; raise it or set grantRecovery",
    );
  }
  snap.watchdogStageCapMs = stageCapMs;
  snap.watchdogRecoveryAttempts = recoveryAttempts;
  return { previousStageCapMs, previousRecoveryAttempts, stageCapMs, recoveryAttempts };
}

export function formatWatchdogExtensionLog(change: WatchdogExtension): string {
  return `[runner] extended watchdog: stageCapMs ${change.previousStageCapMs} -> ${change.stageCapMs}, recoveryAttempts ${change.previousRecoveryAttempts} -> ${change.recoveryAttempts}\n`;
}

/**
 * Keep a raised cap or recovery count when a stale in-memory copy is saved.
 * Extensions only increase those two fields, so the higher value wins.
 */
export function adoptRaisedWatchdog(target: JobRecord, other: JobRecord | null): void {
  const raised = other?.effectiveSnapshot;
  if (!raised) return;
  if (!target.effectiveSnapshot) {
    target.effectiveSnapshot = {
      maxRounds: target.maxRounds,
      stageModels: stageModelsFor(target),
      baseRef: target.baseRef ?? raised.baseRef,
      watchdogInactivityMs: raised.watchdogInactivityMs,
      watchdogStageCapMs: raised.watchdogStageCapMs,
      watchdogRecoveryAttempts: raised.watchdogRecoveryAttempts,
    };
    return;
  }
  const snap = target.effectiveSnapshot;
  if (raised.watchdogStageCapMs > snap.watchdogStageCapMs) {
    snap.watchdogStageCapMs = raised.watchdogStageCapMs;
  }
  if (raised.watchdogRecoveryAttempts > snap.watchdogRecoveryAttempts) {
    snap.watchdogRecoveryAttempts = raised.watchdogRecoveryAttempts;
  }
}
