import { readFile } from "node:fs/promises";
import type { RunnerConfig } from "./config.js";
import { isJobArchived } from "./job-cwd.js";
import { driverSupportsAuto } from "./job-models.js";
import {
  decideJobStart,
  jobsHoldingBranch,
  listJobsForQueue,
  type QueueOptions,
} from "./job-queue.js";
import { loadSettings } from "./settings.js";
import { loadArchivedJob, loadJob, saveJob } from "./store.js";
import type { JobContinueHistoryEntry, JobRecord } from "./types.js";
import {
  abortGitOperationInProgress,
  detectGitOperationInProgress,
  ensureContinueWorktree,
} from "./worktree.js";
import { ghRaw, git as defaultGit } from "./github.js";
import type { PrInfo } from "./github.js";
import { fetchRateLimitResets, isGithubRateLimitResult } from "./github-rate-limit.js";
import { restFindOpenPrForBranchOnce } from "./github-rest.js";
import { shouldResumePostBuildPr } from "./job-pr-policy.js";
import { assertContinueMaxRounds, normalizeContinueJobArgs } from "./settings-validation.js";
import type { GhResult } from "./spawn-cmd.js";
import type { ContinueJobArgs } from "./types.js";

export const CONTINUE_TERMINAL_STAGES = new Set([
  "approved",
  "changes_remaining",
  "stuck",
  "stopped",
  "failed",
  "interrupted",
]);

export type ContinueJobErrorCode =
  | "invalid_id"
  | "not_found"
  | "archived"
  | "running"
  | "not_terminal"
  | "branch_conflict"
  | "rate_limited";

export class ContinueJobError extends Error {
  constructor(
    message: string,
    readonly code: ContinueJobErrorCode,
    readonly stage?: string,
    /** GitHub REST core/graphql reset epoch (seconds) when code is rate_limited. */
    readonly resetAtEpochSec?: number,
  ) {
    super(message);
    this.name = "ContinueJobError";
  }
}

export type ContinueJobResult = {
  job: JobRecord;
  worktree: "reused" | "recreated" | "none";
  queued: boolean;
};

export type ContinueJobDeps = {
  isRunning: (id: string) => boolean;
  ensureWorktree?: typeof ensureContinueWorktree;
  readPromptFile?: (filePath: string) => Promise<string>;
  gitImpl?: typeof defaultGit;
  findOpenPrOnce?: (
    cwd: string,
    branch: string,
    repoSlug?: string | null,
  ) => Promise<{ pr: PrInfo | null; res: GhResult }>;
};

export type PrepareContinueOptions = {
  /** Record a reboot auto-continue so a later startup in the same boot does not repeat it. */
  rebootBootId?: string;
};

function jobHadWorktree(job: JobRecord): boolean {
  return Boolean(job.worktreePath?.trim());
}

async function adoptOpenPrForBranchIfNeeded(
  job: JobRecord,
  deps: ContinueJobDeps,
): Promise<boolean> {
  if (job.prUrl?.trim() || job.dryRun) return false;
  if (!jobHadWorktree(job)) return false;
  if (shouldResumePostBuildPr(job)) return false;
  const cwd = job.worktreePath!.trim();
  const lookup =
    deps.findOpenPrOnce ??
    ((c, branch, slug) => restFindOpenPrForBranchOnce(c, branch, slug, ghRaw));
  const { pr: existing, res } = await lookup(cwd, job.input.branch, job.repoSlug);
  if (isGithubRateLimitResult(res)) {
    const resets = await fetchRateLimitResets(cwd, ghRaw);
    const resetAt = Math.max(resets?.core ?? 0, resets?.graphql ?? 0) || undefined;
    const until = resetAt != null ? new Date(resetAt * 1000).toLocaleTimeString() : "later";
    throw new ContinueJobError(
      `GitHub rate limit; retry continue after ${until}`,
      "rate_limited",
      job.stage,
      resetAt,
    );
  }
  if (!existing) return false;
  job.prUrl = existing.url;
  job.prNumber = existing.number;
  job.postBuildPendingPr = false;
  return true;
}

async function readOptionalPromptFile(
  filePath: string | undefined,
  readFn: (p: string) => Promise<string>,
): Promise<string> {
  const path = filePath?.trim();
  if (!path) return "";
  try {
    return (await readFn(path)).trim();
  } catch {
    throw new ContinueJobError(`promptFile not readable: ${path}`, "not_found");
  }
}

function mergeContinuePrompt(prompt?: string, fromFile?: string): string | undefined {
  const parts = [prompt?.trim(), fromFile?.trim()].filter(Boolean) as string[];
  if (!parts.length) return undefined;
  return parts.join("\n\n");
}

