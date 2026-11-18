import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { AgentRunner, type AgentDriverRunResult } from "./agent.js";
import type { RunnerConfig } from "./config.js";
import { JobControl } from "./job-control.js";
import { runJobLoop } from "./job-runner.js";
import { readHeadSha } from "./draft-pr.js";
import { createJob, loadJob } from "./store.js";
import { saveSettings } from "./settings.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["-C", dir, "init", "-b", "main"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "t"]);
  await writeFile(path.join(dir, "README.md"), "# x\n", "utf8");
  await execFileAsync("git", ["-C", dir, "add", "README.md"]);
  await execFileAsync("git", ["-C", dir, "commit", "-m", "init"]);
}

class StageTrackingRunner extends AgentRunner {
  stages: ("build" | "review")[] = [];
  private calls = 0;

  override async run(): Promise<AgentDriverRunResult> {
    this.calls += 1;
    const stage = this.calls === 1 ? "build" : "review";
    this.stages.push(stage);
    this.emit("line", '{"type":"assistant","message":{}}');
    if (stage === "review") {
      return { code: 0, output: "VERDICT: APPROVE\n" };
    }
    return { code: 0, output: "built\n" };
  }

  override kill(): void {
    // no-op
  }
}

function testConfig(dataDir: string): RunnerConfig {
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

describe("runJobLoop with existing open PR (#225)", () => {
  it("runs build then review when prUrl was adopted at submit", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-open-pr-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-open-pr-repo-"));
    await mkdir(repo, { recursive: true });
    await initGitRepo(repo);
    await writeFile(path.join(repo, "prompt.md"), "implement feature\n", "utf8");
    const config = testConfig(dataDir);
    await saveSettings(dataDir, {
      watchdog: { inactivityMs: 300_000, stageCapMs: 300_000, recoveryAttempts: 0 },
    });
    const job = await createJob(
      dataDir,
      {
        repoPath: repo,
        branch: "fix/356-idle-cpu",
        promptFile: path.join(repo, "prompt.md"),
        maxRounds: 1,
        dryRun: true,
      },
      { model: "composer-2.5", dryRun: true, config },
    );
    job.prUrl = "https://github.com/southline-tech/swarmDraft/pull/357";
    job.prNumber = 357;
    job.worktreePath = repo;

    const runner = new StageTrackingRunner();
    await runJobLoop(config, job, JobControl.fromPersisted(job), { agentRunner: runner });

    assert.equal(job.stage, "approved");
    assert.ok(
      runner.stages.includes("build"),
      `expected build stage, got: ${runner.stages.join(",")}`,
    );
    assert.ok(
      runner.stages.includes("review"),
      `expected review stage, got: ${runner.stages.join(",")}`,
    );
    assert.ok(job.stageModelActual?.build, "build stage model should be recorded");
    const headAfter = await readHeadSha(repo);
    assert.equal(job.approveHeadSha, headAfter, "approveHeadSha should match post-build HEAD");
    const persisted = await loadJob(dataDir, job.id);
    assert.equal(persisted?.stage, "approved");
    assert.ok(persisted?.stageModelActual?.build);
  });
});
