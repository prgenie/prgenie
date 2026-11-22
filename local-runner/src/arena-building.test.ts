import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runArenaBuildingStage } from "./arena-building.js";
import type { JobRecord } from "./types.js";
import type { RunnerSettings } from "./settings.js";
import { ARENA_SYNTHESIS_HEADING } from "./arena-implement.js";
import { STUB_PROVE_EVIDENCE_OUTPUT } from "./prove-it-works.js";

const baseSettings = {
  arenaImplement: true,
  arenaCandidates: 2,
} as RunnerSettings;

function baseJob(): JobRecord {
  return {
    id: "job-arena",
    input: { repoPath: "/repo", branch: "feat/arena", promptFile: "t.md" },
    effectiveSnapshot: {
      maxRounds: 2,
      stageModels: { build: "m", review: "m", rereview: "m", fix: "m" },
      baseRef: null,
      watchdogInactivityMs: 1,
      watchdogStageCapMs: 1,
      watchdogRecoveryAttempts: 1,
      arenaImplement: true,
      arenaCandidates: 2,
    },
  } as JobRecord;
}

describe("arena building stage (#250)", () => {
  it("fails clearly when fewer than two candidates survive", async () => {
    const logs: string[] = [];
    const res = await runArenaBuildingStage({
      job: baseJob(),
      settings: baseSettings,
      repoRoot: "/repo",
      mainWorktree: "/wt-main",
      taskPrompt: "task",
      outputFormat: "text",
      buildModel: "m",
      onLog: async (line) => {
        logs.push(line);
      },
      testEnsureCandidateWorktree: async (index) => `/wt-c${index}`,
      testSkipCleanup: true,
      runCandidate: async (index) =>
        index === 0
          ? { code: 0, output: "Candidate 0 built the feature completely.\n" }
          : { code: 1, output: "" },
      runSynthesis: async () => ({ code: 0, output: "unused" }),
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /fewer than two/i);
    assert.ok(logs.some((l) => /dropout/i.test(l)));
  });

  it("cleans up candidates and requires synthesis note + prove", async () => {
    let synthesisCwd = "";
    const res = await runArenaBuildingStage({
      job: baseJob(),
      settings: baseSettings,
      repoRoot: "/repo",
      mainWorktree: "/wt-main",
      taskPrompt: "task",
      outputFormat: "text",
      buildModel: "m",
      onLog: async () => undefined,
      testEnsureCandidateWorktree: async (index) => `/wt-c${index}`,
      testSkipCleanup: true,
      runCandidate: async (_i, cwd) => ({ code: 0, output: `Built in ${cwd}\nwith rationale.\n` }),
      runSynthesis: async (cwd, prompt) => {
        synthesisCwd = cwd;
        assert.match(prompt, /Arena synthesis/);
        return {
          code: 0,
          output: `${ARENA_SYNTHESIS_HEADING}\nbase: 0\n\n${STUB_PROVE_EVIDENCE_OUTPUT}`,
        };
      },
    });
    assert.equal(res.ok, true);
    assert.equal(synthesisCwd, "/wt-main");
  });
});
