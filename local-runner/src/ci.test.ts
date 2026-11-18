import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildGhPrViewArgs,
  CI_GIVE_UP_AFTER_MS,
  CI_SETTLED_POLL_MS,
  CI_STALE_AFTER_MS,
  CI_STALE_POLL_MS,
  fetchPrCiStatus,
  firstStderrLine,
  GH_PR_VIEW_JSON,
  isCiFinal,
  isCiPollUrgent,
  MERGED_HIDE_AFTER_MS,
  repoSlugFromPrUrl,
  resolveDisplayStatus,
  rollupCheckStatuses,
  rollupFromGithubStatusCheckRollup,
  shouldHideMergedJob,
  shouldPollCi,
} from "./ci.js";
import type { CiRollupStatus, JobRecord } from "./types.js";

describe("rollupCheckStatuses", () => {
  it("maps pending when any check is in progress", () => {
    const r = rollupCheckStatuses([
      { name: "build-test", status: "IN_PROGRESS" },
      { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
    ]);
    assert.equal(r.status, "pending");
  });

  it("maps failure when any check failed", () => {
    const r = rollupCheckStatuses([
      { name: "build-test", status: "COMPLETED", conclusion: "FAILURE" },
    ]);
    assert.equal(r.status, "failure");
  });

  it("maps success when all completed successfully", () => {
    const r = rollupCheckStatuses([
      { name: "a", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "b", status: "COMPLETED", conclusion: "SUCCESS" },
    ]);
    assert.equal(r.status, "success");
  });
});

describe("rollupFromGithubStatusCheckRollup", () => {
  it("accepts GitHub statusCheckRollup rows", () => {
    const r = rollupFromGithubStatusCheckRollup([
      {
        name: "build-test",
        status: "COMPLETED",
        conclusion: "FAILURE",
      },
    ]);
    assert.equal(r.status, "failure");
  });
});

describe("shouldPollCi", () => {
  const base: JobRecord = {
    id: "j",
    createdAt: "",
    updatedAt: "",
    input: { repoPath: "/r", branch: "b", promptFile: "/p" },
    stage: "building",
    reviewRound: 0,
    maxRounds: 2,
    model: "m",
    driverId: "cursor-agent",
    worktreePath: "/wt",
    repoSlug: "o/r",
    prUrl: "https://github.com/o/r/pull/1",
    prNumber: 1,
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
  };

  it("does not poll failed jobs without a PR", () => {
    assert.equal(shouldPollCi({ ...base, stage: "failed", prUrl: null, prNumber: null }), false);
  });

  it("stops polling when CI is final during active build stages", () => {
    assert.equal(
      shouldPollCi({
        ...base,
        stage: "building",
        ciStatus: {
          status: "success",
          checkedAt: "",
          source: "github",
        },
      }),
      false,
    );
  });

  it("does not poll when ciStatus reports merged", () => {
    assert.equal(
      shouldPollCi({
        ...base,
        stage: "approved",
        ciStatus: {
          status: "merged",
          mergedAt: "2026-11-05T12:00:00.000Z",
          checkedAt: "",
          source: "github",
        },
      }),
      false,
    );
  });

  it("polls approved jobs while CI is pending", () => {
    assert.equal(
      shouldPollCi({
        ...base,
        stage: "approved",
        ciStatus: { status: "pending", checkedAt: "", source: "github" },
      }),
      true,
    );
  });

  it("stops polling once PR is merged", () => {
    assert.equal(
      shouldPollCi({
        ...base,
        stage: "approved",
        ciStatus: {
          status: "merged",
          mergedAt: "2026-01-01T12:00:00Z",
          checkedAt: "",
          source: "github",
        },
      }),
      false,
    );
  });

  it("keeps polling approved jobs with green CI until merge is known", () => {
    assert.equal(
      shouldPollCi({
        ...base,
        stage: "approved",
        ciStatus: {
          status: "success",
          checkedAt: "",
          source: "github",
        },
      }),
      true,
    );
  });
});

describe("shouldPollCi REST budget (#236)", () => {
  const now = Date.parse("2026-11-18T05:00:00.000Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const base: JobRecord = {
    id: "j",
    createdAt: iso(60_000),
    updatedAt: iso(60_000),
    input: { repoPath: "/r", branch: "b", promptFile: "/p" },
    stage: "approved",
    reviewRound: 0,
    maxRounds: 2,
    model: "m",
    driverId: "cursor-agent",
    worktreePath: "/wt",
    repoSlug: "o/r",
    prUrl: "https://github.com/o/r/pull/1",
    prNumber: 1,
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
  };
  const ci = (status: CiRollupStatus, checkedMsAgo: number): JobRecord["ciStatus"] => ({
    status,
    checkedAt: iso(checkedMsAgo),
    source: "github",
  });

  it("never polls a closed (unmerged) PR", () => {
    for (const stage of [
      "approved",
      "changes_remaining",
      "failed",
      "stopped",
      "reviewing",
    ] as const) {
      assert.equal(
        shouldPollCi({ ...base, stage, ciStatus: ci("closed", 10 * 60 * 60_000) }, now),
        false,
      );
    }
  });

  it("never polls archived jobs", () => {
    assert.equal(
      shouldPollCi({ ...base, archivedAt: iso(0), ciStatus: ci("pending", 0) }, now),
      false,
    );
  });

  it("polls merge-watch jobs every tick while CI is pending", () => {
    assert.equal(shouldPollCi({ ...base, ciStatus: ci("pending", 30_000) }, now), true);
  });

  it("polls settled merge-watch jobs only every CI_SETTLED_POLL_MS", () => {
    assert.equal(shouldPollCi({ ...base, ciStatus: ci("success", 60_000) }, now), false);
    assert.equal(shouldPollCi({ ...base, ciStatus: ci("success", CI_SETTLED_POLL_MS) }, now), true);
    assert.equal(
      shouldPollCi({ ...base, stage: "failed", ciStatus: ci("failure", 5 * 60_000) }, now),
      false,
    );
  });

  it("polls stale settled jobs hourly and gives up after a week", () => {
    const stale = { ...base, updatedAt: iso(CI_STALE_AFTER_MS + 60_000) };
    assert.equal(
      shouldPollCi({ ...stale, ciStatus: ci("success", CI_SETTLED_POLL_MS) }, now),
      false,
    );
    assert.equal(shouldPollCi({ ...stale, ciStatus: ci("success", CI_STALE_POLL_MS) }, now), true);
    const old = { ...base, updatedAt: iso(CI_GIVE_UP_AFTER_MS + 60_000) };
    assert.equal(
      shouldPollCi({ ...old, ciStatus: ci("success", CI_STALE_POLL_MS * 10) }, now),
      false,
    );
  });

  it("marks only pending CI and build stages as urgent", () => {
    assert.equal(isCiPollUrgent({ ...base, ciStatus: ci("pending", 0) }), true);
    assert.equal(isCiPollUrgent({ ...base, stage: "building" }), true);
    assert.equal(isCiPollUrgent({ ...base, ciStatus: ci("success", 0) }), false);
  });
});

describe("isCiFinal", () => {
  it("treats success and failure as final", () => {
    assert.equal(isCiFinal("success"), true);
    assert.equal(isCiFinal("failure"), true);
    assert.equal(isCiFinal("pending"), false);
    assert.equal(isCiFinal("merged"), false);
  });
});

describe("resolveDisplayStatus", () => {
  it("maps merged PR state", () => {
    const r = resolveDisplayStatus(
      { state: "MERGED", mergedAt: "2026-01-01T12:00:00Z" },
      "success",
    );
    assert.equal(r.status, "merged");
    assert.equal(r.mergedAt, "2026-01-01T12:00:00Z");
  });

  it("maps mergeable CONFLICTING to merge conflict", () => {
    const r = resolveDisplayStatus({ mergeable: "CONFLICTING" }, "success");
    assert.equal(r.status, "merge_conflict");
  });

  it("maps closed PR state", () => {
    assert.equal(resolveDisplayStatus({ state: "CLOSED" }, "success").status, "closed");
  });

  it("passes through CI rollup when PR is open and clean", () => {
    assert.equal(
      resolveDisplayStatus({ state: "OPEN", mergeable: "MERGEABLE" }, "pending").status,
      "pending",
    );
  });
});

describe("shouldHideMergedJob", () => {
  const mergedJob: JobRecord = {
    id: "j",
    createdAt: "",
    updatedAt: "",
    input: { repoPath: "/r", branch: "b", promptFile: "/p" },
    stage: "approved",
    reviewRound: 0,
    maxRounds: 2,
    model: "m",
    driverId: "cursor-agent",
    worktreePath: null,
    repoSlug: "o/r",
    prUrl: "https://github.com/o/r/pull/1",
    prNumber: 1,
    prIsDraft: null,
    approveHeadSha: null,
    readyPromotedAt: null,
    linearIssue: null,
    ticketUrl: null,
    title: "b",
    tokenUsage: null,
    ciStatus: {
      status: "merged",
      mergedAt: "2026-01-01T12:00:00Z",
      checkedAt: "",
      source: "github",
    },
    lastVerdict: null,
    error: null,
    logPath: "/log",
    steerQueue: [],
    stopRequested: false,
    dryRun: true,
    archivedAt: null,
  };

  it("keeps merged jobs visible before hide window", () => {
    const mergedAt = Date.parse("2026-01-01T12:00:00Z");
    assert.equal(shouldHideMergedJob(mergedJob, mergedAt + MERGED_HIDE_AFTER_MS - 1), false);
  });

  it("hides merged jobs after hide window", () => {
    const mergedAt = Date.parse("2026-01-01T12:00:00Z");
    assert.equal(shouldHideMergedJob(mergedJob, mergedAt + MERGED_HIDE_AFTER_MS), true);
  });
});

describe("buildGhPrViewArgs", () => {
  it("never requests mergeableState from gh", () => {
    assert.doesNotMatch(GH_PR_VIEW_JSON, /mergeableState/);
    const args = buildGhPrViewArgs("radiancelux/prgenie", { prNumber: 105 });
    assert.ok(args);
    assert.deepEqual(args, [
      "pr",
      "view",
      "105",
      "--json",
      GH_PR_VIEW_JSON,
      "--repo",
      "radiancelux/prgenie",
    ]);
  });

  it("derives repo slug from pr URL when building lookup target", () => {
    assert.equal(
      repoSlugFromPrUrl("https://github.com/radiancelux/prgenie/pull/106"),
      "radiancelux/prgenie",
    );
  });
});

describe("fetchPrCiStatus", () => {
  it("returns merged status from REST pull + check-runs", async () => {
    const gh = async (_cwd: string, args: string[]) => {
      const path = args.join(" ");
      if (path.includes("/pulls/1") && !path.includes("check-runs")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            state: "closed",
            merged_at: "2026-01-01T12:00:00Z",
            html_url: "https://github.com/o/r/pull/1",
            head: { sha: "abc" },
          }),
          stderr: "",
        };
      }
      if (path.includes("check-runs")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            check_runs: [{ name: "ci", status: "completed", conclusion: "success" }],
          }),
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: "unexpected " + path };
    };
    const r = await fetchPrCiStatus(null, { prNumber: 1, repoSlug: "o/r" }, { gh });
    assert.equal(r.status, "merged");
    assert.equal(r.summary, "merged");
  });

  it("returns unknown with reason when REST pull fails", async () => {
    const r = await fetchPrCiStatus(
      null,
      { prNumber: 2, repoSlug: "o/r" },
      {
        gh: async () => ({
          code: 1,
          stdout: "",
          stderr: "pull request not found",
        }),
      },
    );
    assert.equal(r.status, "unknown");
    assert.equal(r.summary, "CI unknown");
    assert.match(r.reason ?? "", /REST pull lookup failed/);
  });

  it("maps pending and failing CI from REST check-runs", async () => {
    const ghPending = async (_cwd: string, args: string[]) => {
      const path = args.join(" ");
      if (path.includes("/pulls/3")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            state: "open",
            mergeable: true,
            html_url: "https://github.com/o/r/pull/3",
            head: { sha: "sha3" },
          }),
          stderr: "",
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          check_runs: [{ name: "build", status: "in_progress" }],
        }),
        stderr: "",
      };
    };
    const pending = await fetchPrCiStatus(
      null,
      { prNumber: 3, repoSlug: "o/r" },
      { gh: ghPending },
    );
    assert.equal(pending.status, "pending");

    const ghFail = async (_cwd: string, args: string[]) => {
      const path = args.join(" ");
      if (path.includes("/pulls/4")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            state: "open",
            mergeable: true,
            head: { sha: "sha4" },
          }),
          stderr: "",
        };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          check_runs: [{ name: "build", status: "completed", conclusion: "failure" }],
        }),
        stderr: "",
      };
    };
    const failed = await fetchPrCiStatus(null, { prNumber: 4, repoSlug: "o/r" }, { gh: ghFail });
    assert.equal(failed.status, "failure");
  });
});

describe("firstStderrLine", () => {
  it("returns the first non-empty stderr line", () => {
    assert.equal(firstStderrLine("\n\nboom\nrest"), "boom");
  });
});
