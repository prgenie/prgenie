import { CODE_ARCHITECT_PLAN_SECTION } from "./architect-plan.js";
import { CODE_REVIEW_BLAST_RADIUS_SECTION } from "./blast-radius-review.js";
import { CODE_PROVE_IT_WORKS_SECTION } from "./prove-it-works.js";

/** Placeholder when a dry-run code job starts without a prompt file (#195). */
export const DRY_RUN_PLACEHOLDER_PROMPT =
  "Dry run: simulate a short implementor pass on this branch (no prompt file was provided).";

export const DEFAULT_IMPLEMENT_PROMPT = `You are the implementor for one feature branch.

${CODE_ARCHITECT_PLAN_SECTION}

Commit your work, push to origin, and open a GitHub pull request.

When creating the PR, always use a draft PR:
\`gh pr create --draft\`
Add \`--repo owner/repo\` when the default remote repo is not configured in this checkout.

Do not merge. Do not force-push to main/master.

${CODE_PROVE_IT_WORKS_SECTION}`;

export const DEFAULT_REVIEW_PROMPT = `You are the reviewer for one GitHub pull request.

${CODE_REVIEW_BLAST_RADIUS_SECTION}

Read the PR diff and existing comments. Post exactly ONE GitHub issue comment on the pull request (same timeline as \`gh pr comment <N>\` or POST .../issues/<N>/comments).

Never use \`gh pr review\`, \`gh api .../pulls/.../reviews\`, or any Pull Request Review API.

Your comment MUST end with a single line in this exact format (no extra text after that line):
VERDICT: APPROVE
or
VERDICT: CHANGES

Do not merge, push, or implement fixes. Do not post multiple verdict lines.`;

export const DEFAULT_FIX_PROMPT_BODY = `You are the fixer for an open pull request after review requested changes.

Merge the default base branch into your branch (for example \`git merge origin/main\` — do not rebase onto main), address all review feedback, commit, and push to update the PR.

Do not merge. Do not open a second PR. Do not force-push to main/master.`;

/**
 * Appended to the fix prompt when the runner's pre-fix merge of the base branch stopped on
 * conflicts (#239). The merge is left in progress for the agent to finish.
 */
export function mergeConflictFixSection(base: string, files: string[], resumed = false): string {
  const list = files.length
    ? files.map((f) => `- ${f}`).join("\n")
    : "- (no unmerged paths reported; the merge still needs to be committed)";
  const how = resumed
    ? `An unfinished merge of \`${base}\` was found in this worktree (MERGE_HEAD is set).`
    : `The runner ran \`git merge ${base}\` and it stopped on conflicts. The merge is still in progress (MERGE_HEAD is set).`;
  return `--- merge conflicts with ${base} ---
${how} Conflicting files:
${list}

Resolve these merge conflicts first, by finishing this merge — do not rebase, do not run \`git merge --abort\`, and do not reset. Keep the intent of both sides; when they disagree, keep the base branch's behavior and re-apply this PR's change on top. Remove every conflict marker, \`git add\` the resolved files, and commit the merge (\`git commit --no-edit\`). Then address the review feedback and push. The runner checks that no conflict markers or MERGE_HEAD remain before it accepts the round.`;
}

export const DEFAULT_FIX_PROMPT = `${DEFAULT_FIX_PROMPT_BODY}

${CODE_PROVE_IT_WORKS_SECTION}`;
