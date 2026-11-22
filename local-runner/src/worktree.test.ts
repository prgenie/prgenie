import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { GhResult } from "./github.js";
import {
  assertSafeToResetBranchAtBase,
  ensureArenaCandidateWorktree,
  ensureContinueWorktree,
  ensureWorktree,
  parseWorktreePathForBranch,
} from "./worktree.js";
import { arenaCandidateBranch, arenaCandidateWorktreeDir, cursorWorktreeDir } from "./paths.js";
import { loadJob, saveJob } from "./store.js";
import type { JobRecord, JobStage } from "./types.js";

function ok(stdout = "", stderr = ""): GhResult {
  return { code: 0, stdout, stderr };
}

function fail(stderr: string): GhResult {
  return { code: 1, stdout: "", stderr };
}

describe("ensureWorktree", () => {
  const repoPath = "/repo/proj";
  const jobId = "job-abc";
  const branch = "feat/new";
  const baseSha = "a".repeat(40);
  const wt = cursorWorktreeDir("proj", jobId);

  it("calls fetch origin before worktree add for a new branch", async () => {
    const calls: string[][] = [];
    const gitImpl = async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "list") {
        return ok("worktree /repo/proj\nbranch refs/heads/main\n");
      }
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-parse" && args[1] === "--verify") return ok(baseSha);
      if (args[0] === "show-ref") return fail("");
      if (args[0] === "worktree" && args[1] === "add") return ok();
      return ok();
    };

    const result = await ensureWorktree(repoPath, jobId, branch, undefined, { gitImpl });
    assert.equal(result.path, wt);
    assert.equal(result.baseRef, "origin/main");
    assert.equal(result.baseSha, baseSha);
    const fetchIdx = calls.findIndex((a) => a[0] === "fetch");
    const addIdx = calls.findIndex((a) => a[0] === "worktree" && a[1] === "add");
    assert.ok(fetchIdx >= 0);
    assert.ok(addIdx >= 0);
    assert.ok(fetchIdx < addIdx, "fetch must run before worktree add");
  });

  it("treats fetch failure as non-fatal and still adds the worktree", async () => {
    let addCalled = false;
    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return ok("worktree /repo/proj\n");
      }
      if (args[0] === "fetch") return fail("network down");
      if (args[0] === "rev-parse" && args[1] === "--verify") return ok(baseSha);
      if (args[0] === "show-ref") return fail("");
      if (args[0] === "worktree" && args[1] === "add") {
        addCalled = true;
        return ok();
      }
      return ok();
    };

    const result = await ensureWorktree(repoPath, jobId, branch, undefined, { gitImpl });
    assert.equal(addCalled, true);
    assert.equal(result.baseSha, baseSha);
  });

  it("records resolved base ref and SHA on success", async () => {
    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return ok("worktree /repo/proj\n");
      }
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-parse" && args[2] === "origin/main") return ok(baseSha);
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/main") {
        return ok(baseSha);
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") return fail("bad ref");
      if (args[0] === "show-ref") return fail("");
      if (args[0] === "worktree" && args[1] === "add") return ok();
      return ok();
    };

    const result = await ensureWorktree(repoPath, jobId, branch, undefined, { gitImpl });
    assert.equal(result.baseRef, "origin/main");
    assert.equal(result.baseSha, baseSha);
  });

  it("bases a new worktree on origin/branch when the remote branch already exists", async () => {
    const remoteSha = "f".repeat(40);
    const calls: string[][] = [];
    const gitImpl = async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "list") {
        return ok("worktree /repo/proj\n");
      }
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === `origin/${branch}`) {
        return ok(remoteSha);
      }
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/main") {
        return ok(baseSha);
      }
      if (args[0] === "rev-parse" && args[2] === "origin/main") return ok(baseSha);
      if (args[0] === "worktree" && args[1] === "add") {
        assert.equal(args[5], `origin/${branch}`);
        return ok();
      }
      if (args[0] === "show-ref") return fail("");
      return ok();
    };

    const result = await ensureWorktree(repoPath, jobId, branch, undefined, { gitImpl });
    assert.equal(result.path, wt);
    assert.equal(result.baseRef, "origin/main");
    assert.equal(result.baseSha, baseSha);
    const add = calls.find((a) => a[0] === "worktree" && a[1] === "add");
    assert.ok(add);
    assert.equal(add![5], `origin/${branch}`);
  });

  it("refuses -B when the local branch has commits beyond the base", async () => {
    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return ok("worktree /repo/proj\n");
      }
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === `origin/${branch}`) {
        return fail("");
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") return ok(baseSha);
      if (args[0] === "show-ref") return ok();
      if (args[0] === "rev-list" && args[1] === "--count") return ok("2\n");
      return ok();
    };

    await assert.rejects(
      () => ensureWorktree(repoPath, jobId, branch, undefined, { gitImpl }),
      /refusing to reset local branch "feat\/new".*fresh branch name/i,
    );
  });
});

