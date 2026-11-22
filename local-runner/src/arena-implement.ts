/**
 * Adapted from pstack "Arena" (MIT, Copyright (c) 2026 Lauren Tan).
 * @see https://github.com/cursor/plugins/tree/main/pstack/skills/arena
 */
import type { JobRecord } from "./types.js";
import type { RunnerSettings } from "./settings.js";
import {
  ARENA_CANDIDATES_MAX,
  ARENA_CANDIDATES_MIN,
  BUILTIN_ARENA_CANDIDATES,
} from "./runner-policy.js";
import { reviewerFinalText } from "./review-verdict.js";
import { hasProveEvidence } from "./prove-it-works.js";

export const PSTACK_ARENA_ATTRIBUTION =
  'Adapted from pstack "Arena" (MIT, Copyright (c) 2026 Lauren Tan).';

export const ARENA_SYNTHESIS_HEADING = "ARENA: SYNTHESIS";

export const CODE_ARENA_CANDIDATE_SECTION = `## Arena candidate
You are **one parallel implementor** for this task. Other models are solving the same problem in separate checkouts — you only see the shared task, not their work or any internal rubric.

Implement the task in **this** checkout. In your final message include a short **Rationale** section: alternatives you considered and what you rejected.

Do not open a pull request from this checkout; the runner synthesizes a single branch later.

${PSTACK_ARENA_ATTRIBUTION}`;

export const CODE_ARENA_SYNTHESIS_SECTION = `## Arena synthesis (runner-internal)
You are the **arena synthesizer**. Several candidates already implemented the same task in separate worktrees (paths below). Candidates did **not** see this rubric.

### Rubric (score each survivor criterion by criterion)
1. **Extensibility** — a future maintainer can extend the design without breaking invariants.
2. **Boundary clarity** — modules, APIs, and file layout have clear responsibilities.
3. **Task fit** — satisfies the stated implement task with minimal incidental scope.
4. **Verification** — the change is testable and includes evidence-friendly hooks.

### Your job
1. Read every surviving candidate checkout end to end (filesystem paths below).
2. Pick the **base** — the design a future maintainer can extend most easily (prefer smaller API / cleaner boundary on ties).
3. **Graft** at most one or two strong parts from each loser into the base **by hand** in **this** checkout (${"`"}cwd given in the run${"`"}) — coherent under one mental model, not a mechanical paste.
4. If candidates **converged** on one shape, note convergence and skip needless grafts.
5. If they **wildly diverged**, say the task was under-specified — do not average designs; leave a clear note for a human re-run.

### Required synthesis note
End your message with a section headed exactly \`${ARENA_SYNTHESIS_HEADING}\` containing:
- **Base:** which candidate and why (rubric criterion by criterion)
- **Grafts:** each graft and its source candidate (or "none — consensus" / "none — divergence")
- **Rejected:** what you declined from losers and why
- **Dropouts:** candidates that produced no output (runner may list these too)
- **Verification:** same \`PROVE: EVIDENCE\` bar as prove-it-works below

Then include **PROVE: EVIDENCE** with real command output for the synthesized result in this checkout.

${PSTACK_ARENA_ATTRIBUTION}`;

export function arenaImplementEnabled(job: JobRecord, settings: RunnerSettings): boolean {
  const snap = job.effectiveSnapshot?.arenaImplement;
  if (snap !== undefined) return Boolean(snap);
  if (job.input.arenaImplement !== undefined) return Boolean(job.input.arenaImplement);
  return Boolean(settings.arenaImplement);
}

export function resolveArenaCandidateCount(job: JobRecord, settings: RunnerSettings): number {
  const snap = job.effectiveSnapshot?.arenaCandidates;
  if (snap !== undefined) return clampArenaCandidates(snap);
  if (job.input.arenaCandidates !== undefined)
    return clampArenaCandidates(job.input.arenaCandidates);
  return clampArenaCandidates(settings.arenaCandidates);
}

export function resolveArenaCandidateModel(
  job: JobRecord,
  index: number,
  fallbackBuild: string,
): string {
  const models = job.input.arenaCandidateModels ?? job.effectiveSnapshot?.arenaCandidateModels;
  const override = models?.[index]?.trim();
  return override || fallbackBuild;
}

export function buildArenaCandidatePrompt(taskPrompt: string): string {
  return `${taskPrompt.trim()}\n\n${CODE_ARENA_CANDIDATE_SECTION}`;
}

export type ArenaSurvivorRef = {
  index: number;
  worktreePath: string;
  branch: string;
  outputExcerpt: string;
};

export function buildArenaSynthesisPrompt(
  taskPrompt: string,
  survivors: ArenaSurvivorRef[],
  dropouts: number[],
  outputBranch: string,
  outputWorktree: string,
): string {
  const survivorLines = survivors
    .map(
      (s) =>
        `- Candidate ${s.index}: branch \`${s.branch}\`, path \`${s.worktreePath}\`${s.outputExcerpt ? ` — excerpt: ${s.outputExcerpt.slice(0, 240).replace(/\s+/g, " ")}` : ""}`,
    )
    .join("\n");
  const dropoutLine =
    dropouts.length > 0 ? dropouts.map((i) => `Candidate ${i}`).join(", ") : "none";
  return `${taskPrompt.trim()}

Target branch for the PR: \`${outputBranch}\`
Synthesis checkout (apply the final tree here): \`${outputWorktree}\`

Surviving candidates:
${survivorLines || "(none)"}

Dropouts (no usable output): ${dropoutLine}

${CODE_ARENA_SYNTHESIS_SECTION}`;
}

export function candidateProducedOutput(
  output: string,
  outputFormat: "stream-json" | "text",
): boolean {
  const text = reviewerFinalText(output, outputFormat).trim();
  if (!text) return false;
  if (/^\[dry-run\]/i.test(text) && text.length < 80) return false;
  return text.length >= 12;
}

export function hasArenaSynthesisNote(
  output: string,
  outputFormat: "stream-json" | "text",
): boolean {
  const text = reviewerFinalText(output, outputFormat);
  return new RegExp(`^${ARENA_SYNTHESIS_HEADING.replace(":", "\\:")}\\s*$`, "im").test(text);
}

export function arenaSynthesisProveOk(
  output: string,
  outputFormat: "stream-json" | "text",
): boolean {
  return hasArenaSynthesisNote(output, outputFormat) && hasProveEvidence(output, outputFormat);
}

export function clampArenaCandidates(n: number): number {
  if (!Number.isFinite(n)) return BUILTIN_ARENA_CANDIDATES;
  const v = Math.trunc(n);
  return Math.min(ARENA_CANDIDATES_MAX, Math.max(ARENA_CANDIDATES_MIN, v));
}

export const ARENA_TOO_FEW_SURVIVORS =
  "Arena implement: fewer than two candidates produced output; cannot synthesize.";
