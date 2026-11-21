import { reviewerFinalText } from "./review-verdict.js";

/**
 * Adapted from pstack "Prove It Works" (MIT, Copyright (c) 2026 Lauren Tan).
 * @see https://github.com/cursor/plugins/tree/main/pstack/skills/principle-prove-it-works
 */
export const PSTACK_PROVE_IT_WORKS_ATTRIBUTION =
  'Adapted from pstack "Prove It Works" (MIT, Copyright (c) 2026 Lauren Tan).';

/** Agents must end implement/fix output with this heading, then command(s) and output. */
export const PROVE_EVIDENCE_HEADING = "PROVE: EVIDENCE";

/** Minimal evidence block for dry-run tests that hit default fix/implement prompts. */
export const STUB_PROVE_EVIDENCE_OUTPUT = `${PROVE_EVIDENCE_HEADING}
$ echo prgenie-prove-stub && pnpm test --dry-run
prgenie-prove-stub
Tests simulated OK (stub)
`;

const PROVE_EVIDENCE_RE = /PROVE:\s*EVIDENCE\b/i;

/** Minimum substantive bytes after the heading (commands + output). */
const MIN_EVIDENCE_BODY_CHARS = 40;

export const CODE_PROVE_IT_WORKS_SECTION = `## Prove it works
Before you finish this stage, verify against the real artifact: run the tests or feature, read the actual output, and inspect the diff. Proxies do not count — file mtimes, self-reports, cached output, or "it compiles" are not evidence.

When a check fails, suspect your observation method before the system, then fix the problem or report the failure with evidence. A failed check means this stage is not done until it passes or you document the failure with evidence.

Include a section in your final message headed exactly:
${PROVE_EVIDENCE_HEADING}
Under it, paste the command(s) you ran and the relevant output (trim only if enormous). When a PR exists, also add the same evidence to the PR body or a PR comment so the reviewer and fixer can see it.

${PSTACK_PROVE_IT_WORKS_ATTRIBUTION}`;

export const DOCS_PROVE_IT_WORKS_SECTION = `## Prove it works
Before you finish this stage, verify the documentation against reality: fetch or open the sources you cite, and confirm every new or changed file exists at the path you reference. Proxies do not count — unchecked URLs, invented citations, or "I wrote the markdown" are not evidence.

When verification fails, suspect your observation method before dismissing the claim, then fix the doc or report the failure with evidence. A failed check means this stage is not done until it passes or you document the failure with evidence.

Include a section in your final message headed exactly:
${PROVE_EVIDENCE_HEADING}
Under it, paste the commands or fetches you ran, paths you verified, and short excerpts proving the doc matches reality. When a PR exists, also add the same evidence to the PR body or a PR comment.

${PSTACK_PROVE_IT_WORKS_ATTRIBUTION}`;

export function agentStageFinalText(output: string, format: "stream-json" | "text"): string {
  const fromDriver = reviewerFinalText(output, format);
  if (format === "stream-json" && !fromDriver.trim() && output.trim()) return output.trim();
  return fromDriver;
}

export function hasProveEvidence(output: string, format: "stream-json" | "text"): boolean {
  const text = agentStageFinalText(output, format);
  const match = text.match(PROVE_EVIDENCE_RE);
  if (!match || match.index === undefined) return false;
  const after = text.slice(match.index + match[0].length).trim();
  return after.length >= MIN_EVIDENCE_BODY_CHARS;
}

/** Default runner prompts include Prove it works; custom prompt files opt out of the gate. */
export function proveEvidenceGateApplies(promptFile: string | undefined | null): boolean {
  return !promptFile?.trim();
}

/** True when a stage prompt embeds a default Prove it works section (implement/fix/docs). */
export function promptIncludesProveItWorksSection(prompt: string): boolean {
  return (
    prompt.includes(CODE_PROVE_IT_WORKS_SECTION) || prompt.includes(DOCS_PROVE_IT_WORKS_SECTION)
  );
}
