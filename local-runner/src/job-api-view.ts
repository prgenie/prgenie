import { workerBudgetForJob } from "./job-worker-monitor.js";
import type { JobRecord } from "./types.js";

const ACTIVE_STAGES = new Set(["building", "reviewing", "fixing"]);

/** Fraction of the worker stage budget used before status says the cap is approaching (#216). */
export const WATCHDOG_CAP_APPROACH_RATIO = 0.8;

export type JobPublicView = JobRecord & {
  /** Same as input.branch — top-level for API clients (#204). */
  branch: string;
  queued: boolean;
  queuePosition: number | null;
  /** Human status when watchdog activity is not set yet (#203). */
  activityMessage: string | null;
  /** True once an active stage has used {@link WATCHDOG_CAP_APPROACH_RATIO} of its stage budget. */
  watchdogCapApproaching: boolean;
  logTail?: string;
};

/** True when the live stage is near the worker monitor's stage budget (or already past it). */
export function watchdogCapApproaching(job: JobRecord, nowMs = Date.now()): boolean {
  if (job.queueState?.queued || job.stopRequested || !ACTIVE_STAGES.has(job.stage)) return false;
  const started = Date.parse(job.watchdog?.stageStartedAt ?? "");
  if (!Number.isFinite(started)) return false;
  const elapsed = nowMs - started;
  if (elapsed <= 0) return false;
  return elapsed >= workerBudgetForJob(job).stageBudgetMs * WATCHDOG_CAP_APPROACH_RATIO;
}

function formatStatusDetail(detail: NonNullable<JobRecord["statusDetail"]>): string {
  if (detail.until) {
    const t = Date.parse(detail.until);
    const untilLabel = Number.isNaN(t)
      ? detail.until
      : new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return `${detail.reason} until ${untilLabel}`;
  }
  return detail.reason;
}

function jobActivityMessageBase(job: JobRecord): string | null {
  const queued = Boolean(job.queueState?.queued);
  if (queued) {
    const pos = job.queueState?.position;
    return pos != null ? `Queued (position ${pos})` : "Queued";
  }
  if (job.statusDetail?.reason) {
    return formatStatusDetail(job.statusDetail);
  }
  if (!ACTIVE_STAGES.has(job.stage) || job.stopRequested) return null;
  if (!job.dryRun && !job.worktreePath) {
    return "Preparing worktree";
  }
  if (job.runtime?.waitMode === "command" && job.runtime.command?.summary) {
    return `Preparing: ${job.runtime.command.summary}`;
  }
  if (job.runtime?.waitMode === "agent") {
    return "Agent running";
  }
  if (!job.watchdog?.lastActivityAt && !job.dryRun && job.worker) {
    return "Starting worker";
  }
  return null;
}

export function jobActivityMessage(job: JobRecord, nowMs = Date.now()): string | null {
  const base = jobActivityMessageBase(job);
  if (!watchdogCapApproaching(job, nowMs) || base?.startsWith("Queued")) return base;
  return base ? `${base} — cap approaching` : "Watchdog cap approaching";
}

export function enrichJobPublicView(
  job: JobRecord,
  extra?: { logTail?: string; nowMs?: number },
): JobPublicView {
  const nowMs = extra?.nowMs ?? Date.now();
  const queued = Boolean(job.queueState?.queued);
  const queuePosition = queued ? (job.queueState?.position ?? null) : null;
  const branch = job.input?.branch?.trim() ?? "";
  const activityMessage = jobActivityMessage(job, nowMs);
  const base = { ...job } as JobRecord & { branch?: string | null };
  delete base.branch;
  return {
    ...base,
    branch,
    queued,
    queuePosition,
    activityMessage,
    watchdogCapApproaching: watchdogCapApproaching(job, nowMs),
    ...(extra?.logTail !== undefined ? { logTail: extra.logTail } : {}),
  };
}
