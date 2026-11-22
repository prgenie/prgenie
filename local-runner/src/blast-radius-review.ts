/**
 * Adapted from pstack "Blast radius" (MIT, Copyright (c) 2026 Lauren Tan).
 * @see https://github.com/cursor/plugins/tree/main/pstack/skills/blast-radius
 */
export const PSTACK_BLAST_RADIUS_ATTRIBUTION =
  'Adapted from pstack "Blast radius" (MIT, Copyright (c) 2026 Lauren Tan).';

/** Required headings in the reviewer's single PR comment (before the verdict line). */
export const REVIEW_COMMENT_HEADINGS = [
  "### What changed",
  "### Safety fact",
  "### Risks",
  "### Cleared",
  "### Before merge",
] as const;

export const CODE_REVIEW_BLAST_RADIUS_SECTION = `## Blast radius (required)
Do not only read the PR diff. Find what this change could break somewhere else — callers and consumers, library behavior at the pinned version, timing and teardown, wire formats, feature flags, code a few hops downstream — and prove the one fact safety depends on by running real code.

Listing callers is not enough; grep can do that. A writeup that only sounds right is not enough. Find the one or two facts safety depends on, get each as far as a real run when that is cheap, and say where the proof stopped.

For the **one safety fact** the change depends on, get as far down this list as is cheap and say which step you reached (or **unproven**):
1. You said so — worthless on its own.
2. You pointed at the line — a real \`file:line\`, or the library's own source.
3. You showed the bad case can't happen — walked the failure step by step.
4. You ran it — a script or test that calls the real code.
5. You reproduced it in the running app.

Work past grep: read callee library source at the pinned version, follow wire formats, DB columns, feature flags, and downstream code a symbol search misses. Cite real \`file:line\` for risks; a search that finds nothing is still an answer. Do not invent callers or APIs.

Unproven safety on a risky change should weigh against \`VERDICT: APPROVE\`. A bare caller list or a writeup with no run is not sufficient.

Your single PR comment (before the verdict line) MUST use these exact headings:
${REVIEW_COMMENT_HEADINGS.join("\n")}

Under **### Safety fact**, state the fact, the proof step (1–5 or **unproven**), and paste commands plus output when you reached step 4 or 5.

${PSTACK_BLAST_RADIUS_ATTRIBUTION}`;

export const DOCS_REVIEW_BLAST_RADIUS_SECTION = `## Blast radius (required, proportional)
Beyond the diff, check what the doc change could break: broken links, bad citations, and paths outside the intended doc tree (\`docs/\`, \`policies/\`, \`marketing/\`, or existing doc layout).

Listing paths is not enough. A writeup that only sounds right is not enough. Find the one fact readers will not be misled because of (for example every new URL returns a real page, or every cited path exists in this repo), prove it with real fetches or filesystem checks when cheap, and say where the proof stopped.

For that **one safety fact**, get as far down this list as is cheap and say which step you reached (or **unproven**):
1. You said so — worthless on its own.
2. You pointed at the path or URL — a real \`path:line\` or URL.
3. You showed the bad case can't happen — walked why a broken link or citation cannot occur.
4. You ran it — \`curl\`, \`gh\`, or a script that fetches URLs / checks paths exist.
5. You opened the rendered doc or site.

Unproven safety on a risky change should weigh against \`VERDICT: APPROVE\`. URL lists with no fetch are not sufficient.

Your single PR comment (before the verdict line) MUST use these exact headings:
${REVIEW_COMMENT_HEADINGS.join("\n")}

Under **### Safety fact**, state the fact, the proof step (1–5 or **unproven**), and paste commands plus output when you reached step 4 or 5.

${PSTACK_BLAST_RADIUS_ATTRIBUTION}`;

/** Default runner review prompts include blast radius; custom \`reviewPromptFile\` opts out. */
export function reviewBlastRadiusGateApplies(reviewPromptFile: string | undefined | null): boolean {
  return !reviewPromptFile?.trim();
}

export function promptIncludesBlastRadiusReviewSection(prompt: string): boolean {
  return (
    prompt.includes(CODE_REVIEW_BLAST_RADIUS_SECTION) ||
    prompt.includes(DOCS_REVIEW_BLAST_RADIUS_SECTION)
  );
}

/** Extra context for later review rounds (re-review uses the rereview model). */
export function reviewRoundSupplement(reviewRound: number): string {
  if (reviewRound <= 1) return "";
  return `\nRe-review round ${reviewRound}: re-read the latest diff, prior review comments, and whether fix commits addressed the safety fact and risks.\n`;
}
