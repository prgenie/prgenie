import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enrichJobPublicView, jobActivityMessage } from "./job-api-view.js";
import { workerBudgetForJob } from "./job-worker-monitor.js";
import type { JobEffectiveSnapshot, JobRecord } from "./types.js";

function job(partial: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "abc",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    input: { repoPath: "/r", branch: "feat/target", promptFile: "/p" },
    stage: "building",
    reviewRound: 0,
    maxRounds: 2,
    model: "m",
    driverId: "cursor-agent",
    worktreePath: null,
    repoSlug: "o/r",
    prUrl: null,
    prNumber: null,
    prIsDraft: null,
    approveHeadSha: null,
    readyPromotedAt: null,
    linearIssue: null,
    ticketUrl: null,
    title: "t",
    tokenUsage: null,
    ciStatus: null,
    lastVerdict: null,
    error: null,
    logPath: "/log",
    steerQueue: [],
    stopRequested: false,
    dryRun: false,
    archivedAt: null,
    ...partial,
  };
}

describe("enrichJobPublicView", () => {
  it("fills branch from input and clears a misleading null top-level branch (#204)", () => {
    const legacy = { ...job(), branch: null } as JobRecord & { branch: null };
    const view = enrichJobPublicView(legacy);
    assert.equal(view.branch, "feat/target");
    assert.equal(view.input.branch, "feat/target");
  });

  it("exposes queued and queuePosition (#203)", () => {
    const view = enrichJobPublicView(
      job({ queueState: { queued: true, position: 2, since: "2026-01-01T00:00:00.000Z" } }),
    );
    assert.equal(view.queued, true);
    assert.equal(view.queuePosition, 2);
    assert.match(view.activityMessage ?? "", /Queued \(position 2\)/);
  });

  it("reports preparing worktree when building without a worktree", () => {
    assert.equal(
      jobActivityMessage(job({ stage: "building", worktreePath: null })),
      "Preparing worktree",
    );
  });

  it("surfaces cap approaching once the stage has used most of its budget (#216)", () => {
    const snap: JobEffectiveSnapshot = {
      maxRounds: 2,
      stageModels: { build: "m", review: "m", rereview: "m", fix: "m" },
      baseRef: "main",
      watchdogInactivityMs: 15 * 60_000,
      watchdogStageCapMs: 120 * 60_000,
      watchdogRecoveryAttempts: 1,
    };
    const running = job({
      effectiveSnapshot: snap,
      watchdog: {
        lastActivityAt: "2026-11-11T04:45:00.000Z",
        stageStartedAt: "2026-11-11T00:00:00.000Z",
        recoveryAttemptsUsed: 1,
        lastRecoveryAt: "2026-11-11T02:00:00.000Z",
        lastStallReason: null,
      },
    });
    const budget = workerBudgetForJob(running).stageBudgetMs;
    const started = Date.parse(running.watchdog!.stageStartedAt!);
    const under = enrichJobPublicView(running, { nowMs: started + Math.floor(budget * 0.5) });
    assert.equal(under.watchdogCapApproaching, false);
    assert.equal(under.activityMessage, "Preparing worktree");
    const over = enrichJobPublicView(running, { nowMs: started + Math.floor(budget * 0.85) });
    assert.equal(over.watchdogCapApproaching, true);
    assert.match(over.activityMessage ?? "", /cap approaching/);
    const raised = enrichJobPublicView(
      job({
        ...running,
        effectiveSnapshot: { ...snap, watchdogStageCapMs: 8 * 60 * 60 * 1000 },
      }),
      { nowMs: started + Math.floor(budget * 0.85) },
    );
    assert.equal(raised.watchdogCapApproaching, false);
  });

  it("surfaces statusDetail for GitHub rate-limit waits (#223)", () => {
    const msg = jobActivityMessage(
      job({
        statusDetail: {
          reason: "waiting on GitHub rate limit",
          until: "2026-11-16T22:40:00.000Z",
        },
      }),
    );
    assert.match(msg ?? "", /waiting on GitHub rate limit until/i);
  });
});
