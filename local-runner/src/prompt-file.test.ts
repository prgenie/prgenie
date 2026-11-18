import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { AgentRunner } from "./agent.js";
import type { RunnerConfig } from "./config.js";
import { RunnerEngine } from "./engine.js";
import { JobControl } from "./job-control.js";
import { runJobLoop } from "./job-runner.js";
import { handleMcpJsonRpc } from "./mcp-handlers.js";
import { cursorWorktreeDir, repoSlugFromPath } from "./paths.js";
import { assertSubmitPromptFiles, readStagePromptFile } from "./prompt-file.js";
import { handleStartJobRequest } from "./server.js";
import { saveSettings } from "./settings.js";
import { createJob, loadJob } from "./store.js";
import type { JobRecord } from "./types.js";
import { ValidationError } from "./validation-error.js";
import { ensureWorktree, removeWorktree } from "./worktree.js";

const execFileAsync = promisify(execFile);

const IMPLEMENT = "IMPLEMENT_224\n";
const REVIEW_V1 = "REVIEW_V1\n";
const REVIEW_V2 = "REVIEW_V2\n";
const FIX = "FIX_224\n";
const REL_IMPLEMENT = "prompts/issue-224-implement.md";
const REL_REVIEW = "prompts/issue-224-review.md";
const REL_FIX = "prompts/issue-224-fix.md";

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

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

async function gitInit(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@test"]);
  await git(dir, ["config", "user.name", "t"]);
  await git(dir, ["commit", "--allow-empty", "-m", "init"]);
}

class CaptureRunner extends AgentRunner {
  prompts: string[] = [];

  constructor(private readonly afterRun?: (count: number) => Promise<void>) {
    super();
  }

  override async run(opts: { prompt: string }): Promise<{ code: number; output: string }> {
    this.prompts.push(opts.prompt);
    await this.afterRun?.(this.prompts.length);
    return { code: 0, output: "ok" };
  }
}

async function runDry(
  repo: string,
  input: {
    promptFile: string;
    reviewPromptFile?: string;
    fixPromptFile?: string;
    maxRounds?: number;
  },
  runner: CaptureRunner,
): Promise<{ dataDir: string; job: JobRecord }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-prompt-job-"));
  const job = await createJob(
    dataDir,
    { repoPath: repo, branch: "feat/prompts", dryRun: true, maxRounds: 1, ...input },
    { model: "composer-2.5", dryRun: true, config: testConfig(dataDir) },
  );
  await runJobLoop(testConfig(dataDir), job, JobControl.fromPersisted(job), {
    agentRunner: runner,
  });
  return { dataDir, job };
}

