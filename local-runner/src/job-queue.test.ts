import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { JobRecord } from "./types.js";
import {
  decideJobStart,
  formatTerminalBranchOwnerError,
  runnableQueuedJobs,
  terminalJobsOwningBranch,
} from "./job-queue.js";

function job(partial: Partial<JobRecord>): JobRecord {
  return {
    id: partial.id ?? "j",
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-01-01T00:00:00.000Z",
    input: partial.input ?? { repoPath: "/r", branch: "b", promptFile: "/p" },
    stage: partial.stage ?? "building",
    reviewRound: 0,
    maxRounds: 3,
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
    dryRun: true,
    archivedAt: null,
    ...partial,
  };
}

const queued = { queued: true, since: "2026-01-01T00:00:00.000Z" };

function onBranch(branch: string, partial: Partial<JobRecord> = {}): JobRecord {
  return job({ input: { repoPath: "/r", branch, promptFile: "/p" }, ...partial });
}

describe("job queue", () => {
  it("rejects a second job on the same branch", () => {
    const jobs = [onBranch("feat/x", { id: "a" })];
    const d = decideJobStart(jobs, "feat/x", "o/r", 2);
    assert.equal(d.action, "reject");
  });

  it("matches on repo slug, so remote-only and path starts of one repo collide", () => {
    const jobs = [
      onBranch("feat/x", {
        id: "a",
        input: { repoPath: "", remote: "https://github.com/o/r", branch: "feat/x", promptFile: "" },
      }),
    ];
    assert.equal(decideJobStart(jobs, "feat/x", "o/r", 2).action, "reject");
    assert.equal(decideJobStart(jobs, "feat/x", "other/repo", 2).action, "run");
  });

  it("queues when active cap is reached", () => {
    const jobs = [job({ id: "1", stage: "building" }), job({ id: "2", stage: "reviewing" })];
    const d = decideJobStart(jobs, "feat/other", "o/r", 2);
    assert.equal(d.action, "queue");
    if (d.action === "queue") assert.equal(d.position, 1);
  });

  it("rejects a duplicate same-branch submission while the cap is full", () => {
    const jobs = [
      onBranch("a", { id: "1" }),
      onBranch("b", { id: "2" }),
      onBranch("feat/x", { id: "3", queueState: queued }),
    ];
    const d = decideJobStart(jobs, "feat/x", "o/r", 2);
    assert.equal(d.action, "reject");
  });

  it("ignores stopped jobs when checking the branch", () => {
    const jobs = [onBranch("feat/x", { id: "a", stopRequested: true })];
    assert.equal(decideJobStart(jobs, "feat/x", "o/r", 2).action, "run");
  });

  it("a stop-requested job still unwinding keeps its branch and slot", () => {
    const jobs = [onBranch("feat/x", { id: "a", stopRequested: true })];
    const isRunning = (id: string) => id === "a";
    assert.equal(decideJobStart(jobs, "feat/x", "o/r", 2, { isRunning }).action, "reject");
    assert.equal(decideJobStart(jobs, "feat/y", "o/r", 1, { isRunning }).action, "queue");
    assert.equal(
      decideJobStart(jobs, "feat/x", "o/r", 2, { isRunning: () => false }).action,
      "run",
    );
  });
});

describe("runnableQueuedJobs", () => {
  it("fills every free slot, oldest first", () => {
    const jobs = [
      onBranch("q3", { id: "q3", queueState: queued, createdAt: "2026-01-03T00:00:00.000Z" }),
      onBranch("q1", { id: "q1", queueState: queued, createdAt: "2026-01-01T00:00:00.000Z" }),
      onBranch("q2", { id: "q2", queueState: queued, createdAt: "2026-01-02T00:00:00.000Z" }),
    ];
    assert.deepEqual(
      runnableQueuedJobs(jobs, 2).map((j) => j.id),
      ["q1", "q2"],
    );
  });

  it("skips stop-requested queued jobs and branches that are already running", () => {
    const jobs = [
      onBranch("feat/x", { id: "running" }),
      onBranch("feat/x", { id: "dup", queueState: queued, createdAt: "2026-01-01T00:00:00.000Z" }),
      onBranch("stop", {
        id: "stopped",
        queueState: queued,
        stopRequested: true,
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      onBranch("ok", { id: "ok", queueState: queued, createdAt: "2026-01-03T00:00:00.000Z" }),
    ];
    assert.deepEqual(
      runnableQueuedJobs(jobs, 3).map((j) => j.id),
      ["ok"],
    );
  });

  it("does not hand a stop-requested job's slot out until its loop exits", () => {
    const jobs = [
      onBranch("busy", { id: "stopping", stopRequested: true }),
      onBranch("q", { id: "q", queueState: queued }),
    ];
    assert.deepEqual(runnableQueuedJobs(jobs, 1, { isRunning: (id) => id === "stopping" }), []);
    assert.deepEqual(
      runnableQueuedJobs(jobs, 1, { isRunning: () => false }).map((j) => j.id),
      ["q"],
    );
  });
});

describe("terminalJobsOwningBranch (#269)", () => {
  const noWt = () => false;
  const pr = "https://github.com/o/r/pull/9";

  it("finds failed, stuck, stopped, changes_remaining and interrupted jobs with an open PR", () => {
    for (const stage of [
      "failed",
      "stuck",
      "stopped",
      "changes_remaining",
      "interrupted",
    ] as const) {
      const jobs = [onBranch("feat/x", { id: "old", stage, dryRun: false, prUrl: pr })];
      assert.deepEqual(
        terminalJobsOwningBranch(jobs, "feat/x", "o/r", noWt).map((j) => j.id),
        ["old"],
        stage,
      );
    }
  });

  it("counts a job worktree on disk even without a PR", () => {
    const jobs = [
      onBranch("feat/x", { id: "old", stage: "failed", dryRun: false, worktreePath: "/wt" }),
    ];
    assert.equal(terminalJobsOwningBranch(jobs, "feat/x", "o/r", (j) => j.id === "old").length, 1);
    assert.equal(terminalJobsOwningBranch(jobs, "feat/x", "o/r", noWt).length, 0);
  });

  it("ignores approved, archived, dry-run, merged, other-branch and other-repo jobs", () => {
    const merged = { status: "merged" as const, checkedAt: "x", source: "github" as const };
    const jobs = [
      onBranch("feat/x", { id: "a", stage: "approved", dryRun: false, prUrl: pr }),
      onBranch("feat/x", { id: "b", stage: "failed", dryRun: false, prUrl: pr, archivedAt: "x" }),
      onBranch("feat/x", { id: "c", stage: "failed", dryRun: true, prUrl: pr }),
      onBranch("feat/x", { id: "d", stage: "failed", dryRun: false, prUrl: pr, ciStatus: merged }),
      onBranch("feat/y", { id: "e", stage: "failed", dryRun: false, prUrl: pr }),
      onBranch("feat/x", {
        id: "f",
        stage: "failed",
        dryRun: false,
        prUrl: pr,
        repoSlug: "o/other",
      }),
    ];
    assert.deepEqual(terminalJobsOwningBranch(jobs, "feat/x", "o/r", noWt), []);
  });

  it("formats an error naming the job, stage, PR, and continue_job", () => {
    const msg = formatTerminalBranchOwnerError(
      onBranch("feat/x", { id: "f3d55c36", stage: "failed", prUrl: pr }),
      "feat/x",
    );
    assert.match(msg, /job f3d55c36 \(stage failed, PR https:\/\/github.com\/o\/r\/pull\/9\)/);
    assert.match(msg, /continue_job on f3d55c36/);
  });
});