export async function prepareJobContinue(
  config: RunnerConfig,
  args: ContinueJobArgs,
  deps: ContinueJobDeps,
  opts: PrepareContinueOptions = {},
): Promise<ContinueJobResult> {
  const id = args.id.trim();
  if (!id) throw new ContinueJobError("id is required", "invalid_id");

  let job = await loadJob(config.dataDir, id);
  if (!job) {
    const archived = await loadArchivedJob(config.dataDir, id);
    if (archived) {
      throw new ContinueJobError(
        `job is archived; restore it before continuing: ${id}`,
        "archived",
      );
    }
    throw new ContinueJobError(`job not found: ${id}`, "not_found");
  }
  if (isJobArchived(job)) {
    throw new ContinueJobError(`job is archived; restore it before continuing: ${id}`, "archived");
  }
  if (deps.isRunning(id)) {
    throw new ContinueJobError(`job is still running (${job.stage})`, "running", job.stage);
  }
  if (!CONTINUE_TERMINAL_STAGES.has(job.stage)) {
    throw new ContinueJobError(
      `job is not in a terminal stage (${job.stage}); stop it first`,
      "not_terminal",
      job.stage,
    );
  }
  await adoptOpenPrForBranchIfNeeded(job, deps);
  const resumePostBuildPr = shouldResumePostBuildPr(job);
  // No PR yet: resume by re-running the build stage (same branch/worktree, then open PR when ready).
  const resumeBuild = !job.prUrl?.trim() && !resumePostBuildPr;

  const settings = await loadSettings(config.dataDir);
  const queueOpts: QueueOptions = { isRunning: deps.isRunning };
  const jobs = await listJobsForQueue(config.dataDir);
  const holders = jobsHoldingBranch(jobs, job.input.branch, job.repoSlug, queueOpts).filter(
    (j) => j.id !== id,
  );
  if (holders.length > 0) {
    throw new ContinueJobError(
      `another active job is already using branch ${job.input.branch}`,
      "branch_conflict",
    );
  }

  const readFn = deps.readPromptFile ?? ((p: string) => readFile(p, "utf8"));
  const fromFile = await readOptionalPromptFile(args.promptFile, readFn);
  const instructions = mergeContinuePrompt(args.prompt, fromFile);

  // A build resume has not spent any review rounds yet, so it adds none unless asked.
  const extraRounds = args.extraRounds ?? (resumeBuild || resumePostBuildPr ? 0 : 1);
  assertContinueMaxRounds(job.maxRounds, extraRounds);
  const nextMax = job.maxRounds + extraRounds;

  let worktree: ContinueJobResult["worktree"] = "none";
  if (!job.dryRun && job.input.repoPath?.trim()) {
    const ensure = deps.ensureWorktree ?? ensureContinueWorktree;
    const wt = await ensure(
      job.input.repoPath,
      job.id,
      job.input.branch,
      job.worktreePath,
      settings,
      { dataDir: config.dataDir },
    );
    job.worktreePath = wt.path;
    worktree = wt.reused ? "reused" : "recreated";
    const gitImpl = deps.gitImpl ?? defaultGit;
    const pending = await detectGitOperationInProgress(wt.path, gitImpl);
    if (pending === "merge" && !resumeBuild && !resumePostBuildPr) {
      // Keep an unfinished base merge: the fix stage hands its conflicts to the agent instead of
      // redoing the same merge and failing again (#239). Aborting here caused a retry loop.
      job.steerQueue.push(
        "[runner] Found an unfinished git merge in the worktree; the fix agent will resolve its conflicts and commit the merge.",
      );
    } else if (pending) {
      const aborted = await abortGitOperationInProgress(wt.path, pending, gitImpl);
      if (!aborted.ok) {
        throw new ContinueJobError(
          `worktree has an unfinished git ${pending} (${aborted.error}). Resolve or run git ${pending === "rebase" ? "rebase --abort" : pending === "merge" ? "merge --abort" : "cherry-pick --abort"} manually, then continue again.`,
          "not_terminal",
        );
      }
      job.steerQueue.push(
        `[runner] Aborted unfinished git ${pending} before continue so the agent starts from a clean branch.`,
      );
    }
  } else if (job.input.repoPath?.trim()) {
    job.worktreePath = job.input.repoPath;
    worktree = "reused";
  }

  const history: JobContinueHistoryEntry = {
    at: new Date().toISOString(),
    extraRounds,
    priorMaxRounds: job.maxRounds,
    newMaxRounds: nextMax,
    prompt: instructions ?? null,
    model: args.model ?? null,
    ...(resumeBuild
      ? { resumedStage: "building" as const }
      : resumePostBuildPr
        ? { resumedStage: "post_build_pr" as const }
        : {}),
  };
  if (!job.continueHistory) job.continueHistory = [];
  job.continueHistory.push(history);

  job.maxRounds = nextMax;
  if (job.effectiveSnapshot) job.effectiveSnapshot.maxRounds = nextMax;

  if (args.model?.trim()) {
    const m = args.model.trim();
    if (m === "auto" && !driverSupportsAuto(job.driverId)) {
      throw new ContinueJobError(
        `model "auto" is not supported for driver ${job.driverId}`,
        "not_terminal",
      );
    }
    if (job.stageModels) job.stageModels[resumeBuild || resumePostBuildPr ? "build" : "fix"] = m;
  }

  if (instructions) {
    job.steerQueue.push(instructions);
  }

  job.stopRequested = false;
  job.error = null;
  job.stage = resumeBuild || resumePostBuildPr ? "building" : "fixing";
  if (resumeBuild || resumePostBuildPr) job.reviewRound = 0;
  if (resumePostBuildPr) job.postBuildPendingPr = true;
  if (job.queueState?.queued) job.queueState = undefined;

  const decision = decideJobStart(
    jobs.filter((j) => j.id !== id),
    job.input.branch,
    job.repoSlug,
    settings.maxActiveJobs,
    queueOpts,
  );
  let queued = false;
  if (decision.action === "queue") {
    job.queueState = {
      queued: true,
      position: decision.position,
      since: new Date().toISOString(),
    };
    queued = true;
  } else if (decision.action === "reject") {
    throw new ContinueJobError(decision.reason, "branch_conflict");
  }

  const bootId = opts.rebootBootId?.trim();
  if (bootId) {
    job.rebootAutoContinue = { bootId, at: new Date().toISOString() };
  } else {
    job.rebootAutoContinue = null;
  }

  await saveJob(config.dataDir, job);
  return { job, worktree, queued };
}

export async function continueJobFromRaw(
  config: RunnerConfig,
  raw: Record<string, unknown>,
  deps: ContinueJobDeps,
  opts?: PrepareContinueOptions,
): Promise<ContinueJobResult> {
  const args = normalizeContinueJobArgs(raw);
  return prepareJobContinue(config, args, deps, opts);
}
