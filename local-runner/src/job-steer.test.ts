import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertSteerAllowed,
  canSteerJob,
  jobIsMerged,
  SteerJobError,
  STEER_PENDING_STAGES,
} from "./job-steer.js";
import type { JobRecord, JobStage } from "./types.js";

function minimalJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j1",
    createdAt: "",
    updatedAt: "",
    input: { repoPath: "/r", branch: "b", promptFile: "/p" },
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
    title: "b",
    tokenUsage: null,
    ciStatus: null,
    lastVerdict: null,
    error: null,
    logPath: "/log",
    steerQueue: [],
    stopRequested: false,
    dryRun: true,
    archivedAt: null,
    ...overrides,
  };
}

describe("assertSteerAllowed", () => {
  for (const stage of ["building", "reviewing", "fixing"] as JobStage[]) {
    it(`allows a running ${stage} job`, () => {
      assert.doesNotThrow(() => assertSteerAllowed(minimalJob({ stage })));
      assert.equal(canSteerJob(minimalJob({ stage })), true);
    });
  }

  for (const stage of STEER_PENDING_STAGES) {
    it(`allows pending steer on ${stage}`, () => {
      assert.doesNotThrow(() => assertSteerAllowed(minimalJob({ stage })));
      assert.equal(canSteerJob(minimalJob({ stage })), true);
    });
  }

  it("rejects an approved job and points at continue_job with a prompt", () => {
    const job = minimalJob({ stage: "approved" });
    assert.equal(canSteerJob(job), false);
    assert.throws(
      () => assertSteerAllowed(job),
      (err: unknown) => {
        assert.ok(err instanceof SteerJobError);
        assert.equal(err.code, "rejected");
        assert.equal(err.stage, "approved");
        assert.match(err.message, /continue_job/);
        assert.match(err.message, /prompt/);
        return true;
      },
    );
  });

  it("rejects an archived job", () => {
    const job = minimalJob({ stage: "failed", archivedAt: "2026-11-25T00:00:00.000Z" });
    assert.equal(canSteerJob(job), false);
    assert.throws(
      () => assertSteerAllowed(job),
      (err: unknown) => {
        assert.ok(err instanceof SteerJobError);
        assert.equal(err.code, "archived");
        assert.match(err.message, /archived/);
        assert.match(err.message, /continue_job/);
        return true;
      },
    );
  });

  it("rejects a merged job even when the stage is failed", () => {
    const job = minimalJob({
      stage: "failed",
      ciStatus: {
        status: "merged",
        checkedAt: "2026-11-25T00:00:00.000Z",
        source: "github",
        mergedAt: "2026-11-25T00:00:00.000Z",
      },
    });
    assert.equal(jobIsMerged(job), true);
    assert.equal(canSteerJob(job), false);
    assert.throws(
      () => assertSteerAllowed(job),
      (err: unknown) => {
        assert.ok(err instanceof SteerJobError);
        assert.equal(err.code, "rejected");
        assert.match(err.message, /merged/);
        assert.match(err.message, /continue_job/);
        return true;
      },
    );
  });
});
