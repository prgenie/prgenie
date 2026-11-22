import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RunnerConfig } from "./config.js";
import { loadSettings, saveSettings } from "./settings.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRunner, type AgentRunOptions } from "./agent.js";
import { JobControl } from "./job-control.js";
import { runJobLoop } from "./job-runner.js";
import {
  challengerModelForJob,
  modelForActiveStage,
  resolveStageModelsForJob,
} from "./job-models.js";
import {
  BUILTIN_CHALLENGER_MODEL,
  BUILTIN_FIX_MODEL,
  BUILTIN_REREVIEW_MODEL,
} from "./runner-policy.js";
import { runnerSettingsFile } from "./paths.js";
import { createJob, loadJob } from "./store.js";
import type { JobInput } from "./types.js";
import { ValidationError } from "./validation-error.js";
import { promptIncludesProveItWorksSection, STUB_PROVE_EVIDENCE_OUTPUT } from "./prove-it-works.js";

class ModelCaptureRunner extends AgentRunner {
  models: string[] = [];

  override async run(opts: AgentRunOptions): Promise<{ code: number; output: string }> {
    this.models.push(opts.model);
    this.emit("line", '{"type":"assistant","message":{}}');
    const output = promptIncludesProveItWorksSection(opts.prompt)
      ? STUB_PROVE_EVIDENCE_OUTPUT
      : "ok";
    return { code: 0, output };
  }
}

function testConfig(dataDir: string): RunnerConfig {
  return {
    host: "127.0.0.1",
    port: 9473,
    token: "t",
    dataDir,
    notifyEmail: null,
    resendApiKey: null,
    defaultModel: "composer-2.5",
    dryRun: true,
    defaultCodeRepoPath: null,
  };
}

