# Changelog

## 0.1.10 — 2026-11-26

- Extension and site: new lamp logo for the header, favicons, Open Graph image, and Cursor extension icon (#268).
- Plugin: displayName is "PR Genie" for the directory listing (#266); logo assets added for that listing (#267).
- Runner: base-merge conflicts in the fix stage go to the fix agent with conflicting files and git output in the error; continue keeps an unfinished merge instead of aborting it; starting a second job on a branch the runner already owns is refused (#271, #239, #269).
- Runner: `continue_job` accepts `extraRounds: 0` so a continue does not add a review round (still 400 at the cap); HTTP and MCP steer share one policy and can queue steer on failed, stuck, interrupted, stopped, and changes_remaining jobs (#272, #270).

## 0.1.9 — 2026-11-22

- Runner: optional **arena** implement fans out N parallel build candidates, synthesizes one branch with an internal rubric and graft step, verifies `PROVE: EVIDENCE`, and cleans up loser worktrees; off by default (#250).
- Runner: optional adversarial **interrogate** review runs a second challenger model after the primary reviewer; only re-run–proven findings survive, merge by root cause, and the PR gets one combined comment with a single `VERDICT:` (#249).
- Runner: default review prompts require blast-radius review beyond the diff, a provable safety fact (or **unproven**), and structured PR comment sections before `VERDICT:`; custom `reviewPromptFile` opts out (#248).
- Runner: building and fixing run scoped pre-push CI (discovered or settings override) before commit/push; format failures auto-fix on touched files; `PROVE: EVIDENCE` and logs list each command, scope, and result (#255).
- Runner: default implement prompts require a short architect plan (`ARCHITECT: PLAN`) before code or doc work in the same building pass; custom prompt files opt out (#247).
- Runner: default implement and fix prompts require real verification evidence (`PROVE: EVIDENCE` with command output); custom prompt files opt out (#246).

- Runner: scoped CI shim is bundled into the npm package, so jobs no longer fail before push on global or npx installs (#257, #258, #261).
- Repository links point to radiancelux/prgenie again (#245).

## 0.1.6 — 2026-11-08

- Fix `prgenie --version` reporting 0.1.4 in the 0.1.5 package (stale bundle was published).
- Publishing now always rebuilds the bundle (`prepack`) and fails if `runner.cjs --version` differs from `package.json`.

## 0.1.5 — 2026-11-08

- Windows: resolve `cursor-agent` `.ps1` installs for doctor and the default driver; shared spawn via `powershell.exe -File` (#184).
- Windows: `init` prints only the PowerShell token override (Git Bash note optional) (#185).
- CLI: next-step hints detect `npx` on npm 7+ (Node 24 / npm 11 `npm exec`), so `npx -y prgenie@latest init` prints `Next: npx -y prgenie@latest doctor` (#186).
- Doctor: per-OS Cursor CLI install commands when `cursor-agent` is missing (#187).
- Dashboard: session-started jobs stay visible when **Show finished** is off (#188).
- Docs: Windows prerequisites with `winget` install steps (#189).

## 0.1.4 — 2026-11-08

- Onboarding docs: npm vs monorepo happy path, contributing split, Node 22+ enforcement (#161, #162, #164, #114).
- Runner CLI: `config --client claude-desktop` with `--global`/`--npx`; Resend notify warnings in dashboard/Setup (#162, #164).
- Windows `init` prints the PowerShell token line; plugin-style commands get monorepo CLI hints (#161, #164).
- Tests reject Node <22 via `ensure-node-version`.

## 0.1.3 — 2026-11-08

- Compute jobs (#167).
- Settings UI exposes the v2 runner policy and cleaner onboarding copy (#145, #163).
- New agent form keeps the prompt file input (#155).
- Job start preflight, failed-worktree cleanup, and dry-run mode (#156–#158).
- CLI polish: clearer `serve` errors, better `doctor`, smoother first run, and next-step hints that use `npx -y prgenie@latest …` when run through npx (#159, #160, #165).

## 0.1.2 — 2026-11-07

- Publishable `prgenie` npm package with `prgenie` CLI (`mcp`, `serve`, `init`, `doctor`).
- Stdio MCP exposes runner tools (jobs + settings); shared job store lock for concurrent serve/MCP.
- Copy-paste MCP client setup in README; release workflow prepared (publish is manual).
- Every stdio/HTTP MCP reply carries `jsonrpc: "2.0"` and echoes the request id; `ping` is answered, malformed JSON gets a `-32700` parse error, and the stdio server exits once the client closes stdin.
- `continue_job` MCP tool; `prgenie config --client claude-code`; config snippets use the `prgenie-runner` server id.
- MIT `LICENSE` ships in the tarball.