describe("ensureWorktree follow-up on a finished job's branch", () => {
  const repoPath = "/repo/proj";
  const jobId = "job-followup";
  const branch = "fix/356-idle-cpu";
  const holder = cursorWorktreeDir("proj", "job-old");
  const pushed = "c".repeat(40);
  const followUpWt = cursorWorktreeDir("proj", jobId);

  function finishedJob(
    dataDir: string,
    stage: JobStage,
    worktreePath: string,
    extra: Partial<JobRecord> = {},
  ): JobRecord {
    return {
      id: "job-old",
      createdAt: "2026-11-11T02:00:00.000Z",
      updatedAt: "2026-11-11T02:17:00.000Z",
      input: { repoPath, branch, promptFile: "/p" },
      stage,
      reviewRound: 1,
      maxRounds: 2,
      model: "m",
      driverId: "cursor-agent",
      worktreePath,
      repoSlug: "proj",
      prUrl: "https://github.com/o/r/pull/357",
      prNumber: 357,
      prIsDraft: false,
      approveHeadSha: null,
      readyPromotedAt: null,
      linearIssue: null,
      ticketUrl: null,
      title: "idle cpu",
      tokenUsage: null,
      ciStatus: null,
      lastVerdict: stage === "approved" ? "APPROVE" : null,
      error: null,
      logPath: path.join(dataDir, "job-old.log"),
      steerQueue: [],
      stopRequested: stage === "stopped",
      dryRun: false,
      archivedAt: null,
      ...extra,
    };
  }

  function scriptedGit(behavior: {
    holder?: string;
    status?: string;
    head?: string;
    remote?: string | null;
    fetchBranchFails?: boolean;
  }) {
    const calls: string[][] = [];
    const at = behavior.holder ?? holder;
    const head = behavior.head ?? pushed;
    const remote = behavior.remote === undefined ? head : behavior.remote;
    const gitImpl = async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(`worktree ${at}\nHEAD ${head}\nbranch refs/heads/${branch}\n`);
      }
      if (args[0] === "fetch" && args[2] === branch) {
        return behavior.fetchBranchFails ? fail("network down") : ok();
      }
      if (args[0] === "fetch") return ok();
      if (args[0] === "status" && args[1] === "--porcelain") return ok(behavior.status ?? "");
      if (args[0] === "rev-parse" && args[1] === "HEAD") return ok(`${head}\n`);
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === `origin/${branch}`) {
        if (remote == null) return fail("missing");
        return ok(`${remote}\n`);
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") return ok(`${"a".repeat(40)}\n`);
      if (args[0] === "merge-base") return head !== remote ? ok() : fail("same");
      if (args[0] === "worktree" && args[1] === "remove") return ok();
      if (args[0] === "worktree" && args[1] === "add") return ok();
      if (args[0] === "show-ref") return fail("");
      return ok();
    };
    return { calls, gitImpl };
  }

  async function seed(stage: JobStage, worktreePath = holder, extra: Partial<JobRecord> = {}) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-follow-"));
    await saveJob(dataDir, finishedJob(dataDir, stage, worktreePath, extra));
    return dataDir;
  }

  function removed(calls: string[][]): boolean {
    return calls.some((args) => args[0] === "worktree" && args[1] === "remove");
  }

  for (const stage of ["approved", "stopped", "failed", "stuck"] as const) {
    it(`releases a clean pushed ${stage} worktree so the follow-up can check out the branch`, async () => {
      const dataDir = await seed(stage);
      const { calls, gitImpl } = scriptedGit({});
      const result = await ensureWorktree(repoPath, jobId, branch, undefined, { gitImpl, dataDir });
      assert.equal(result.path, followUpWt);
      const removeIdx = calls.findIndex((args) => args[0] === "worktree" && args[1] === "remove");
      const addIdx = calls.findIndex((args) => args[0] === "worktree" && args[1] === "add");
      assert.ok(removeIdx >= 0 && addIdx > removeIdx);
      assert.deepEqual(calls[removeIdx], ["worktree", "remove", holder]);
      const saved = await loadJob(dataDir, "job-old");
      assert.equal(saved?.worktreePath, null);
      const log = await readFile(path.join(dataDir, "job-old.log"), "utf8");
      assert.match(log, new RegExp(`released ${holder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(log, new RegExp(jobId));
    });
  }

  it("names the holding job and path when that worktree is dirty", async () => {
    const dataDir = await seed("approved");
    const { calls, gitImpl } = scriptedGit({ status: " M src/file.txt\n" });
    await assert.rejects(
      () => ensureWorktree(repoPath, jobId, branch, undefined, { gitImpl, dataDir }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /uncommitted changes/);
        assert.match(err.message, /job-old/);
        assert.ok(err.message.includes(holder));
        return true;
      },
    );
    assert.equal(removed(calls), false);
    assert.equal((await loadJob(dataDir, "job-old"))?.worktreePath, holder);
  });

  it("names the holding job and path when that worktree is ahead of origin", async () => {
    const dataDir = await seed("approved");
    const { calls, gitImpl } = scriptedGit({ head: "d".repeat(40), remote: pushed });
    await assert.rejects(
      () => ensureWorktree(repoPath, jobId, branch, undefined, { gitImpl, dataDir }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /ahead of origin\/fix\/356-idle-cpu/);
        assert.match(err.message, /job-old/);
        assert.ok(err.message.includes(holder));
        return true;
      },
    );
    assert.equal(removed(calls), false);
    assert.equal((await loadJob(dataDir, "job-old"))?.worktreePath, holder);
  });

  it("refuses to release a worktree whose finished job is still running", async () => {
    const dataDir = await seed("approved", holder, {
      worker: { pid: 4242, hostname: "test", startedAt: "2026-11-11T02:17:00.000Z", token: "t" },
    });
    const { calls, gitImpl } = scriptedGit({});
    await assert.rejects(
      () => ensureWorktree(repoPath, jobId, branch, undefined, { gitImpl, dataDir }),
      /already checked out/,
    );
    assert.equal(removed(calls), false);
    assert.equal((await loadJob(dataDir, "job-old"))?.worktreePath, holder);
  });

  it("refuses when an active job holds the branch", async () => {
    const dataDir = await seed("building");
    const { calls, gitImpl } = scriptedGit({});
    await assert.rejects(
      () => ensureWorktree(repoPath, jobId, branch, undefined, { gitImpl, dataDir }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /already checked out/);
        assert.match(err.message, /job-old/);
        assert.ok(err.message.includes(holder));
        return true;
      },
    );
    assert.equal(removed(calls), false);
    assert.equal((await loadJob(dataDir, "job-old"))?.worktreePath, holder);
  });

  it("does not remove the repo checkout when a finished job records it as the worktree", async () => {
    const dataDir = await seed("approved", repoPath);
    const { calls, gitImpl } = scriptedGit({ holder: repoPath });
    await assert.rejects(
      () => ensureWorktree(repoPath, jobId, branch, undefined, { gitImpl, dataDir }),
      /already checked out/,
    );
    assert.equal(removed(calls), false);
    assert.equal((await loadJob(dataDir, "job-old"))?.worktreePath, repoPath);
  });

  it("does not release a finished worktree when origin cannot be fetched", async () => {
    const dataDir = await seed("failed");
    const { calls, gitImpl } = scriptedGit({ fetchBranchFails: true });
    await assert.rejects(
      () => ensureWorktree(repoPath, jobId, branch, undefined, { gitImpl, dataDir }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /could not verify origin\/fix\/356-idle-cpu/);
        assert.match(err.message, /job-old/);
        assert.ok(err.message.includes(holder));
        return true;
      },
    );
    assert.equal(removed(calls), false);
  });
});

describe("assertSafeToResetBranchAtBase", () => {
  it("allows a new branch name", async () => {
    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "show-ref") return fail("");
      return ok();
    };
    await assertSafeToResetBranchAtBase("/r", "feat/x", "origin/main", gitImpl);
  });
});

describe("ensureContinueWorktree", () => {
  const repoPath = "/repo/proj";
  const jobId = "job-stuck";
  const branch = "feat/resume";
  const existingWt = cursorWorktreeDir("proj", jobId);

  it("reuses the job's own worktree when the branch is still checked out there", async () => {
    const existingWt = path.join(os.tmpdir(), `lr-wt-${jobId}`);
    await mkdir(existingWt, { recursive: true });
    await access(existingWt);
    const porcelain = `worktree ${existingWt}\nHEAD ${"b".repeat(40)}\nbranch refs/heads/${branch}\n`;
    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return ok(porcelain);
      return ok();
    };

    const result = await ensureContinueWorktree(repoPath, jobId, branch, existingWt, undefined, {
      gitImpl,
    });
    assert.equal(result.reused, true);
    assert.equal(result.path, existingWt);
  });

  it("names another worktree when a different job holds the branch", async () => {
    const otherWt = path.join(os.tmpdir(), "other-job-wt");
    const porcelain = `worktree ${otherWt}\nbranch refs/heads/${branch}\n`;
    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return ok(porcelain);
      return ok();
    };

    await assert.rejects(
      () =>
        ensureContinueWorktree(repoPath, jobId, branch, existingWt, undefined, {
          gitImpl,
        }),
      new RegExp(`already checked out at ${otherWt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    await assert.rejects(
      () =>
        ensureContinueWorktree(repoPath, jobId, branch, existingWt, undefined, {
          gitImpl,
        }),
      /git worktree remove/,
    );
  });
});

describe("ensureArenaCandidateWorktree (#250)", () => {
  it("uses isolated path and branch per candidate index", async () => {
    const repoPath = "/repo/proj";
    const jobId = "job-arena";
    const branch = "feat/arena";
    const wt0 = arenaCandidateWorktreeDir("proj", jobId, 0);
    const gitImpl = async (_cwd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return ok("worktree /repo/proj\n");
      }
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-parse" && args[1] === "--verify") return ok("a".repeat(40));
      if (args[0] === "show-ref") return fail("");
      if (args[0] === "worktree" && args[1] === "add") {
        assert.equal(args[3], arenaCandidateBranch(branch, 0));
        assert.equal(args[4], wt0);
        return ok();
      }
      return ok();
    };
    const result = await ensureArenaCandidateWorktree(repoPath, jobId, 0, branch, undefined, {
      gitImpl,
    });
    assert.equal(result.path, wt0);
  });
});

describe("parseWorktreePathForBranch", () => {
  it("finds the checkout path for a branch", () => {
    const p = parseWorktreePathForBranch(
      "worktree /a/wt\nbranch refs/heads/feat/foo\n\nworktree /b/wt\nbranch refs/heads/main\n",
      "feat/foo",
    );
    assert.equal(p, "/a/wt");
  });
});
