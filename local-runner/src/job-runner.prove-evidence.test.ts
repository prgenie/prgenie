import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AgentRunner } from "./agent.js";
import type { RunnerConfig } from "./config.js";
import { JobControl } from "./job-control.js";
import { runJobLoop } from "./job-runner.js";
import { PROVE_EVIDENCE_HEADING } from "./prove-it-works.js";
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

class OutputRunner extends AgentRunner {
  constructor(private readonly output: string) {
    super();
  }

  override async run(): Promise<{ code: number; output: string }> {
    return { code: 0, output: this.output };
  }
}

describe("job-runner prove-it-works gate (#246)", () => {
  it("fails docs building when default prompt is used and agent omits PROVE: EVIDENCE", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-prove-fail-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-prove-repo-"));
    await mkdir(repo, { recursive: true });
    const job = await createJob(
      dataDir,
      {
        jobType: "docs",
        repoPath: repo,
        branch: "docs/prove-gate",
        docsTemplate: "marketing",
        dryRun: true,
        maxRounds: 1,
      },
      { model: "composer-2.5", dryRun: true, config: testConfig(dataDir) },
    );
    await runJobLoop(testConfig(dataDir), job, JobControl.fromPersisted(job), {
      agentRunner: new OutputRunner("Wrote the landing page.\n"),
    });
    assert.equal(job.stage, "failed");
    assert.match(job.error ?? "", /PROVE: EVIDENCE/);
  });

  it("passes docs building when agent includes PROVE: EVIDENCE", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-prove-ok-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-prove-repo-ok-"));
    await mkdir(repo, { recursive: true });
    const evidence = `${PROVE_EVIDENCE_HEADING}
$ test -f docs/landing.md && head -n 3 docs/landing.md && wc -c docs/landing.md
# Landing
Hero copy verified at path.
landing.md byte count: 12840
`;
    class DocsRunner extends AgentRunner {
      override async run(opts: {
        prompt: string;
      }): Promise<{ code: number; output: string }> {
        if (opts.prompt.includes("You are the reviewer")) {
          return { code: 0, output: "VERDICT: APPROVE\n" };
        }
        return { code: 0, output: evidence };
      }
    }
    const job = await createJob(
      dataDir,
      {
        jobType: "docs",
        repoPath: repo,
        branch: "docs/prove-ok",
        docsTemplate: "marketing",
        dryRun: true,
        maxRounds: 1,
      },
      { model: "composer-2.5", dryRun: true, config: testConfig(dataDir) },
    );
    await runJobLoop(testConfig(dataDir), job, JobControl.fromPersisted(job), {
      agentRunner: new DocsRunner(),
    });
    assert.equal(job.stage, "approved", job.error ?? "");
  });
});