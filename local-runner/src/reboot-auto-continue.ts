import { access, appendFile, readFile } from "node:fs/promises";
import type { RunnerConfig } from "./config.js";
import { loadNotifySettings, resolveNotifyRecipient } from "./notify-settings.js";
import { formatJobEmailHtml, sendResendEmail, type FetchFn } from "./resend.js";
import { loadSettings } from "./settings.js";
import { listJobs } from "./store.js";
import type { JobRecord } from "./types.js";

/** Linux boot id, or a stable fallback so a missing procfs still cannot loop. */
export async function readMachineBootId(): Promise<string> {
  try {
    const id = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (id) return id;
  } catch {
    // Not Linux, or proc is unavailable.
  }
  return "unknown-boot";
}

export function isWorkerExitInterrupt(job: JobRecord): boolean {
  if (job.stage !== "interrupted" || job.stopRequested) return false;
  return /Interrupted \(worker_exit\b/.test(job.error ?? "");
}

export function alreadyAutoContinuedThisBoot(job: JobRecord, bootId: string): boolean {
  const recorded = job.rebootAutoContinue?.bootId?.trim();
  return Boolean(recorded) && recorded === bootId.trim();
}

export async function jobWorktreeExists(job: JobRecord): Promise<boolean> {
  const wt = job.worktreePath?.trim();
  if (!wt) return false;
  try {
    await access(wt);
    return true;
  } catch {
    return false;
  }
}

export type AutoContinueOutcome = {
  queued: boolean;
  stage: string;
  job: JobRecord | null;
};

export type ResumeInterruptedDeps = {
  bootId: string;
  continueJob: (jobId: string, bootId: string) => Promise<AutoContinueOutcome>;
  worktreeExists?: (job: JobRecord) => Promise<boolean>;
  log?: (message: string) => void;
  fetchImpl?: FetchFn;
};

export type ResumeInterruptedResult = {
  continued: Array<{ id: string; queued: boolean; stage: string }>;
};

/**
 * Continue `worker_exit` jobs whose worktree is still on disk. Respects maxActiveJobs via
 * `continueJob` (overflow is queued). Each job is attempted at most once per boot id.
 */
export async function resumeInterruptedJobsOnBoot(
  config: RunnerConfig,
  deps: ResumeInterruptedDeps,
): Promise<ResumeInterruptedResult> {
  const settings = await loadSettings(config.dataDir);
  if (!settings.autoContinueOnBoot) return { continued: [] };

  const bootId = deps.bootId.trim() || "unknown-boot";
  const exists = deps.worktreeExists ?? jobWorktreeExists;
  const log = deps.log ?? ((message: string) => console.log(message));
  const jobs = (await listJobs(config.dataDir))
    .filter((job) => !job.archivedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const continued: ResumeInterruptedResult["continued"] = [];
  for (const job of jobs) {
    if (!isWorkerExitInterrupt(job)) continue;
    if (alreadyAutoContinuedThisBoot(job, bootId)) continue;
    if (!(await exists(job))) continue;
    try {
      const outcome = await deps.continueJob(job.id, bootId);
      const where = outcome.queued ? "queued" : outcome.stage;
      log(`[prgenie] auto-continued job ${job.id} after reboot (${where})`);
      const note = outcome.queued
        ? "[runner] Auto-continued after reboot (queued).\n"
        : "[runner] Auto-continued after reboot.\n";
      const logPath = outcome.job?.logPath || job.logPath;
      if (logPath) await appendFile(logPath, note, "utf8").catch(() => undefined);
      if (outcome.job) {
        await notifyRebootAutoContinue(config, outcome.job, outcome.queued, deps.fetchImpl);
      }
      continued.push({ id: job.id, queued: outcome.queued, stage: outcome.stage });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[prgenie] auto-continue skipped ${job.id}: ${msg}`);
    }
  }
  return { continued };
}

export async function notifyRebootAutoContinue(
  config: RunnerConfig,
  job: JobRecord,
  queued: boolean,
  fetchImpl?: FetchFn,
): Promise<void> {
  const settings = await loadNotifySettings(config.dataDir);
  const to = resolveNotifyRecipient(config, settings);
  if (!to || !config.resendApiKey) return;
  const headline = queued
    ? `Auto-continued after reboot (queued): ${job.input.branch}`
    : `Auto-continued after reboot: ${job.input.branch}`;
  const result = await sendResendEmail(
    config.resendApiKey,
    {
      to,
      subject: headline,
      html: formatJobEmailHtml({
        headline,
        prUrl: job.prUrl,
        verdict: job.lastVerdict,
        stage: job.stage,
        jobId: job.id,
      }),
    },
    fetchImpl,
  );
  if (!result.ok) {
    console.warn(`[prgenie] auto-continue notify failed for ${job.id}: ${result.error}`);
  }
}