describe("stage models", () => {
  it("defaults build/review from env and fix to auto", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-"));
    const settings = await loadSettings(dataDir);
    const resolved = resolveStageModelsForJob(
      testConfig(dataDir),
      settings,
      { repoPath: "/r", branch: "b", promptFile: "/p" },
      "cursor-agent",
    );
    assert.equal(resolved.build, "composer-2.5");
    assert.equal(resolved.review, "composer-2.5");
    assert.equal(resolved.rereview, BUILTIN_REREVIEW_MODEL);
    assert.equal(resolved.fix, BUILTIN_FIX_MODEL);
    assert.equal(resolved.challenger, BUILTIN_CHALLENGER_MODEL);
    assert.notEqual(resolved.challenger, resolved.review);
  });

  it("challenger follows an explicit model that differs from review", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-challenger-"));
    const resolved = resolveStageModelsForJob(
      testConfig(dataDir),
      await loadSettings(dataDir),
      {
        repoPath: "/r",
        branch: "b",
        promptFile: "/p",
        stageModels: { review: "review-a", challenger: "challenger-b" },
      },
      "cursor-agent",
    );
    assert.equal(resolved.review, "review-a");
    assert.equal(resolved.challenger, "challenger-b");
  });

  it("challengerModelForJob uses the snapshotted challenger stage", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-challenger-job-"));
    const job = await createJob(
      dataDir,
      { repoPath: "/r", branch: "b", promptFile: "/p", dryRun: true },
      { model: "composer-2.5", dryRun: true, config: testConfig(dataDir) },
    );
    assert.equal(challengerModelForJob(job), job.stageModels?.challenger);
  });

  it("legacy single model applies to all stages", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-legacy-"));
    const settings = await loadSettings(dataDir);
    const resolved = resolveStageModelsForJob(
      testConfig(dataDir),
      settings,
      { repoPath: "/r", branch: "b", promptFile: "/p", model: "gpt-test" },
      "cursor-agent",
    );
    assert.equal(resolved.build, "gpt-test");
    assert.equal(resolved.review, "gpt-test");
    assert.equal(resolved.rereview, "gpt-test");
    assert.equal(resolved.fix, "gpt-test");
  });

  for (const driver of ["claude-code", "local-model"]) {
    it(`${driver} fix stage falls back to the build model instead of auto`, async () => {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-noauto-"));
      const settings = await loadSettings(dataDir);
      const resolved = resolveStageModelsForJob(
        testConfig(dataDir),
        settings,
        { repoPath: "/r", branch: "b", promptFile: "/p" },
        driver,
      );
      assert.notEqual(resolved.fix, "auto");
      assert.equal(resolved.fix, resolved.build);
      assert.notEqual(resolved.rereview, "auto");
      assert.equal(resolved.rereview, resolved.review);
    });
  }

  it("rejects an explicit auto fix model for a driver without auto", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-noauto-explicit-"));
    const settings = await loadSettings(dataDir);
    assert.throws(
      () =>
        resolveStageModelsForJob(
          testConfig(dataDir),
          settings,
          { repoPath: "/r", branch: "b", promptFile: "/p", stageModels: { fix: "auto" } },
          "claude-code",
        ),
      ValidationError,
    );
  });

  it("rejects an explicit auto re-review model for a driver without auto", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-noauto-rereview-"));
    const settings = await loadSettings(dataDir);
    assert.throws(
      () =>
        resolveStageModelsForJob(
          testConfig(dataDir),
          settings,
          { repoPath: "/r", branch: "b", promptFile: "/p", stageModels: { rereview: "auto" } },
          "claude-code",
        ),
      ValidationError,
    );
  });

  it("an explicit stage model wins over the legacy all-stage model (#146)", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-146-"));
    const resolved = resolveStageModelsForJob(
      testConfig(dataDir),
      await loadSettings(dataDir),
      {
        repoPath: "/r",
        branch: "b",
        promptFile: "/p",
        model: "composer-2.5",
        stageModels: { build: "composer-2.5", review: "composer-2.5", fix: "auto" },
      },
      "cursor-agent",
    );
    assert.equal(resolved.build, "composer-2.5");
    assert.equal(resolved.review, "composer-2.5");
    assert.equal(resolved.rereview, "composer-2.5");
    assert.equal(resolved.fix, "auto");
    assert.equal(resolved.sources.fix, "job");
  });

  it("fix defaults to auto whatever the env model is", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-env-"));
    const resolved = resolveStageModelsForJob(
      { ...testConfig(dataDir), defaultModel: "env-model" },
      await loadSettings(dataDir),
      { repoPath: "/r", branch: "b", promptFile: "/p", stageModels: { build: "b-model" } },
      "cursor-agent",
    );
    assert.equal(resolved.build, "b-model");
    assert.equal(resolved.review, "env-model");
    assert.equal(resolved.rereview, "auto");
    assert.equal(resolved.fix, "auto");
  });

  describe("precedence: request stage, request model, settings, stage default, env", () => {
    const ENV = "env-model";

    async function resolveWith(
      settingsPatch: Parameters<typeof saveSettings>[1] | null,
      input: Pick<JobInput, "model" | "stageModels">,
      driver = "cursor-agent",
    ) {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-order-"));
      if (settingsPatch) await saveSettings(dataDir, settingsPatch);
      return resolveStageModelsForJob(
        { ...testConfig(dataDir), defaultModel: ENV },
        await loadSettings(dataDir),
        { repoPath: "/r", branch: "b", promptFile: "/p", ...input },
        driver,
      );
    }

    const allSettings = {
      defaultModel: "settings-default",
      stageModels: {
        build: "settings-build",
        review: "settings-review",
        rereview: "settings-rereview",
        fix: "settings-fix",
        challenger: "settings-challenger",
      },
    };
    const allRequest = {
      model: "request-all",
      stageModels: {
        build: "request-build",
        review: "request-review",
        rereview: "request-rereview",
        fix: "request-fix",
        challenger: "request-challenger",
      },
    };

    it("request stage model wins over everything", async () => {
      const r = await resolveWith(allSettings, allRequest);
      assert.deepEqual(
        [r.build, r.review, r.rereview, r.fix, r.challenger],
        [
          "request-build",
          "request-review",
          "request-rereview",
          "request-fix",
          "request-challenger",
        ],
      );
      assert.deepEqual(r.sources, {
        build: "job",
        review: "job",
        rereview: "job",
        fix: "job",
        challenger: "job",
      });
    });

    it("request model is next", async () => {
      const r = await resolveWith(allSettings, { model: "request-all" });
      assert.deepEqual(
        [r.build, r.review, r.rereview, r.fix, r.challenger],
        ["request-all", "request-all", "request-all", "request-all", "settings-challenger"],
      );
    });

    it("settings stage models come after the request", async () => {
      const r = await resolveWith(allSettings, {});
      assert.deepEqual(
        [r.build, r.review, r.rereview, r.fix, r.challenger],
        [
          "settings-build",
          "settings-review",
          "settings-rereview",
          "settings-fix",
          "settings-challenger",
        ],
      );
      assert.deepEqual(r.sources, {
        build: "settings",
        review: "settings",
        rereview: "settings",
        fix: "settings",
        challenger: "settings",
      });
    });

    it("stage defaults apply when settings leave a stage unset", async () => {
      const r = await resolveWith(
        {
          defaultModel: "settings-default",
          stageModels: { build: null, review: null, rereview: null, fix: null, challenger: null },
        },
        {},
      );
      assert.deepEqual(
        [r.build, r.review, r.rereview, r.fix, r.challenger],
        ["settings-default", "settings-default", "auto", "auto", "auto"],
      );
      assert.equal(r.sources.fix, "builtin");
      assert.equal(r.sources.rereview, "builtin");
      assert.equal(r.sources.challenger, "builtin");
    });

    it("env model is the last resort, and never replaces the auto fix default", async () => {
      const r = await resolveWith(
        { stageModels: { fix: null, rereview: null, challenger: null } },
        {},
      );
      assert.deepEqual(
        [r.build, r.review, r.rereview, r.fix, r.challenger],
        [ENV, ENV, "auto", "auto", "auto"],
      );
      assert.deepEqual(r.sources, {
        build: "env",
        review: "env",
        rereview: "builtin",
        fix: "builtin",
        challenger: "builtin",
      });
    });

    it("drivers without auto fix with the resolved build model", async () => {
      const r = await resolveWith(null, { stageModels: { build: "request-build" } }, "claude-code");
      assert.equal(r.fix, "request-build");
      assert.equal(r.rereview, r.review);
      assert.notEqual(r.rereview, "auto");
    });

    it("an explicit re-review model is kept on drivers without auto", async () => {
      const r = await resolveWith(
        null,
        { stageModels: { rereview: "claude-rereview" } },
        "claude-code",
      );
      assert.equal(r.rereview, "claude-rereview");
      assert.equal(r.sources.rereview, "job");
    });
  });

  it("fix rounds run the stored fix model", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-run-"));
    const job = await createJob(
      dataDir,
      {
        repoPath: "/r",
        branch: "b",
        promptFile: "/p",
        model: "composer-2.5",
        stageModels: { fix: "auto" },
      },
      { model: "composer-2.5", dryRun: true, config: testConfig(dataDir) },
    );
    const stored = await loadJob(dataDir, job.id);
    assert.deepEqual(stored?.stageModels, {
      build: "composer-2.5",
      review: "composer-2.5",
      rereview: "composer-2.5",
      fix: "auto",
      challenger: "auto",
    });
    assert.equal(modelForActiveStage(stored!, "building"), "composer-2.5");
    assert.equal(modelForActiveStage(stored!, "fixing"), "auto");
  });

  it("review round 1 uses the review model and later rounds use re-review", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-rounds-"));
    const job = await createJob(
      dataDir,
      { repoPath: "/r", branch: "b", promptFile: "/p", dryRun: true },
      { model: "composer-2.5", dryRun: true, config: testConfig(dataDir) },
    );
    assert.equal(job.stageModels?.review, "composer-2.5");
    assert.equal(job.stageModels?.rereview, "auto");
    job.reviewRound = 1;
    assert.equal(modelForActiveStage(job, "reviewing"), "composer-2.5");
    job.reviewRound = 2;
    assert.equal(modelForActiveStage(job, "reviewing"), "auto");
    job.reviewRound = 3;
    assert.equal(modelForActiveStage(job, "reviewing"), "auto");
    job.stageModels = { ...job.stageModels!, rereview: "" };
    assert.equal(modelForActiveStage(job, "reviewing"), "composer-2.5");
  });

  it("a default job reviews round 1 on the review model and later rounds on re-review", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-run-rounds-"));
    const repo = await mkdtemp(path.join(os.tmpdir(), "lr-models-run-repo-"));
    const promptFile = path.join(repo, "prompt.md");
    await writeFile(promptFile, "Build the feature.\n", "utf8");
    const job = await createJob(
      dataDir,
      {
        repoPath: repo,
        branch: "feat/rereview",
        promptFile,
        maxRounds: 3,
        dryRun: true,
      },
      { model: "composer-2.5", dryRun: true, config: testConfig(dataDir) },
    );
    const runner = new ModelCaptureRunner();
    await runJobLoop(testConfig(dataDir), job, JobControl.fromPersisted(job), {
      agentRunner: runner,
    });
    assert.equal(job.stage, "approved", job.error ?? "");
    assert.deepEqual(runner.models, [
      "composer-2.5",
      "composer-2.5",
      "auto",
      "auto",
      "auto",
      "auto",
    ]);
    assert.equal(job.stageModelActual?.build, "composer-2.5");
    assert.equal(job.stageModelActual?.review, "composer-2.5");
    assert.equal(job.stageModelActual?.rereview, "auto");
    assert.equal(job.stageModelActual?.fix, "auto");
    const persisted = await loadJob(dataDir, job.id);
    assert.equal(persisted?.stageModelActual?.review, "composer-2.5");
    assert.equal(persisted?.stageModelActual?.rereview, "auto");
  });

  it("defaultModel edits after a legacy-settings upgrade reach new jobs", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "lr-models-upgrade-"));
    await writeFile(
      runnerSettingsFile(dataDir),
      JSON.stringify({ version: 1, configured: true, defaultModel: "old-model" }),
      "utf8",
    );
    await saveSettings(dataDir, { notify: { enabled: false } });
    await saveSettings(dataDir, { defaultModel: "new-model" });
    const settings = await loadSettings(dataDir);
    assert.equal(settings.stageModels.build, null);
    const resolved = resolveStageModelsForJob(
      testConfig(dataDir),
      settings,
      { repoPath: "/r", branch: "b", promptFile: "/p" },
      "cursor-agent",
    );
    assert.equal(resolved.build, "new-model");
    assert.equal(resolved.review, "new-model");
  });
});
