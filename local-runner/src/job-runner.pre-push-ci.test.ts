import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AgentRunner } from "./agent.js";
import type { RunnerConfig } from "./config.js";
import { JobControl } from "./job-control.js";
import { runJobLoop } from "./job-runner.js";
import { PROVE_EVIDENCE_HEADING } from "./prove-it-works.js";
import type { PrePushCiGateResult } from "./scoped-ci/types.js";
import { createJob } from "./store.js";

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

const GOOD_EVIDENCE = `${PROVE_EVIDENCE_HEADING}
$ pnpm format:check local-runner/src/foo.ts
ok
scope: local-runner/src/foo.ts exit 0
`;

describe("job-runner pre-push CI gate (#255)", () => {
  it("fails building when pre-push CI gate fails", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-pre-push-fail-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-pre-push-repo-"));
    await mkdir(repo, { recursive: true });
    const promptFile = path.join(repo, "prompt.md");
    await writeFile(promptFile, "Implement.\n", "utf8");

    const gateFail: PrePushCiGateResult = {
      ok: false,
      results: [
        {
          name: "format:check",
          command: "pnpm format:check x.ts",
          scope: "x.ts",
          exitCode: 1,
          excerpt: "prettier error",
          passed: false,
        },
      ],
      evidenceText: "ci failed",
      error: "pre-push CI failed: format:check (exit 1)",
    };

    class BuildRunner extends AgentRunner {
      override async run(): Promise<{ code: number; output: string }> {
        return { code: 0, output: GOOD_EVIDENCE };
      }
    }

    const job = await createJob(
      dataDir,
      {
        repoPath: repo,
        branch: "feat/pre-push-fail",
        promptFile,
        dryRun: true,
        maxRounds: 0,
      },
      { model: "composer-2.5", dryRun: true, config: testConfig(dataDir) },
    );

    await runJobLoop(testConfig(dataDir), job, JobControl.fromPersisted(job), {
      agentRunner: new BuildRunner(),
      prePushCiGate: async () => gateFail,
    });

    assert.equal(job.stage, "failed");
    assert.match(job.error ?? "", /pre-push CI failed/i);
  });

  it("continues building when pre-push CI gate passes", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-pre-push-ok-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-pre-push-ok-repo-"));
    await mkdir(repo, { recursive: true });
    const promptFile = path.join(repo, "prompt.md");
    await writeFile(promptFile, "Implement.\n", "utf8");

    const gateOk: PrePushCiGateResult = {
      ok: true,
      results: [
        {
          name: "format:check",
          command: "pnpm format:check x.ts",
          scope: "x.ts",
          exitCode: 0,
          excerpt: "ok",
          passed: true,
        },
      ],
      evidenceText: "ci ok",
    };

    class BuildRunner extends AgentRunner {
      override async run(): Promise<{ code: number; output: string }> {
        return { code: 0, output: GOOD_EVIDENCE };
      }
    }

    const job = await createJob(
      dataDir,
      {
        repoPath: repo,
        branch: "feat/pre-push-ok",
        promptFile,
        dryRun: true,
        maxRounds: 0,
        expectPr: false,
      },
      { model: "composer-2.5", dryRun: true, config: testConfig(dataDir) },
    );

    await runJobLoop(testConfig(dataDir), job, JobControl.fromPersisted(job), {
      agentRunner: new BuildRunner(),
      prePushCiGate: async () => gateOk,
    });

    assert.notEqual(job.stage, "failed");
    assert.ok(!/pre-push CI failed/i.test(job.error ?? ""));
  });
});
