import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GhResult } from "./github.js";
import { AgentRunner } from "./agent.js";
import type { RunnerConfig } from "./config.js";
import { JobControl } from "./job-control.js";
import { runFixStage } from "./job-runner.js";
import { PROVE_EVIDENCE_HEADING } from "./prove-it-works.js";
import { findDriverEntry, loadSettings } from "./settings.js";
import { createJob } from "./store.js";
import {
  hasConflictMarkers,
  mergeOntoBase,
  mergeOntoBaseOrConflict,
  MergeOntoBaseError,
  verifyMergeResolved,
} from "./worktree.js";

const execFileAsync = promisify(execFile);
const CONFLICT_FILE = "docs/review-checklist.md";

async function g(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/** Bare origin + clone where `feat/x` and origin/main both edited the same line after diverging. */
async function conflictedClone(tag: string): Promise<{ origin: string; wt: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), `lr-merge-${tag}-`));
  const origin = path.join(root, "origin.git");
  const wt = path.join(root, "wt");
  await execFileAsync("git", ["init", "--bare", "-b", "main", origin]);
  await execFileAsync("git", ["clone", "-q", origin, wt]);
  await g(wt, "config", "user.email", "t@test");
  await g(wt, "config", "user.name", "t");
  await g(wt, "checkout", "-q", "-b", "main");
  await mkdir(path.join(wt, "docs"), { recursive: true });
  await writeFile(path.join(wt, CONFLICT_FILE), "# Checklist\n\nline: base\n", "utf8");
  await g(wt, "add", ".");
  await g(wt, "commit", "-q", "-m", "base");
  await g(wt, "push", "-q", "origin", "main");
  await g(wt, "checkout", "-q", "-b", "feat/x");
  await writeFile(path.join(wt, CONFLICT_FILE), "# Checklist\n\nline: branch\n", "utf8");
  await g(wt, "commit", "-q", "-am", "branch edit");
  await g(wt, "push", "-q", "-u", "origin", "feat/x");
  await g(wt, "checkout", "-q", "main");
  await writeFile(path.join(wt, CONFLICT_FILE), "# Checklist\n\nline: main\n", "utf8");
  await g(wt, "commit", "-q", "-am", "main edit");
  await g(wt, "push", "-q", "origin", "main");
  await g(wt, "checkout", "-q", "feat/x");
  return { origin, wt };
}

async function hasMergeHead(wt: string): Promise<boolean> {
  try {
    await g(wt, "rev-parse", "-q", "--verify", "MERGE_HEAD");
    return true;
  } catch {
    return false;
  }
}

describe("mergeOntoBase error detail (#239)", () => {
  it("names the conflicting files and includes git's stdout, which is where conflicts go", async () => {
    const { wt } = await conflictedClone("err");
    await assert.rejects(mergeOntoBase(wt), (err: unknown) => {
      assert.ok(err instanceof MergeOntoBaseError);
      assert.match(
        err.message,
        /^git merge origin\/main failed; conflicting files: docs\/review-checklist\.md; git output: /,
      );
      assert.match(err.message, /CONFLICT \(content\)/);
      assert.deepEqual(err.files, [CONFLICT_FILE]);
      return true;
    });
  });

  it("caps long git output and reports non-conflict failures with stdout and stderr", async () => {
    const calls: string[][] = [];
    const gitImpl = async (_cwd: string, args: string[]): Promise<GhResult> => {
      calls.push(args);
      if (args[0] === "rev-parse" && args.includes("MERGE_HEAD"))
        return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "abc\n", stderr: "" };
      if (args[0] === "merge-base") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "merge") {
        return {
          code: 1,
          stdout: "x".repeat(5000),
          stderr: "error: untracked file would be overwritten",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    await assert.rejects(mergeOntoBaseOrConflict("/wt", undefined, gitImpl), (err: unknown) => {
      assert.ok(err instanceof MergeOntoBaseError);
      assert.match(err.message, /git output: x+… \(truncated\)/);
      assert.ok(err.message.length < 1700, `message length ${err.message.length}`);
      return true;
    });
  });
});

describe("mergeOntoBaseOrConflict (#239)", () => {
  it("leaves a conflicted merge in progress and reports the files instead of throwing", async () => {
    const { wt } = await conflictedClone("conflict");
    const res = await mergeOntoBaseOrConflict(wt);
    assert.equal(res.status, "conflict");
    assert.ok(res.status === "conflict");
    assert.deepEqual(res.files, [CONFLICT_FILE]);
    assert.equal(res.resumed, false);
    assert.equal(await hasMergeHead(wt), true);
  });

  it("reports an unfinished merge as resumed instead of merging again", async () => {
    const { wt } = await conflictedClone("resume");
    await mergeOntoBaseOrConflict(wt);
    const again = await mergeOntoBaseOrConflict(wt);
    assert.equal(again.status, "conflict");
    assert.ok(again.status === "conflict" && again.resumed);
    assert.deepEqual(again.status === "conflict" ? again.files : [], [CONFLICT_FILE]);
  });

  it("is up to date after the operator resolved, committed and pushed the merge", async () => {
    const { wt } = await conflictedClone("resolved");
    await mergeOntoBaseOrConflict(wt);
    await writeFile(path.join(wt, CONFLICT_FILE), "# Checklist\n\nline: main + branch\n", "utf8");
    await g(wt, "add", CONFLICT_FILE);
    await g(wt, "commit", "-q", "--no-edit");
    await g(wt, "push", "-q", "origin", "feat/x");
    const res = await mergeOntoBaseOrConflict(wt);
    assert.equal(res.status, "up_to_date");
  });
});

describe("verifyMergeResolved", () => {
  it("rejects unmerged paths, leftover markers, and an uncommitted merge", async () => {
    const { wt } = await conflictedClone("verify");
    await mergeOntoBaseOrConflict(wt);
    const unmerged = await verifyMergeResolved(wt, [CONFLICT_FILE]);
    assert.ok(!unmerged.ok && /unmerged/.test(unmerged.reason));

    await g(wt, "add", CONFLICT_FILE); // staged with markers still in it
    const markers = await verifyMergeResolved(wt, [CONFLICT_FILE]);
    assert.ok(!markers.ok && /markers/.test(markers.reason));
    assert.deepEqual(markers.ok ? [] : markers.files, [CONFLICT_FILE]);

    await writeFile(path.join(wt, CONFLICT_FILE), "# Checklist\n\nline: both\n", "utf8");
    await g(wt, "add", CONFLICT_FILE);
    const uncommitted = await verifyMergeResolved(wt, [CONFLICT_FILE]);
    assert.ok(!uncommitted.ok && /MERGE_HEAD/.test(uncommitted.reason));

    await g(wt, "commit", "-q", "--no-edit");
    assert.deepEqual(await verifyMergeResolved(wt, [CONFLICT_FILE]), { ok: true });
  });

  it("does not treat a Markdown ======= underline as a conflict marker", () => {
    assert.equal(hasConflictMarkers("Title\n=======\n"), false);
    assert.equal(hasConflictMarkers("<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main\n"), true);
  });
});

function testConfig(dataDir: string): RunnerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "t",
    dataDir,
    notifyEmail: null,
    resendApiKey: null,
    defaultModel: "composer-2.5",
    dryRun: false,
    defaultCodeRepoPath: null,
  };
}

