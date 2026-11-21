---
name: prgenie-runner
description: Use when you want an agent to implement a GitHub issue or brief end to end on your machine with PR Genie (implement, open a PR, review, fix, watch CI) and hand back a CI-green PR for you to merge.
---

# PR Genie runner

[PR Genie](https://prgenie.ai) is a local runner (`npm` package `prgenie`). It takes a brief, has `cursor-agent` implement it in a git worktree, opens a GitHub PR, runs review and fix rounds, and watches CI. Nothing merges until the human says so.

## Setup (once per machine)

1. Install Node.js 22+, git, the GitHub CLI (`gh auth login`) and the Cursor CLI (`cursor-agent login`).
2. Run `npx -y prgenie init`, then `npx -y prgenie doctor` and fix anything it reports.
3. Add the MCP server `prgenie-runner` (this repo's `mcp.json`, or print it with `npx -y prgenie config --client cursor`).

## Running a job

1. Write the brief: the issue link, acceptance criteria, files to touch, and `Closes #N` for the PR body.
2. Call `start_job` with `repoPath` (a local git checkout), a fresh branch name, the prompt, and `maxRounds` (2-3 is typical). Use `dryRun: true` the first time on a new repo.
3. Check progress with `get_job` / `list_jobs`. Report milestones only: PR opened, review cleared, CI green, or stuck.
4. If review isn't clear after the rounds run out, read the findings and either `continue_job` for another round or rewrite the brief.
5. If a job is stuck, read its logs, `stop_job`, and restart or `archive_job` it.
6. When review is clear and CI is green, give the human the PR link and head sha. Merge only on their explicit OK.
7. After merge, `archive_job` the finished job so its CI watcher stops polling GitHub.

## Rules

- Never force-push or rebase a pushed branch; resolve conflicts by merging the default branch in.
- Never print the runner token (`~/.prgenie/local-runner/runner.token`).
- A new job on a branch fails if an old job's worktree still holds that branch; remove the clean old worktree first.
- Optional dashboard: `npx -y prgenie serve` (default http://127.0.0.1:9473).
- Supported today: JavaScript/TypeScript repos with pnpm or npm workspaces. Docs-only jobs can use `jobType: "docs"`.
