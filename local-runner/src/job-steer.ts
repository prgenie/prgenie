import { isJobArchived } from "./job-cwd.js";
import type { JobRecord, JobStage } from "./types.js";

/** Terminal stages where steer stores guidance and the next continue applies it. */
export const STEER_PENDING_STAGES = new Set<JobStage>([
  "failed",
  "stuck",
  "interrupted",
  "changes_remaining",
  "stopped",
]);

const CONTINUE_WITH_PROMPT = "use continue_job / POST …/continue with a prompt";

export class SteerJobError extends Error {
  constructor(
    message: string,
    readonly code: "archived" | "rejected",
    readonly stage?: string,
  ) {
    super(message);
    this.name = "SteerJobError";
  }
}

export function jobIsMerged(job: Pick<JobRecord, "ciStatus">): boolean {
  return job.ciStatus?.status === "merged" || Boolean(job.ciStatus?.mergedAt);
}

/**
 * Running jobs and recoverable terminal jobs may be steered.
 * Approved, archived, and merged jobs must go through continue_job with a prompt.
 */
export function assertSteerAllowed(job: JobRecord): void {
  if (isJobArchived(job)) {
    throw new SteerJobError(
      `job is archived; restore it, then ${CONTINUE_WITH_PROMPT}`,
      "archived",
      job.stage,
    );
  }
  if (jobIsMerged(job)) {
    throw new SteerJobError(`job is merged; ${CONTINUE_WITH_PROMPT}`, "rejected", job.stage);
  }
  if (job.stage === "approved") {
    throw new SteerJobError(`job is approved; ${CONTINUE_WITH_PROMPT}`, "rejected", job.stage);
  }
}

export function canSteerJob(job: Pick<JobRecord, "stage" | "archivedAt" | "ciStatus">): boolean {
  if (isJobArchived(job)) return false;
  if (jobIsMerged(job) || job.stage === "approved") return false;
  return true;
}
