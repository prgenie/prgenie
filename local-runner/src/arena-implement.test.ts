import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  arenaImplementEnabled,
  buildArenaCandidatePrompt,
  buildArenaSynthesisPrompt,
  candidateProducedOutput,
  CODE_ARENA_CANDIDATE_SECTION,
  CODE_ARENA_SYNTHESIS_SECTION,
  hasArenaSynthesisNote,
  PSTACK_ARENA_ATTRIBUTION,
  resolveArenaCandidateCount,
} from "./arena-implement.js";
import { PROVE_EVIDENCE_HEADING, STUB_PROVE_EVIDENCE_OUTPUT } from "./prove-it-works.js";
import type { JobRecord } from "./types.js";
import type { RunnerSettings } from "./settings.js";

function baseJob(patch: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j1",
    createdAt: "",
    updatedAt: "",
    input: { repoPath: "/r", branch: "feat/x", promptFile: "p.md" },
    stage: "building",
    reviewRound: 0,
    maxRounds: 2,
    model: "m",
    driverId: "cursor-agent",
    worktreePath: null,
    repoSlug: "r",
    prUrl: null,
    prNumber: null,
    prIsDraft: null,
    approveHeadSha: null,
    readyPromotedAt: null,
    linearIssue: null,
    ticketUrl: null,
    title: "t",
    tokenUsage: null,
    ciStatus: null,
    lastVerdict: null,
    error: null,
    logPath: "/tmp/j.log",
    steerQueue: [],
    stopRequested: false,
    dryRun: true,
    archivedAt: null,
    ...patch,
  } as JobRecord;
}

describe("arena implement (#250)", () => {
  it("is disabled by default", () => {
    const settings = {
      arenaImplement: false,
      arenaCandidates: 2,
    } as RunnerSettings;
    assert.equal(settings.arenaImplement, false);
    assert.equal(arenaImplementEnabled(baseJob(), settings), false);
  });

  it("candidate prompt hides rubric and carries MIT attribution", () => {
    const prompt = buildArenaCandidatePrompt("Do the task.");
    assert.match(prompt, /Do the task/);
    assert.ok(prompt.includes(CODE_ARENA_CANDIDATE_SECTION));
    assert.ok(prompt.includes(PSTACK_ARENA_ATTRIBUTION));
    assert.doesNotMatch(prompt, /Rubric \(score each survivor/i);
  });

  it("synthesis prompt lists survivors and includes internal rubric", () => {
    const prompt = buildArenaSynthesisPrompt(
      "Task",
      [{ index: 0, worktreePath: "/wt0", branch: "b0", outputExcerpt: "ok" }],
      [1],
      "feat/main",
      "/wt-main",
    );
    assert.ok(prompt.includes(CODE_ARENA_SYNTHESIS_SECTION));
    assert.match(prompt, /Candidate 0/);
    assert.match(prompt, /Dropouts.*Candidate 1/);
  });

  it("detects candidate dropouts and synthesis notes", () => {
    assert.equal(candidateProducedOutput("   ", "text"), false);
    assert.equal(
      candidateProducedOutput("Implemented feature with tests passing.\n", "text"),
      true,
    );
    const syn = `Done.\n\nARENA: SYNTHESIS\nbase: c0\n\n${STUB_PROVE_EVIDENCE_OUTPUT}`;
    assert.equal(hasArenaSynthesisNote(syn, "text"), true);
    assert.ok(syn.includes(PROVE_EVIDENCE_HEADING));
  });

  it("resolves candidate count from snapshot", () => {
    const settings = { arenaImplement: true, arenaCandidates: 3 } as RunnerSettings;
    const job = baseJob({
      effectiveSnapshot: {
        maxRounds: 2,
        stageModels: { build: "m", review: "m", rereview: "m", fix: "m" },
        baseRef: null,
        watchdogInactivityMs: 1,
        watchdogStageCapMs: 1,
        watchdogRecoveryAttempts: 1,
        arenaCandidates: 4,
      },
    });
    assert.equal(resolveArenaCandidateCount(job, settings), 4);
  });
});
