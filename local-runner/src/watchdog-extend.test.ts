import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { RunnerEngine } from "./engine.js";
import type { WorkerLockRecord } from "./job-worker-lock.js";
import { workerBudgetForJob, workerStall } from "./job-worker-monitor.js";
import { jobLogFile } from "./paths.js";
import { WATCHDOG_STAGE_CAP_MS_MAX } from "./runner-policy.js";
import { loadJob, saveJob } from "./store.js";
import type { JobEffectiveSnapshot, JobRecord } from "./types.js";
import { ValidationError } from "./validation-error.js";
import {
  applyWatchdogExtension,
  ExtendWatchdogError,
  parseExtendWatchdogRequest,
} from "./watchdog-extend.js";

function snapshot(partial: Partial<JobEffectiveSnapshot> = {}): JobEffectiveSnapshot {
  return {
    maxRounds: 3,
    stageModels: { build: "m", review: "m", fix: "m" },
    baseRef: "main",
    watchdogInactivityMs: 60 * 60_000,
    watchdogStageCapMs: 30 * 60_000,
    watchdogRecoveryAttempts: 0,
    ...partial,
  };
}

function job(partial: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
    input: { repoPath: "/repo", branch: "characters/meg-retopo-v001", promptFile: "/p" },
    stage: "building",
    reviewRound: 0,
    maxRounds: 3,
    model: "m",
    driverId: "cursor-agent",
    worktreePath: "/wt",
    repoSlug: "o/r",
    prUrl: null,
    prNumber: null,
    prIsDraft: null,
    approveHeadSha: null,
    readyPromotedAt: null,
    linearIssue: null,
    ticketUrl: null,
    title: "retopo",
    tokenUsage: null,
    ciStatus: null,
    lastVerdict: null,
    error: null,
    logPath: "/tmp/job-1.log",
    steerQueue: [],
    stopRequested: false,
    dryRun: true,
    archivedAt: null,
    effectiveSnapshot: snapshot(),
    watchdog: {
      lastActivityAt: "2026-11-11T04:45:00.000Z",
      stageStartedAt: "2026-11-11T02:45:00.000Z",
      recoveryAttemptsUsed: 1,
      lastRecoveryAt: "2026-11-11T04:43:00.000Z",
      lastStallReason: "stage exceeded hard cap",
    },
    ...partial,
  };
}

function withoutSnapshot(record: JobRecord): JobRecord {
  const copy: JobRecord = { ...record };
  delete copy.effectiveSnapshot;
  return copy;
}

function lockAt(nowMs: number): WorkerLockRecord {
  return {
    pid: 1,
    hostname: "test",
    startedAt: new Date(0).toISOString(),
    token: "tok",
    heartbeatAt: new Date(nowMs).toISOString(),
  };
}