const EVIDENCE = `${PROVE_EVIDENCE_HEADING}
$ pnpm format:check docs/review-checklist.md
ok
scope: docs/review-checklist.md exit 0
`;

async function fixStageFor(tag: string, resolve: (wt: string) => Promise<void>) {
  const { wt } = await conflictedClone(tag);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `lr-merge-${tag}-data-`));
  const promptFile = path.join(wt, "..", "prompt.md");
  await writeFile(promptFile, "Implement.\n", "utf8");
  const job = await createJob(
    dataDir,
    { repoPath: wt, branch: "feat/x", promptFile, maxRounds: 2 },
    { model: "composer-2.5", dryRun: false, config: testConfig(dataDir) },
  );
  job.dryRun = false;
  job.worktreePath = wt;
  job.prUrl = "https://github.com/o/r/pull/387";
  job.prNumber = 387;
  job.reviewRound = 1;
  const prompts: string[] = [];
  class FixRunner extends AgentRunner {
    override async run(opts: Parameters<AgentRunner["run"]>[0]) {
      prompts.push(opts.prompt);
      await resolve(wt);
      return { code: 0, output: EVIDENCE };
    }
  }
  const settings = await loadSettings(dataDir);
  const driver = findDriverEntry(settings, "cursor-agent");
  assert.ok(driver);
  const control = JobControl.fromPersisted(job);
  const ok = await runFixStage(
    new FixRunner(),
    testConfig(dataDir),
    job,
    control,
    settings,
    settings,
    wt,
    "text",
    driver,
    { prePushCiGate: async () => ({ ok: true, results: [], evidenceText: "", skipped: true }) },
  );
  return { ok, job, prompts, wt };
}

describe("runFixStage merge conflicts (#239)", () => {
  it("hands the conflict to the fix agent and accepts the round once it is merged and pushed", async () => {
    const { ok, job, prompts, wt } = await fixStageFor("fix-ok", async (dir) => {
      await writeFile(
        path.join(dir, CONFLICT_FILE),
        "# Checklist\n\nline: main + branch\n",
        "utf8",
      );
      await g(dir, "add", CONFLICT_FILE);
      await g(dir, "commit", "-q", "--no-edit");
      await g(dir, "push", "-q", "origin", "feat/x");
    });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /--- merge conflicts with origin\/main ---/);
    assert.match(prompts[0], /- docs\/review-checklist\.md/);
    assert.match(prompts[0], /do not rebase/);
    assert.equal(ok, true, job.error ?? "");
    assert.equal(job.stage, "fixing");
    assert.equal(await hasMergeHead(wt), false);
    assert.match(await readFile(path.join(wt, CONFLICT_FILE), "utf8"), /main \+ branch/);
  });

  it("fails with the files and operator steps when the agent leaves the conflict", async () => {
    const { ok, job } = await fixStageFor("fix-left", async () => undefined);
    assert.equal(ok, false);
    assert.equal(job.stage, "failed");
    assert.match(job.error ?? "", /not resolved by the fix agent/);
    assert.match(job.error ?? "", /docs\/review-checklist\.md/);
    assert.match(job.error ?? "", /commit the merge, push the branch, then continue_job/);
  });
});
