import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import type { RunnerEngine } from "./engine.js";
import { CI_REST_FLOOR, CiWatcher } from "./ci-watcher.js";
import { createJob, loadJob, saveJob } from "./store.js";

function testConfig(dataDir: string): RunnerConfig {
  return {
    host: "127.0.0.1",
    port: 9473,
    token: "t",
    dataDir,
    notifyEmail: null,
    resendApiKey: null,
    defaultModel: "m",
    dryRun: true,
    defaultCodeRepoPath: null,
  };
}

const fakeEngine = { emit: () => true } as unknown as RunnerEngine;

describe("CiWatcher", () => {
  it("a refresh that loaded the job mid-build never rolls stage back", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-ciw-"));
    const config = testConfig(dataDir);
    const job = await createJob(
      dataDir,
      { repoPath: "/tmp/repo", branch: "feat/x", promptFile: "/p", dryRun: true },
      { model: "m", dryRun: true, config },
    );
    job.prUrl = "https://github.com/example/example/pull/1";
    job.prNumber = 1;
    await saveJob(dataDir, job);

    const watcher = new CiWatcher(config, fakeEngine, {
      fetchPrCiStatus: async () => {
        const live = await loadJob(dataDir, job.id);
        live!.stage = "approved";
        live!.lastVerdict = "APPROVE";
        await saveJob(dataDir, live!);
        return { status: "success", summary: "ok", source: "github" };
      },
      syncDraftReadyForJob: async (j) => ({ job: j, changed: false }),
      cleanupWorktree: async () => {},
    });
    await watcher.refreshJobById(job.id);

    const after = await loadJob(dataDir, job.id);
    assert.equal(after?.stage, "approved");
    assert.equal(after?.lastVerdict, "APPROVE");
    assert.equal(after?.ciStatus?.status, "success");
  });

  it("draft sync patches only the fields it changed", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-ciw-draft-"));
    const config = testConfig(dataDir);
    const job = await createJob(
      dataDir,
      { repoPath: "/tmp/repo", branch: "feat/x", promptFile: "/p", dryRun: true },
      { model: "m", dryRun: true, config },
    );
    job.prUrl = "https://github.com/example/example/pull/1";
    job.prNumber = 1;
    await saveJob(dataDir, job);

    const watcher = new CiWatcher(config, fakeEngine, {
      fetchPrCiStatus: async () => {
        const live = await loadJob(dataDir, job.id);
        live!.stage = "reviewing";
        await saveJob(dataDir, live!);
        return { status: "pending", source: "github" };
      },
      syncDraftReadyForJob: async (j) => {
        j.prIsDraft = true;
        j.error = "pr ready: nope";
        return { job: j, changed: true, errorNote: "pr ready: nope" };
      },
      cleanupWorktree: async () => {},
    });
    await watcher.refreshJobById(job.id);

    const after = await loadJob(dataDir, job.id);
    assert.equal(after?.stage, "reviewing");
    assert.equal(after?.prIsDraft, true);
    assert.equal(after?.error, "pr ready: nope");
  });

  it("skips non-urgent jobs when REST core quota is below the floor (#236)", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-ciw-quota-"));
    const config = testConfig(dataDir);
    const mk = async (branch: string) => {
      const j = await createJob(
        dataDir,
        { repoPath: "/tmp/repo", branch, promptFile: "/p", dryRun: true },
        { model: "m", dryRun: true, config },
      );
      j.prUrl = "https://github.com/example/example/pull/1";
      j.prNumber = 1;
      return j;
    };
    const settled = await mk("feat/settled");
    settled.stage = "approved";
    settled.ciStatus = { status: "success", checkedAt: "", source: "github" };
    await saveJob(dataDir, settled);
    const closed = await mk("feat/closed");
    closed.stage = "approved";
    closed.ciStatus = { status: "closed", checkedAt: "", source: "github" };
    await saveJob(dataDir, closed);
    const active = await mk("feat/active");
    active.stage = "reviewing";
    await saveJob(dataDir, active);

    const fetched: string[] = [];
    let remaining = CI_REST_FLOOR - 1;
    const watcher = new CiWatcher(config, fakeEngine, {
      fetchPrCiStatus: async (_cwd, ref) => {
        fetched.push(ref.branch ?? "");
        return { status: "pending", summary: "p", source: "github" };
      },
      syncDraftReadyForJob: async (j) => ({ job: j, changed: false }),
      cleanupWorktree: async () => {},
      fetchCoreRemaining: async () => remaining,
    });

    await watcher.tick();
    assert.deepEqual(fetched, ["feat/active"]);
    assert.equal(watcher.lastTick?.skippedLowQuota, 1);
    assert.equal(watcher.lastTick?.polled, 1);

    fetched.length = 0;
    remaining = 4000;
    await watcher.tick();
    assert.deepEqual(fetched.sort(), ["feat/active", "feat/settled"]);
  });
});