describe("extend a running job watchdog (#216)", () => {
  it("rejects a payload that neither raises the cap nor grants a recovery", () => {
    assert.throws(
      () => parseExtendWatchdogRequest({}),
      (err: Error) =>
        err instanceof ValidationError && /stageCapMs or grantRecovery/.test(err.message),
    );
    assert.throws(
      () => parseExtendWatchdogRequest({ stageCapMs: 9 * 60 * 60 * 1000 }),
      (err: Error) => err instanceof ValidationError && /28800000/.test(err.message),
    );
    assert.throws(
      () => parseExtendWatchdogRequest({ grantRecovery: "yes" }),
      (err: Error) =>
        err instanceof ValidationError && /grantRecovery must be a boolean/.test(err.message),
    );
  });

  it("raises the cap and grants one recovery, clearing a blown stage budget", () => {
    const running = job();
    const now = Date.parse("2026-11-11T04:45:00.000Z");
    const start = now - 2 * 60 * 60_000;
    running.watchdog!.stageStartedAt = new Date(start).toISOString();
    const held = lockAt(now);
    held.startedAt = new Date(start).toISOString();
    const before = workerBudgetForJob(running).stageBudgetMs;
    assert.equal(workerStall(running, held, now)?.kind, "stage");

    const change = applyWatchdogExtension(running, {
      stageCapMs: WATCHDOG_STAGE_CAP_MS_MAX,
      grantRecovery: true,
    });
    assert.equal(change.previousStageCapMs, 30 * 60_000);
    assert.equal(change.previousRecoveryAttempts, 0);
    assert.equal(running.effectiveSnapshot?.watchdogStageCapMs, WATCHDOG_STAGE_CAP_MS_MAX);
    assert.equal(running.effectiveSnapshot?.watchdogRecoveryAttempts, 1);
    assert.equal(workerStall(running, held, now), null);
    assert.ok(workerBudgetForJob(running).stageBudgetMs > before);
  });

  it("refuses to lower the cap, exceed max recoveries, or extend a job that is not running", () => {
    const running = job({
      effectiveSnapshot: snapshot({
        watchdogStageCapMs: WATCHDOG_STAGE_CAP_MS_MAX,
        watchdogRecoveryAttempts: 3,
      }),
    });
    assert.throws(
      () => applyWatchdogExtension(running, { stageCapMs: 60 * 60_000, grantRecovery: false }),
      (err: Error) =>
        err instanceof ValidationError && /at least the current cap/.test(err.message),
    );
    assert.equal(running.effectiveSnapshot?.watchdogStageCapMs, WATCHDOG_STAGE_CAP_MS_MAX);
    assert.throws(
      () => applyWatchdogExtension(running, { grantRecovery: true }),
      (err: Error) => err instanceof ValidationError && /already at the maximum/.test(err.message),
    );
    assert.equal(running.effectiveSnapshot?.watchdogRecoveryAttempts, 3);

    const stuck = job({ stage: "stuck" });
    assert.throws(
      () => applyWatchdogExtension(stuck, { grantRecovery: true }),
      (err: Error) =>
        err instanceof ExtendWatchdogError && err.code === "not_running" && err.stage === "stuck",
    );
    const archived = job({ archivedAt: "2026-11-11T05:00:00.000Z" });
    assert.throws(
      () => applyWatchdogExtension(archived, { grantRecovery: true }),
      (err: Error) => err instanceof ExtendWatchdogError && err.code === "archived",
    );
  });

  it("synthesizes a snapshot for a legacy job, using compute defaults when that is the profile", () => {
    const legacy = withoutSnapshot(
      job({
        input: { ...job().input, jobType: "compute" },
      }),
    );
    const change = applyWatchdogExtension(legacy, { grantRecovery: true });
    assert.equal(change.previousStageCapMs, 8 * 60 * 60 * 1000);
    assert.equal(change.stageCapMs, 8 * 60 * 60 * 1000);
    assert.equal(legacy.effectiveSnapshot?.watchdogRecoveryAttempts, 1);
  });

  it("keeps an extension when the worker later saves a stale copy", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-wd-extend-"));
    await mkdir(path.join(dataDir, "logs"), { recursive: true });
    const record = job({ id: "job-live", logPath: jobLogFile(dataDir, "job-live") });
    await saveJob(dataDir, record);
    const stale = (await loadJob(dataDir, record.id))!;
    const engine = new RunnerEngine({
      host: "127.0.0.1",
      port: 0,
      token: "t",
      dataDir,
      notifyEmail: null,
      resendApiKey: null,
      defaultModel: "m",
      dryRun: true,
      defaultCodeRepoPath: null,
    } satisfies RunnerConfig);
    const extended = await engine.extendWatchdog({
      id: record.id,
      stageCapMs: WATCHDOG_STAGE_CAP_MS_MAX,
      grantRecovery: true,
    });
    assert.equal(extended.watchdogStageCapMs, WATCHDOG_STAGE_CAP_MS_MAX);
    assert.equal(extended.watchdogRecoveryAttempts, 1);
    assert.equal(
      extended.stageBudgetMs,
      workerBudgetForJob((await loadJob(dataDir, record.id))!).stageBudgetMs,
    );

    stale.watchdog!.lastActivityAt = "2026-11-11T04:46:00.000Z";
    await saveJob(dataDir, stale);
    assert.equal(stale.effectiveSnapshot?.watchdogStageCapMs, WATCHDOG_STAGE_CAP_MS_MAX);
    assert.equal(stale.effectiveSnapshot?.watchdogRecoveryAttempts, 1);
    const disk = (await loadJob(dataDir, record.id))!;
    assert.equal(disk.effectiveSnapshot?.watchdogStageCapMs, WATCHDOG_STAGE_CAP_MS_MAX);
    assert.equal(disk.effectiveSnapshot?.watchdogRecoveryAttempts, 1);
    assert.equal(disk.watchdog?.lastActivityAt, "2026-11-11T04:46:00.000Z");
    const log = await readFile(disk.logPath, "utf8");
    assert.match(log, /extended watchdog: stageCapMs 1800000 -> 28800000, recoveryAttempts 0 -> 1/);
  });
});