describe("prompt file resolution", () => {
  it("prefers the worktree copy of a relative path over the repo copy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lr-prompt-bases-"));
    const repo = path.join(root, "repo");
    const wt = path.join(root, "wt");
    await mkdir(path.join(repo, "prompts"), { recursive: true });
    await mkdir(path.join(wt, "prompts"), { recursive: true });
    await writeFile(path.join(repo, REL_REVIEW), "FROM_REPO\n");
    await writeFile(path.join(wt, REL_REVIEW), "FROM_WORKTREE\n");

    const text = await readStagePromptFile(REL_REVIEW, { worktreePath: wt, repoPath: repo });
    assert.equal(text, "FROM_WORKTREE\n");
  });

  it("falls back to repoPath when the worktree does not have the file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lr-prompt-fallback-"));
    const repo = path.join(root, "repo");
    const wt = path.join(root, "wt");
    await mkdir(path.join(repo, "prompts"), { recursive: true });
    await mkdir(wt, { recursive: true });
    await writeFile(path.join(repo, REL_IMPLEMENT), "FROM_REPO\n");

    const text = await readStagePromptFile(
      REL_IMPLEMENT,
      { worktreePath: wt, repoPath: repo },
      "promptFile",
    );
    assert.equal(text, "FROM_REPO\n");
  });

  it("reads an absolute path as given", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lr-prompt-abs-"));
    const abs = path.join(root, "absolute.md");
    const wt = path.join(root, "wt");
    await mkdir(wt, { recursive: true });
    await writeFile(abs, "ABSOLUTE\n");
    await writeFile(path.join(wt, "absolute.md"), "NOT_THIS\n");

    const text = await readStagePromptFile(abs, { worktreePath: wt, repoPath: root });
    assert.equal(text, "ABSOLUTE\n");
  });

  it("returns null when no prompt file is set", async () => {
    assert.equal(await readStagePromptFile("  ", { repoPath: "/repo" }), null);
    assert.equal(await readStagePromptFile(undefined, {}), null);
  });

  it("fails when a relative path cannot be resolved or read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lr-prompt-miss-"));
    const repo = path.join(root, "repo");
    const wt = path.join(root, "wt");
    await mkdir(repo);
    await mkdir(wt);
    await assert.rejects(
      () => readStagePromptFile(REL_IMPLEMENT, {}, "promptFile"),
      /promptFile .*no worktree or repoPath/,
    );
    await assert.rejects(
      () => readStagePromptFile(REL_IMPLEMENT, { worktreePath: wt, repoPath: repo }, "promptFile"),
      (err: Error) => {
        assert.match(err.message, /promptFile not readable: prompts\/issue-224-implement\.md/);
        assert.match(err.message, /not found/);
        const wtIdx = err.message.indexOf(path.resolve(wt, REL_IMPLEMENT));
        const repoIdx = err.message.indexOf(path.resolve(repo, REL_IMPLEMENT));
        assert.ok(wtIdx !== -1 && repoIdx !== -1 && wtIdx < repoIdx);
        return true;
      },
    );
  });

  it("checks set prompt files at submit time without requiring a repo for remote-relative paths", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-prompt-submit-"));
    await mkdir(path.join(repo, "prompts"), { recursive: true });
    await writeFile(path.join(repo, REL_IMPLEMENT), IMPLEMENT);

    await assertSubmitPromptFiles({ repoPath: repo, promptFile: REL_IMPLEMENT });
    await assertSubmitPromptFiles({ repoPath: "", promptFile: REL_IMPLEMENT });
    await assert.rejects(
      () =>
        assertSubmitPromptFiles({
          repoPath: repo,
          promptFile: REL_IMPLEMENT,
          reviewPromptFile: REL_REVIEW,
        }),
      (err: Error) =>
        err instanceof ValidationError && /reviewPromptFile not readable/.test(err.message),
    );
    await assert.rejects(
      () =>
        assertSubmitPromptFiles({
          repoPath: repo,
          promptFile: REL_IMPLEMENT,
          fixPromptFile: REL_FIX,
        }),
      (err: Error) =>
        err instanceof ValidationError && /fixPromptFile not readable/.test(err.message),
    );
    await assert.rejects(
      () => assertSubmitPromptFiles({ promptFile: path.join(repo, "missing.md") }),
      (err: Error) => err instanceof ValidationError && /promptFile not readable/.test(err.message),
    );
  });

  it("accepts a relative prompt that is absent from the working tree and present on origin/<branch>", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lr-prompt-origin-"));
    const bare = path.join(root, "origin.git");
    const repo = path.join(root, "repo");
    const branch = "feat/prompts";
    const jobId = "prompt-on-branch";
    const worktree = cursorWorktreeDir(repoSlugFromPath(repo), jobId);
    const prevPrompt = process.env.GIT_TERMINAL_PROMPT;
    process.env.GIT_TERMINAL_PROMPT = "0";
    try {
      await execFileAsync("git", ["init", "--bare", "-b", "main", bare]);
      await gitInit(repo);
      await git(repo, ["remote", "add", "origin", bare]);
      await git(repo, ["push", "-u", "origin", "main"]);
      await git(repo, ["checkout", "-b", branch]);
      await mkdir(path.join(repo, "prompts"), { recursive: true });
      await writeFile(path.join(repo, REL_IMPLEMENT), "FROM_BRANCH\n");
      await git(repo, ["add", REL_IMPLEMENT]);
      await git(repo, ["commit", "-m", "add implement prompt"]);
      await git(repo, ["push", "-u", "origin", branch]);
      await git(repo, ["checkout", "main"]);
      await assert.rejects(() => access(path.join(repo, REL_IMPLEMENT)));

      await assertSubmitPromptFiles({
        repoPath: repo,
        branch,
        promptFile: REL_IMPLEMENT,
      });
      await assert.rejects(
        () =>
          assertSubmitPromptFiles({
            repoPath: repo,
            branch,
            reviewPromptFile: REL_REVIEW,
          }),
        (err: Error) =>
          err instanceof ValidationError && /reviewPromptFile not readable/.test(err.message),
      );

      const wt = await ensureWorktree(repo, jobId, branch);
      const text = await readStagePromptFile(
        REL_IMPLEMENT,
        { worktreePath: wt.path, repoPath: repo },
        "promptFile",
      );
      assert.equal(text, "FROM_BRANCH\n");
      await assert.rejects(() => access(path.join(repo, REL_IMPLEMENT)));
    } finally {
      if (prevPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
      else process.env.GIT_TERMINAL_PROMPT = prevPrompt;
      await removeWorktree(repo, worktree);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("rejects a prompt that is only on the base when origin/<branch> does not contain it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lr-prompt-base-only-"));
    const bare = path.join(root, "origin.git");
    const repo = path.join(root, "repo");
    const branch = "feat/prompts";
    const onlyOnMain = "prompts/only-on-main.md";
    try {
      await execFileAsync("git", ["init", "--bare", "-b", "main", bare]);
      await gitInit(repo);
      await mkdir(path.join(repo, "prompts"), { recursive: true });
      await writeFile(path.join(repo, onlyOnMain), "FROM_MAIN\n");
      await git(repo, ["add", onlyOnMain]);
      await git(repo, ["commit", "-m", "prompt on main"]);
      await git(repo, ["remote", "add", "origin", bare]);
      await git(repo, ["push", "-u", "origin", "main"]);
      await git(repo, ["checkout", "-b", branch]);
      await git(repo, ["rm", onlyOnMain]);
      await git(repo, ["commit", "-m", "drop main-only prompt"]);
      await git(repo, ["push", "-u", "origin", branch]);
      await assert.rejects(() => access(path.join(repo, onlyOnMain)));

      await assert.rejects(
        () => assertSubmitPromptFiles({ repoPath: repo, branch, promptFile: onlyOnMain }),
        (err: Error) =>
          err instanceof ValidationError && /promptFile not readable/.test(err.message),
      );
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("accepts a relative prompt missing from the working tree when the checkout base still has it", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-prompt-base-fallback-"));
    try {
      await gitInit(repo);
      await mkdir(path.join(repo, "prompts"), { recursive: true });
      await writeFile(path.join(repo, REL_IMPLEMENT), IMPLEMENT);
      await git(repo, ["add", REL_IMPLEMENT]);
      await git(repo, ["commit", "-m", "add prompt"]);
      await assertSubmitPromptFiles({
        repoPath: repo,
        branch: "feat/new",
        promptFile: REL_IMPLEMENT,
      });
      await rm(path.join(repo, REL_IMPLEMENT));
      await assert.rejects(() => access(path.join(repo, REL_IMPLEMENT)));
      await assertSubmitPromptFiles({
        repoPath: repo,
        branch: "feat/new",
        promptFile: REL_IMPLEMENT,
      });
    } finally {
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("job stages read prompt files from the worktree", () => {
  it("uses relative implement, review, and fix files and re-reads review after the build", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-prompt-run-"));
    await mkdir(path.join(repo, "prompts"), { recursive: true });
    const reviewPath = path.join(repo, REL_REVIEW);
    await writeFile(path.join(repo, REL_IMPLEMENT), IMPLEMENT);
    await writeFile(reviewPath, REVIEW_V1);
    await writeFile(path.join(repo, REL_FIX), FIX);

    const runner = new CaptureRunner(async (count) => {
      if (count === 1) await writeFile(reviewPath, REVIEW_V2);
    });
    const { job } = await runDry(
      repo,
      {
        promptFile: REL_IMPLEMENT,
        reviewPromptFile: REL_REVIEW,
        fixPromptFile: REL_FIX,
        maxRounds: 2,
      },
      runner,
    );

    assert.equal(job.stage, "approved", job.error ?? "");
    assert.equal(job.input.promptFile, REL_IMPLEMENT);
    assert.equal(runner.prompts.length, 4);
    assert.ok(runner.prompts[0]?.startsWith(IMPLEMENT));
    assert.ok(runner.prompts[1]?.startsWith(REVIEW_V2));
    assert.ok(runner.prompts[2]?.startsWith(FIX));
    assert.ok(runner.prompts[3]?.startsWith(REVIEW_V2));
    assert.equal(
      runner.prompts.some((p) => p.includes("You are the implementor")),
      false,
    );
    assert.equal(
      runner.prompts.some((p) => p.includes("You are the reviewer")),
      false,
    );
    assert.equal(
      runner.prompts.some((p) => p.includes("You are the fixer")),
      false,
    );
  });

  it("uses the default review prompt when reviewPromptFile is unset", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-prompt-default-"));
    await mkdir(path.join(repo, "prompts"), { recursive: true });
    await writeFile(path.join(repo, REL_IMPLEMENT), IMPLEMENT);
    const runner = new CaptureRunner();
    const { job } = await runDry(repo, { promptFile: REL_IMPLEMENT, maxRounds: 1 }, runner);
    assert.equal(job.stage, "approved", job.error ?? "");
    assert.equal(runner.prompts.length, 2);
    assert.ok(runner.prompts[1]?.includes("You are the reviewer for one GitHub pull request."));
  });

  it("fails the job when a set prompt file cannot be read", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-prompt-fail-"));
    const runner = new CaptureRunner();
    const { dataDir, job } = await runDry(repo, { promptFile: REL_IMPLEMENT }, runner);
    assert.equal(runner.prompts.length, 0);
    assert.equal(job.stage, "failed");
    assert.match(job.error ?? "", /promptFile not readable/);
    const saved = await loadJob(dataDir, job.id);
    assert.equal(saved?.stage, "failed");
    assert.match(saved?.error ?? "", /promptFile not readable/);
    const log = await readFile(job.logPath, "utf8");
    assert.match(log, /\[runner\] promptFile not readable/);

    await mkdir(path.join(repo, "prompts"), { recursive: true });
    await writeFile(path.join(repo, REL_IMPLEMENT), IMPLEMENT);
    const reviewRunner = new CaptureRunner();
    const review = await runDry(
      repo,
      { promptFile: REL_IMPLEMENT, reviewPromptFile: REL_REVIEW },
      reviewRunner,
    );
    assert.equal(reviewRunner.prompts.length, 1);
    assert.equal(review.job.stage, "failed");
    assert.match(review.job.error ?? "", /reviewPromptFile not readable/);

    await writeFile(path.join(repo, REL_REVIEW), REVIEW_V1);
    const fixRunner = new CaptureRunner();
    const fix = await runDry(
      repo,
      {
        promptFile: REL_IMPLEMENT,
        reviewPromptFile: REL_REVIEW,
        fixPromptFile: REL_FIX,
        maxRounds: 2,
      },
      fixRunner,
    );
    assert.equal(fixRunner.prompts.length, 2);
    assert.equal(fix.job.stage, "failed");
    assert.match(fix.job.error ?? "", /fixPromptFile not readable/);
  });
});

describe("start_job rejects a missing prompt file over HTTP and MCP", () => {
  before(() => {
    process.env.PRGENIE_RUNNER_INLINE_JOBS = "1";
  });

  after(() => {
    delete process.env.PRGENIE_RUNNER_INLINE_JOBS;
  });

  async function startedEngine(): Promise<{ dataDir: string; repo: string; engine: RunnerEngine }> {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-prompt-api-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-prompt-api-repo-"));
    await gitInit(repo);
    await mkdir(path.join(repo, "prompts"), { recursive: true });
    await writeFile(path.join(repo, REL_IMPLEMENT), IMPLEMENT);
    await saveSettings(dataDir, { maxActiveJobs: 4 });
    const engine = new RunnerEngine(testConfig(dataDir), { watchCi: false });
    return { dataDir, repo, engine };
  }

  async function waitUntilDone(dataDir: string, id: string): Promise<JobRecord> {
    const deadline = Date.now() + 20_000;
    let last: JobRecord | null = null;
    while (Date.now() < deadline) {
      last = await loadJob(dataDir, id);
      if (
        last &&
        last.stage !== "building" &&
        last.stage !== "reviewing" &&
        last.stage !== "fixing"
      ) {
        return last;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`job did not finish: ${last?.stage ?? "missing"} ${last?.error ?? ""}`);
  }

  it("rejects a missing relative promptFile the same way on both paths and creates no job", async () => {
    const { engine, repo } = await startedEngine();
    const payload = {
      branch: "feat/missing-prompt",
      repoPath: repo,
      promptFile: REL_REVIEW,
      dryRun: true,
    };
    const http = await handleStartJobRequest(engine, payload);
    assert.equal(http.status, 400);
    const message = (http.body as { error: string }).error;
    assert.match(message, /promptFile not readable: prompts\/issue-224-review\.md/);
    const mcp = await handleMcpJsonRpc(engine, {
      id: 7,
      method: "tools/call",
      params: { name: "start_job", arguments: payload },
    });
    assert.equal(mcp?.error?.message, message);
    assert.deepEqual(await engine.list({ includeFinished: true }), []);
  });

  it("keeps a relative path that exists and runs that file instead of the default", async () => {
    const { dataDir, engine, repo } = await startedEngine();
    const http = await handleStartJobRequest(engine, {
      branch: "feat/rel-http",
      repoPath: repo,
      promptFile: REL_IMPLEMENT,
      dryRun: true,
      maxRounds: 1,
    });
    assert.equal(http.status, 201);
    const viaHttp = http.body as JobRecord;
    assert.equal(viaHttp.input.promptFile, REL_IMPLEMENT);

    const mcp = await handleMcpJsonRpc(engine, {
      id: 8,
      method: "tools/call",
      params: {
        name: "start_job",
        arguments: {
          branch: "feat/rel-mcp",
          repoPath: repo,
          promptFile: REL_IMPLEMENT,
          dryRun: true,
          maxRounds: 1,
        },
      },
    });
    const viaMcp = (mcp?.result as { structuredContent?: JobRecord } | undefined)
      ?.structuredContent;
    assert.ok(viaMcp, mcp?.error?.message);
    assert.equal(viaMcp?.input.promptFile, REL_IMPLEMENT);

    const httpDone = await waitUntilDone(dataDir, viaHttp.id);
    const mcpDone = await waitUntilDone(dataDir, viaMcp.id);
    assert.equal(httpDone.stage, "approved", httpDone.error ?? "");
    assert.equal(mcpDone.stage, "approved", mcpDone.error ?? "");
    const log = await readFile(httpDone.logPath, "utf8");
    assert.match(log, /IMPLEMENT_224/);
    assert.equal(log.includes("You are the implementor for one feature branch."), false);
  });
});
