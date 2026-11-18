import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./config.js";
import { RunnerEngine } from "./engine.js";
import { claimJobWorker } from "./job-worker-lock.js";
import { notifyRebootAutoContinue } from "./reboot-auto-continue.js";
import { dashboardStageLabel } from "./dashboard-format.js";
import { saveSettings } from "./settings.js";
import { createJob, loadJob, saveJob, updateJobWorker } from "./store.js";
import type { JobRecord } from "./types.js";

const sleepers: ChildProcess[] = [];

function cfg(dataDir: string): RunnerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "t",
    dataDir,
    notifyEmail: null,
    resendApiKey: null,
    defaultModel: "composer-2.5",
    dryRun: true,
    defaultCodeRepoPath: null,
  };
}

function boot(id: string): () => Promise<string> {
  return async () => id;
}

async function waitUntil(
  fn: () => Promise<boolean> | boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout: ${label}`);
}

function sleeper(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  sleepers.push(child);
  return child;
}

function killQuiet(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(child.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

afterEach(() => {
  for (const child of sleepers.splice(0)) killQuiet(child);
});

async function seedJob(
  dataDir: string,
  branch: string,
  patch: (job: JobRecord) => void,
): Promise<JobRecord> {
  const config = cfg(dataDir);
  const job = await createJob(
    dataDir,
    { repoPath: "/tmp/repo", branch, promptFile: "/p.md", dryRun: true, maxRounds: 1 },
    { model: "composer-2.5", dryRun: true, config },
  );
  patch(job);
  await saveJob(dataDir, job);
  return (await loadJob(dataDir, job.id))!;
}

describe("reboot auto-continue", () => {
  it("resumes a worker_exit job whose worktree still exists and shows it was auto-continued", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-reboot-"));
    const wt = await mkdtemp(path.join(os.tmpdir(), "lr-reboot-wt-"));
    const job = await seedJob(dataDir, "feat/reboot-resume", (j) => {
      j.stage = "building";
      j.worktreePath = wt;
      j.reviewRound = 1;
    });
    await updateJobWorker(dataDir, job.id, () => ({
      pid: 2_147_483_640,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    }));

    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    const engine = new RunnerEngine(cfg(dataDir), {
      watchCi: false,
      autoContinueOnBoot: true,
      readBootId: boot("boot-1"),
    });
    try {
      await engine.init();
    } finally {
      console.log = orig;
    }

    const resumed = await loadJob(dataDir, job.id);
    assert.ok(resumed);
    assert.notEqual(resumed.stage, "interrupted");
    assert.equal(resumed.rebootAutoContinue?.bootId, "boot-1");
    assert.ok(resumed.rebootAutoContinue?.at);
    assert.match(lines.join("\n"), new RegExp(`auto-continued job ${job.id} after reboot`));
    assert.match(await readFile(resumed.logPath, "utf8"), /Auto-continued after reboot/);
    assert.match(dashboardStageLabel(resumed), /auto-continued/);

    await waitUntil(async () => !engine.isRunning(job.id), "resume idle");
  });

  it("leaves the job interrupted when the worktree is missing", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-reboot-miss-"));
    const job = await seedJob(dataDir, "feat/reboot-missing", (j) => {
      j.stage = "building";
      j.worktreePath = path.join(dataDir, "gone-worktree");
    });
    await updateJobWorker(dataDir, job.id, () => ({
      pid: 2_147_483_641,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    }));

    const engine = new RunnerEngine(cfg(dataDir), {
      watchCi: false,
      autoContinueOnBoot: true,
      readBootId: boot("boot-1"),
    });
    await engine.init();
    const stayed = await loadJob(dataDir, job.id);
    assert.equal(stayed?.stage, "interrupted");
    assert.match(stayed?.error ?? "", /Interrupted \(worker_exit\)/);
    assert.equal(stayed?.rebootAutoContinue ?? null, null);
    assert.equal(engine.isRunning(job.id), false);
  });

  it("queues the job when the active-job cap is already full", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-reboot-cap-"));
    await saveSettings(dataDir, { maxActiveJobs: 1 });
    const wt = await mkdtemp(path.join(os.tmpdir(), "lr-reboot-cap-wt-"));
    const filler = await seedJob(dataDir, "feat/reboot-filler", (j) => {
      j.stage = "building";
      j.worktreePath = wt;
    });
    const child = sleeper();
    const claim = await claimJobWorker(dataDir, filler.id, { pid: child.pid! });
    assert.equal(claim.ok, true);

    const victim = await seedJob(dataDir, "feat/reboot-queued", (j) => {
      j.stage = "building";
      j.worktreePath = wt;
    });
    await updateJobWorker(dataDir, victim.id, () => ({
      pid: 2_147_483_642,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    }));

    const engine = new RunnerEngine(cfg(dataDir), {
      watchCi: false,
      autoContinueOnBoot: true,
      readBootId: boot("boot-1"),
      workerSupervisor: { pollMs: 50, heartbeatStaleMs: 60 * 60_000 },
    });
    await engine.init();

    const queued = await loadJob(dataDir, victim.id);
    assert.equal(queued?.queueState?.queued, true);
    assert.equal(queued?.rebootAutoContinue?.bootId, "boot-1");
    assert.equal((await loadJob(dataDir, filler.id))?.stage, "building");
    assert.match(dashboardStageLabel(queued!), /queued \(#\d+\) · auto-continued/);

    killQuiet(child);
    await waitUntil(
      async () => !engine.isRunning(victim.id) && !engine.isRunning(filler.id),
      "cap idle",
    );
  });

  it("does not auto-continue a job already auto-continued this boot", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-reboot-once-"));
    const wt = await mkdtemp(path.join(os.tmpdir(), "lr-reboot-once-wt-"));
    const job = await seedJob(dataDir, "feat/reboot-once", (j) => {
      j.stage = "building";
      j.worktreePath = wt;
      j.rebootAutoContinue = { bootId: "boot-1", at: "2026-11-11T20:00:00.000Z" };
    });
    await updateJobWorker(dataDir, job.id, () => ({
      pid: 2_147_483_643,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
    }));

    const engine = new RunnerEngine(cfg(dataDir), {
      watchCi: false,
      autoContinueOnBoot: true,
      readBootId: boot("boot-1"),
    });
    await engine.init();
    const stayed = await loadJob(dataDir, job.id);
    assert.equal(stayed?.stage, "interrupted");
    assert.match(stayed?.error ?? "", /worker_exit/);
    assert.equal(stayed?.rebootAutoContinue?.bootId, "boot-1");
    assert.equal(stayed?.continueHistory?.length ?? 0, 0);
    assert.equal(engine.isRunning(job.id), false);
  });

  it("auto-continues again on a later boot", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-reboot-next-"));
    const wt = await mkdtemp(path.join(os.tmpdir(), "lr-reboot-next-wt-"));
    const job = await seedJob(dataDir, "feat/reboot-next", (j) => {
      j.stage = "interrupted";
      j.error = "Interrupted (worker_exit); use continue_job to resume.";
      j.worktreePath = wt;
      j.rebootAutoContinue = { bootId: "boot-old", at: "2026-11-10T20:00:00.000Z" };
    });
    const engine = new RunnerEngine(cfg(dataDir), {
      watchCi: false,
      autoContinueOnBoot: true,
      readBootId: boot("boot-new"),
    });
    await engine.init();
    const resumed = await loadJob(dataDir, job.id);
    assert.notEqual(resumed?.stage, "interrupted");
    assert.equal(resumed?.rebootAutoContinue?.bootId, "boot-new");
    await waitUntil(async () => !engine.isRunning(job.id), "next boot idle");
  });

  it("stays interrupted when autoContinueOnBoot is off", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-reboot-off-"));
    await saveSettings(dataDir, { autoContinueOnBoot: false });
    const wt = await mkdtemp(path.join(os.tmpdir(), "lr-reboot-off-wt-"));
    const job = await seedJob(dataDir, "feat/reboot-off", (j) => {
      j.stage = "interrupted";
      j.error = "Interrupted (worker_exit); use continue_job to resume.";
      j.worktreePath = wt;
    });
    const engine = new RunnerEngine(cfg(dataDir), {
      watchCi: false,
      autoContinueOnBoot: true,
      readBootId: boot("boot-1"),
    });
    await engine.init();
    const stayed = await loadJob(dataDir, job.id);
    assert.equal(stayed?.stage, "interrupted");
    assert.equal(stayed?.rebootAutoContinue ?? null, null);
  });

  it("does not resume a watchdog interrupt", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-reboot-wd-"));
    const wt = await mkdir(path.join(dataDir, "wt"), { recursive: true }).then(() =>
      path.join(dataDir, "wt"),
    );
    const job = await seedJob(dataDir, "feat/reboot-wd", (j) => {
      j.stage = "interrupted";
      j.error = "Interrupted (worker_watchdog: fixing); use continue_job to resume.";
      j.worktreePath = wt;
    });
    const engine = new RunnerEngine(cfg(dataDir), {
      watchCi: false,
      autoContinueOnBoot: true,
      readBootId: boot("boot-1"),
    });
    await engine.init();
    const stayed = await loadJob(dataDir, job.id);
    assert.equal(stayed?.stage, "interrupted");
    assert.equal(stayed?.rebootAutoContinue ?? null, null);
  });

  it("emails when notify is configured", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-reboot-mail-"));
    await saveSettings(dataDir, {
      notify: { enabled: true, recipient: "ops@example.com" },
    });
    const config = cfg(dataDir);
    config.resendApiKey = "re_test";
    const calls: string[] = [];
    const job = await seedJob(dataDir, "feat/reboot-mail", (j) => {
      j.stage = "building";
    });
    await notifyRebootAutoContinue(
      config,
      (await loadJob(dataDir, job.id))!,
      true,
      async (url, init) => {
        calls.push(String(url));
        assert.match(String(init?.body), /Auto-continued after reboot \(queued\)/);
        return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
      },
    );
    assert.deepEqual(calls, ["https://api.resend.com/emails"]);
  });
});
