import { appendFile, mkdir, rm, access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  arenaCandidateBranch,
  arenaCandidateWorktreeDir,
  cursorWorktreeDir,
  managedWorktreesRoot,
  repoSlugFromPath,
} from "./paths.js";
import { git, type GhResult } from "./github.js";
import { baseRefProbeOrder, resolveWorktreeBaseRef, type GitFn } from "./repo-base.js";
import type { RunnerSettings } from "./settings.js";
import { listJobs, patchJob } from "./store.js";
import type { JobRecord } from "./types.js";

export type WorktreeEnsureResult = {
  path: string;
  baseRef: string;
  baseSha: string;
};

export type WorktreeOpts = {
  dataDir?: string;
  gitImpl?: GitFn;
};

export function worktreePathsEqual(a: string, b: string): boolean {
  const na = path.resolve(a.trim());
  const nb = path.resolve(b.trim());
  if (process.platform === "win32") {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

/** Parse `git worktree list --porcelain` and return the checkout path for a local branch, if any. */
export function parseWorktreePathForBranch(porcelain: string, branch: string): string | null {
  const branchRef = `refs/heads/${branch.trim()}`;
  let currentPath: string | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ") && currentPath) {
      const ref = line.slice("branch ".length).trim();
      if (ref === branchRef) return currentPath;
    }
  }
  return null;
}

export async function bestEffortFetchOrigin(repoPath: string, gitImpl: GitFn = git): Promise<void> {
  await gitImpl(repoPath, ["fetch", "origin"]).catch(() => undefined);
}

export async function assertSafeToResetBranchAtBase(
  repoPath: string,
  branch: string,
  base: string,
  gitImpl: GitFn = git,
): Promise<void> {
  const exists = await gitImpl(repoPath, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (exists.code !== 0) return;
  const count = await gitImpl(repoPath, ["rev-list", "--count", `${base.trim()}..${branch}`]);
  if (count.code !== 0) return;
  const n = Number(count.stdout.trim());
  if (n > 0) {
    throw new Error(
      `refusing to reset local branch "${branch}": it has ${n} commit(s) not reachable from ${base.trim()}. Use a fresh branch name.`,
    );
  }
}

export async function cloneRepo(remote: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  const parent = path.dirname(dest);
  const name = path.basename(dest);
  const r = await git(parent, ["clone", remote, name]);
  if (r.code !== 0) {
    throw new Error(`git clone failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

async function enrichWorktreeAddFailure(
  repoPath: string,
  branch: string,
  rawErr: string,
  dataDir?: string,
): Promise<string> {
  const used = rawErr.match(/already used by worktree at '([^']+)'/i);
  if (!used) return `git worktree add failed: ${rawErr || "no base ref found"}`;
  const wtPath = used[1];
  let hint = `git worktree remove ${wtPath}`;
  if (dataDir) {
    const jobs = await listJobs(dataDir);
    const owner = jobs.find(
      (j) => j.worktreePath?.trim() && worktreePathsEqual(j.worktreePath, wtPath),
    );
    if (owner) {
      hint = `archive job ${owner.id} on the dashboard, or \`git worktree remove ${wtPath}\` and \`git branch -D ${branch}\``;
    }
  }
  return `git worktree add failed: branch "${branch}" is already checked out at ${wtPath} — ${hint}`;
}

/** Finished jobs whose worktree may be released so a follow-up can check out the same branch (#219). */
const RELEASABLE_TERMINAL_STAGES = new Set(["approved", "stopped", "failed", "stuck"]);

function pathIsStrictlyInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Same boundary as worktree cleanup: never remove the repo checkout or a path outside the managed root. */
function worktreeRemovalBlocked(holderPath: string, repoPath: string): boolean {
  const holder = path.resolve(holderPath);
  const repo = path.resolve(repoPath);
  if (holder === repo || pathIsStrictlyInside(holder, repo)) return true;
  return !pathIsStrictlyInside(path.resolve(managedWorktreesRoot()), holder);
}

function heldWorktreeError(
  branch: string,
  holderPath: string,
  job: { id: string; stage: string },
  detail: string,
  next: string,
): string {
  return `branch "${branch}" is already checked out at ${holderPath} by ${job.stage} job ${job.id} (${detail}). ${next}`;
}

function jobHoldsWorktree(
  job: JobRecord,
  holderPath: string,
  branch: string,
  repoPath: string,
): boolean {
  return Boolean(
    job.worktreePath?.trim() &&
    worktreePathsEqual(job.worktreePath, holderPath) &&
    job.input.branch.trim() === branch.trim() &&
    job.input.repoPath?.trim() &&
    worktreePathsEqual(job.input.repoPath, repoPath),
  );
}

/**
 * A terminal job keeps its worktree, and git will not check that branch out again.
 * Release it when it is clean and HEAD matches origin/<branch>; otherwise refuse.
 */
async function releaseCleanPushedTerminalWorktree(
  repoPath: string,
  branch: string,
  ownPath: string,
  jobId: string,
  opts?: WorktreeOpts,
): Promise<void> {
  if (!opts?.dataDir) return;
  const gitImpl = opts.gitImpl ?? git;
  const listed = await gitImpl(repoPath, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) return;
  const holderPath = parseWorktreePathForBranch(listed.stdout, branch);
  if (!holderPath || worktreePathsEqual(holderPath, ownPath)) return;

  const heldErr = `fatal: '${branch}' is already used by worktree at '${holderPath}'`;
  const refuse = () => enrichWorktreeAddFailure(repoPath, branch, heldErr, opts.dataDir);
  if (worktreeRemovalBlocked(holderPath, repoPath)) {
    throw new Error(await refuse());
  }

  const owner = (await listJobs(opts.dataDir)).find((job) =>
    jobHoldsWorktree(job, holderPath, branch, repoPath),
  );
  if (
    !owner ||
    owner.id === jobId ||
    owner.archivedAt ||
    owner.worker ||
    !RELEASABLE_TERMINAL_STAGES.has(owner.stage)
  ) {
    throw new Error(await refuse());
  }

  const keep = "Commit, push, or remove that worktree before starting another job on this branch.";
  const status = await gitImpl(holderPath, ["status", "--porcelain"]);
  if (status.code !== 0 || status.stdout.trim().length > 0) {
    const detail =
      status.code !== 0
        ? status.stderr.trim() || status.stdout.trim() || "could not read worktree status"
        : "uncommitted changes";
    throw new Error(heldWorktreeError(branch, holderPath, owner, detail, keep));
  }

  const fetched = await gitImpl(repoPath, ["fetch", "origin", branch]);
  if (fetched.code !== 0) {
    const detail = (fetched.stderr || fetched.stdout).trim().slice(0, 180) || "git fetch failed";
    throw new Error(
      heldWorktreeError(
        branch,
        holderPath,
        owner,
        `could not verify origin/${branch}: ${detail}`,
        keep,
      ),
    );
  }

  const head = await gitImpl(holderPath, ["rev-parse", "HEAD"]);
  const remote = await gitImpl(repoPath, ["rev-parse", "--verify", `origin/${branch}`]);
  const headSha = head.code === 0 ? head.stdout.trim() : "";
  const remoteSha = remote.code === 0 ? remote.stdout.trim() : "";
  if (!headSha || !remoteSha || headSha !== remoteSha) {
    let detail = !remoteSha
      ? `origin/${branch} does not exist`
      : !headSha
        ? head.stderr.trim() || "could not read HEAD"
        : `HEAD does not match origin/${branch}`;
    if (headSha && remoteSha && headSha !== remoteSha) {
      const ahead = await gitImpl(holderPath, ["merge-base", "--is-ancestor", remoteSha, headSha]);
      if (ahead.code === 0) detail = `HEAD is ahead of origin/${branch}`;
    }
    throw new Error(heldWorktreeError(branch, holderPath, owner, detail, keep));
  }

  const removed = await gitImpl(repoPath, ["worktree", "remove", holderPath]);
  if (removed.code !== 0) {
    const detail = removed.stderr.trim() || removed.stdout.trim() || "git worktree remove failed";
    throw new Error(heldWorktreeError(branch, holderPath, owner, detail, keep));
  }
  await patchJob(opts.dataDir, owner.id, (fresh) => {
    fresh.worktreePath = null;
  });
  if (owner.logPath.trim()) {
    await appendFile(
      owner.logPath,
      `[worktree] released ${holderPath} (clean, matches origin/${branch}) for job ${jobId}\n`,
      "utf8",
    ).catch(() => undefined);
  }
}

async function resolveBaseTip(
  repoPath: string,
  base: string,
  gitImpl: GitFn,
): Promise<{ baseRef: string; baseSha: string } | null> {
  const probe = await gitImpl(repoPath, ["rev-parse", "--verify", base.trim()]);
  if (probe.code !== 0) return null;
  return { baseRef: base.trim(), baseSha: probe.stdout.trim() };
}

export async function branchHasNoCommitsBeyondBase(
  cwd: string,
  settings?: RunnerSettings,
  gitImpl: (cwd: string, args: string[]) => Promise<GhResult> = git,
): Promise<boolean> {
  const bases = settings ? baseRefProbeOrder(settings) : ["origin/main", "origin/master", "main"];
  for (const base of bases) {
    const probe = await gitImpl(cwd, ["rev-parse", "--verify", base]);
    if (probe.code !== 0) continue;
    const count = await gitImpl(cwd, ["rev-list", "--count", `${base.trim()}..HEAD`]);
    if (count.code !== 0) return false;
    return Number(count.stdout.trim()) === 0;
  }
  return false;
}

export async function deleteLocalBranch(
  repoPath: string,
  branch: string,
  gitImpl: (cwd: string, args: string[]) => Promise<GhResult> = git,
): Promise<void> {
  if (!branch.trim()) return;
  await gitImpl(repoPath, ["branch", "-D", branch]).catch(() => undefined);
}

export async function ensureWorktree(
  repoPath: string,
  jobId: string,
  branch: string,
  settings?: RunnerSettings,
  opts?: WorktreeOpts,
): Promise<WorktreeEnsureResult> {
  const gitImpl = opts?.gitImpl ?? git;
  const slug = repoSlugFromPath(repoPath);
  const wt = cursorWorktreeDir(slug, jobId);
  await mkdir(path.dirname(wt), { recursive: true });
  const exists = await gitImpl(repoPath, ["worktree", "list", "--porcelain"]);
  const listed = exists.stdout.split("\n").some((line) => {
    if (!line.startsWith("worktree ")) return false;
    const p = line.slice("worktree ".length).trim();
    return worktreePathsEqual(p, wt);
  });
  let onDisk = false;
  try {
    await access(wt);
    onDisk = true;
  } catch {
    onDisk = false;
  }
  if (listed && onDisk) {
    const bases = settings ? baseRefProbeOrder(settings) : ["origin/main", "origin/master", "main"];
    for (const base of bases) {
      const tip = await resolveBaseTip(repoPath, base, gitImpl);
      if (tip) return { path: wt, ...tip };
    }
    if (settings) {
      const resolved = await resolveWorktreeBaseRef(repoPath, settings, gitImpl);
      const tip = await resolveBaseTip(repoPath, resolved.ref, gitImpl);
      if (tip) return { path: wt, ...tip };
    }
    return { path: wt, baseRef: "origin/main", baseSha: "" };
  }
  if (listed && !onDisk) {
    await gitImpl(repoPath, ["worktree", "remove", "--force", wt]).catch(() => undefined);
    await rm(wt, { recursive: true, force: true }).catch(() => undefined);
  }

  await bestEffortFetchOrigin(repoPath, gitImpl);
  await releaseCleanPushedTerminalWorktree(repoPath, branch, wt, jobId, opts);

  const remoteRef = `origin/${branch}`;
  const remoteProbe = await gitImpl(repoPath, ["rev-parse", "--verify", remoteRef]);
  if (remoteProbe.code === 0) {
    const remoteSha = remoteProbe.stdout.trim();
    const add = await gitImpl(repoPath, ["worktree", "add", "-B", branch, wt, remoteRef]);
    if (add.code === 0) {
      const defaultBase = settings
        ? (await resolveWorktreeBaseRef(repoPath, settings, gitImpl)).ref
        : "origin/main";
      const baseTip = await resolveBaseTip(repoPath, defaultBase, gitImpl);
      return {
        path: wt,
        baseRef: baseTip?.baseRef ?? defaultBase,
        baseSha: baseTip?.baseSha ?? remoteSha,
      };
    }
    const remoteAddErr = add.stderr.trim() || add.stdout.trim();
    throw new Error(await enrichWorktreeAddFailure(repoPath, branch, remoteAddErr, opts?.dataDir));
  }

  const bases = settings ? baseRefProbeOrder(settings) : ["origin/main", "origin/master", "main"];
  let lastErr = "";
  for (const base of bases) {
    const probe = await gitImpl(repoPath, ["rev-parse", "--verify", base]);
    if (probe.code !== 0) continue;
    await assertSafeToResetBranchAtBase(repoPath, branch, base, gitImpl);
    const add = await gitImpl(repoPath, ["worktree", "add", "-B", branch, wt, base]);
    if (add.code === 0) {
      const tip = await resolveBaseTip(repoPath, base, gitImpl);
      return { path: wt, ...(tip ?? { baseRef: base, baseSha: probe.stdout.trim() }) };
    }
    lastErr = add.stderr.trim() || add.stdout.trim();
  }
  if (settings) {
    const resolved = await resolveWorktreeBaseRef(repoPath, settings, gitImpl);
    await assertSafeToResetBranchAtBase(repoPath, branch, resolved.ref, gitImpl);
    const add = await gitImpl(repoPath, ["worktree", "add", "-B", branch, wt, resolved.ref]);
    if (add.code === 0) {
      const tip = await resolveBaseTip(repoPath, resolved.ref, gitImpl);
      if (tip) return { path: wt, ...tip };
      return { path: wt, baseRef: resolved.ref, baseSha: "" };
    }
    lastErr = add.stderr.trim() || add.stdout.trim();
  }
  throw new Error(await enrichWorktreeAddFailure(repoPath, branch, lastErr, opts?.dataDir));
}

/** One isolated checkout per arena implement candidate (#250). */
export async function ensureArenaCandidateWorktree(
  repoPath: string,
  jobId: string,
  candidateIndex: number,
  jobBranch: string,
  settings?: RunnerSettings,
  opts?: WorktreeOpts,
): Promise<WorktreeEnsureResult> {
  const branch = arenaCandidateBranch(jobBranch, candidateIndex);
  const slug = repoSlugFromPath(repoPath);
  const wt = arenaCandidateWorktreeDir(slug, jobId, candidateIndex);
  const syntheticJobId = `${jobId}-arena-${candidateIndex}`;
  await mkdir(path.dirname(wt), { recursive: true });
  const gitImpl = opts?.gitImpl ?? git;
  const exists = await gitImpl(repoPath, ["worktree", "list", "--porcelain"]);
  const listed = exists.stdout.split("\n").some((line) => {
    if (!line.startsWith("worktree ")) return false;
    const p = line.slice("worktree ".length).trim();
    return worktreePathsEqual(p, wt);
  });
  let onDisk = false;
  try {
    await access(wt);
    onDisk = true;
  } catch {
    onDisk = false;
  }
  if (listed && onDisk) {
    const bases = settings ? baseRefProbeOrder(settings) : ["origin/main", "origin/master", "main"];
    for (const base of bases) {
      const tip = await resolveBaseTip(repoPath, base, gitImpl);
      if (tip) return { path: wt, ...tip };
    }
    return { path: wt, baseRef: "origin/main", baseSha: "" };
  }
  if (listed && !onDisk) {
    await gitImpl(repoPath, ["worktree", "remove", "--force", wt]).catch(() => undefined);
    await rm(wt, { recursive: true, force: true }).catch(() => undefined);
  }
  await bestEffortFetchOrigin(repoPath, gitImpl);
  await releaseCleanPushedTerminalWorktree(repoPath, branch, wt, syntheticJobId, opts);
  const bases = settings ? baseRefProbeOrder(settings) : ["origin/main", "origin/master", "main"];
  let lastErr = "";
  for (const base of bases) {
    const probe = await gitImpl(repoPath, ["rev-parse", "--verify", base]);
    if (probe.code !== 0) continue;
    await assertSafeToResetBranchAtBase(repoPath, branch, base, gitImpl);
    const add = await gitImpl(repoPath, ["worktree", "add", "-B", branch, wt, base]);
    if (add.code === 0) {
      const tip = await resolveBaseTip(repoPath, base, gitImpl);
      return { path: wt, ...(tip ?? { baseRef: base, baseSha: probe.stdout.trim() }) };
    }
    lastErr = add.stderr.trim() || add.stdout.trim();
  }
  if (settings) {
    const resolved = await resolveWorktreeBaseRef(repoPath, settings, gitImpl);
    await assertSafeToResetBranchAtBase(repoPath, branch, resolved.ref, gitImpl);
    const add = await gitImpl(repoPath, ["worktree", "add", "-B", branch, wt, resolved.ref]);
    if (add.code === 0) {
      const tip = await resolveBaseTip(repoPath, resolved.ref, gitImpl);
      if (tip) return { path: wt, ...tip };
      return { path: wt, baseRef: resolved.ref, baseSha: "" };
    }
    lastErr = add.stderr.trim() || add.stdout.trim();
  }
  throw new Error(await enrichWorktreeAddFailure(repoPath, branch, lastErr, opts?.dataDir));
}

export async function removeArenaCandidateWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  opts?: { gitImpl?: GitFn },
): Promise<void> {
  await removeWorktree(repoPath, worktreePath, {
    branch,
    deleteBranch: true,
    gitImpl: opts?.gitImpl,
  });
}

/** Reuse an existing job worktree when present; otherwise add one at `origin/<branch>`. */
export async function ensureContinueWorktree(
  repoPath: string,
  jobId: string,
  branch: string,
  existingPath: string | null,
  settings?: RunnerSettings,
  opts?: WorktreeOpts,
): Promise<{ path: string; reused: boolean }> {
  const gitImpl = opts?.gitImpl ?? git;
  const slug = repoSlugFromPath(repoPath);
  const expectedWt = cursorWorktreeDir(slug, jobId);
  const wt = existingPath?.trim() || expectedWt;

  const holderPath = parseWorktreePathForBranch(
    (await gitImpl(repoPath, ["worktree", "list", "--porcelain"])).stdout,
    branch,
  );
  if (holderPath) {
    const isOwn =
      (existingPath?.trim() && worktreePathsEqual(holderPath, existingPath)) ||
      worktreePathsEqual(holderPath, expectedWt) ||
      worktreePathsEqual(holderPath, wt);
    if (isOwn) {
      try {
        await access(holderPath);
        return { path: holderPath, reused: true };
      } catch {
        /* recreate below */
      }
    } else {
      throw new Error(
        await enrichWorktreeAddFailure(
          repoPath,
          branch,
          `fatal: '${branch}' is already used by worktree at '${holderPath}'`,
          opts?.dataDir,
        ),
      );
    }
  }

  if (existingPath?.trim()) {
    try {
      await access(existingPath);
      const listed = await gitImpl(repoPath, ["worktree", "list", "--porcelain"]);
      const onList = listed.stdout.split("\n").some((line) => {
        if (!line.startsWith("worktree ")) return false;
        return worktreePathsEqual(line.slice("worktree ".length).trim(), existingPath);
      });
      if (onList) {
        return { path: existingPath, reused: true };
      }
    } catch {
      /* recreate below */
    }
  }
  const listed = await gitImpl(repoPath, ["worktree", "list", "--porcelain"]);
  const onList = listed.stdout.split("\n").some((line) => {
    if (!line.startsWith("worktree ")) return false;
    return worktreePathsEqual(line.slice("worktree ".length).trim(), wt);
  });
  if (onList) {
    try {
      await access(wt);
      return { path: wt, reused: true };
    } catch {
      await gitImpl(repoPath, ["worktree", "remove", "--force", wt]).catch(() => undefined);
      await rm(wt, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  await mkdir(path.dirname(wt), { recursive: true });
  await bestEffortFetchOrigin(repoPath, gitImpl);
  const remoteRef = `origin/${branch}`;
  const probe = await gitImpl(repoPath, ["rev-parse", "--verify", remoteRef]);
  if (probe.code === 0) {
    const add = await gitImpl(repoPath, ["worktree", "add", "-B", branch, wt, remoteRef]);
    if (add.code === 0) return { path: wt, reused: false };
    throw new Error(
      await enrichWorktreeAddFailure(
        repoPath,
        branch,
        add.stderr.trim() || add.stdout.trim(),
        opts?.dataDir,
      ),
    );
  }
  const pathFromEnsure = await ensureWorktree(repoPath, jobId, branch, settings, opts);
  return { path: pathFromEnsure.path, reused: false };
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  opts?: { branch?: string; deleteBranch?: boolean; gitImpl?: GitFn },
): Promise<void> {
  const gitImpl = opts?.gitImpl ?? git;
  await gitImpl(repoPath, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
  await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  if (opts?.deleteBranch && opts.branch?.trim()) {
    await deleteLocalBranch(repoPath, opts.branch, gitImpl);
  }
}

export type GitOperationInProgress = "rebase" | "merge" | "cherry-pick";

/** Detect an unfinished rebase, merge, or cherry-pick before handing the worktree to an agent. */
export async function detectGitOperationInProgress(
  worktree: string,
  gitImpl: GitFn = git,
): Promise<GitOperationInProgress | null> {
  const checks: Array<{ ref: string; op: GitOperationInProgress }> = [
    { ref: "REBASE_HEAD", op: "rebase" },
    { ref: "MERGE_HEAD", op: "merge" },
    { ref: "CHERRY_PICK_HEAD", op: "cherry-pick" },
  ];
  for (const { ref, op } of checks) {
    const probe = await gitImpl(worktree, ["rev-parse", "-q", "--verify", ref]);
    if (probe.code === 0) return op;
  }
  return null;
}

export async function abortGitOperationInProgress(
  worktree: string,
  op: GitOperationInProgress,
  gitImpl: GitFn = git,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cmd =
    op === "rebase"
      ? ["rebase", "--abort"]
      : op === "merge"
        ? ["merge", "--abort"]
        : ["cherry-pick", "--abort"];
  const res = await gitImpl(worktree, cmd);
  if (res.code === 0) return { ok: true };
  const err = res.stderr.trim() || res.stdout.trim() || `git ${cmd.join(" ")} failed`;
  return { ok: false, error: err };
}

const MERGE_OUTPUT_CAP = 1500;

/** Trim and cap combined git stdout/stderr so job errors stay readable. */
export function capGitOutput(stdout: string, stderr: string, cap = MERGE_OUTPUT_CAP): string {
  const text = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}… (truncated)`;
}

/** Paths git still reports as unmerged (conflicted) in the worktree. */
export async function listUnmergedFiles(worktree: string, gitImpl: GitFn = git): Promise<string[]> {
  const res = await gitImpl(worktree, ["diff", "--name-only", "--diff-filter=U"]);
  if (res.code !== 0) return [];
  return [
    ...new Set(
      res.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}

export type MergeOntoBaseResult =
  | { status: "up_to_date"; base: string }
  | { status: "merged"; base: string }
  /**
   * The merge stopped on conflicts and was left in progress (MERGE_HEAD set) so an agent can
   * resolve it. `resumed` is true when an earlier unfinished merge was found instead of started.
   */
  | { status: "conflict"; base: string; files: string[]; output: string; resumed: boolean };

/** Thrown when merging the base fails for a reason other than resolvable conflicts. */
export class MergeOntoBaseError extends Error {
  constructor(
    message: string,
    readonly base: string,
    readonly files: string[],
  ) {
    super(message);
    this.name = "MergeOntoBaseError";
  }
}

export function formatMergeFailure(
  base: string,
  files: string[],
  stdout: string,
  stderr: string,
): string {
  const parts = [`git merge ${base} failed`];
  if (files.length) parts.push(`conflicting files: ${files.join(", ")}`);
  const out = capGitOutput(stdout, stderr);
  parts.push(out ? `git output: ${out}` : "git produced no output");
  return parts.join("; ");
}

/**
 * Merge the default base into the branch (never rebase). On conflicts, leave the merge in
 * progress and report the conflicting paths instead of throwing, so the fix agent can resolve
 * them (#239). An already-unfinished merge is reported the same way rather than merged again.
 */
export async function mergeOntoBaseOrConflict(
  worktree: string,
  settings?: RunnerSettings,
  gitImpl: GitFn = git,
): Promise<MergeOntoBaseResult> {
  const order = settings ? baseRefProbeOrder(settings) : ["origin/main", "origin/master", "main"];
  const pending = await gitImpl(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (pending.code === 0) {
    const files = await listUnmergedFiles(worktree, gitImpl);
    return {
      status: "conflict",
      base: order[0] ?? "origin/main",
      files,
      output: "",
      resumed: true,
    };
  }
  await gitImpl(worktree, ["fetch", "origin"]);
  for (const base of order) {
    const probe = await gitImpl(worktree, ["rev-parse", "--verify", base]);
    if (probe.code !== 0) continue;
    const baseSha = probe.stdout.trim();
    const contains = await gitImpl(worktree, ["merge-base", "--is-ancestor", baseSha, "HEAD"]);
    if (contains.code === 0) return { status: "up_to_date", base };
    const mg = await gitImpl(worktree, ["merge", "--no-edit", base]);
    if (mg.code === 0) return { status: "merged", base };
    const files = await listUnmergedFiles(worktree, gitImpl);
    const inProgress = await gitImpl(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    if (files.length > 0 && inProgress.code === 0) {
      return {
        status: "conflict",
        base,
        files,
        output: capGitOutput(mg.stdout, mg.stderr),
        resumed: false,
      };
    }
    throw new MergeOntoBaseError(
      formatMergeFailure(base, files, mg.stdout, mg.stderr),
      base,
      files,
    );
  }
  throw new Error("Could not find origin/main or origin/master for merge");
}

/**
 * Update the branch tip onto the default base with merge (not rebase) so a normal push works.
 * Throws on conflicts with the conflicting files and git output in the message; the merge is
 * left in progress. Callers that can hand conflicts to an agent use {@link mergeOntoBaseOrConflict}.
 */
export async function mergeOntoBase(
  worktree: string,
  settings?: RunnerSettings,
  gitImpl: GitFn = git,
): Promise<void> {
  const res = await mergeOntoBaseOrConflict(worktree, settings, gitImpl);
  if (res.status === "conflict") {
    throw new MergeOntoBaseError(
      formatMergeFailure(res.base, res.files, res.output, ""),
      res.base,
      res.files,
    );
  }
}

// Only the <<<<<<< / >>>>>>> markers: a bare "=======" line is also a Markdown heading underline.
const CONFLICT_MARKER_RE = /^(?:<{7}|>{7})(?: |$)/m;

/** True when text still contains git conflict markers. */
export function hasConflictMarkers(text: string): boolean {
  return CONFLICT_MARKER_RE.test(text);
}

export type MergeResolutionCheck = { ok: true } | { ok: false; reason: string; files: string[] };

/**
 * After an agent was asked to resolve merge conflicts: no merge may be left in progress, no path
 * may still be unmerged, and none of the previously conflicted files may keep conflict markers.
 */
export async function verifyMergeResolved(
  worktree: string,
  conflictedFiles: string[],
  opts: { gitImpl?: GitFn; readFileImpl?: (p: string) => Promise<string> } = {},
): Promise<MergeResolutionCheck> {
  const gitImpl = opts.gitImpl ?? git;
  const readImpl = opts.readFileImpl ?? ((p: string) => readFile(p, "utf8"));
  const unmerged = await listUnmergedFiles(worktree, gitImpl);
  if (unmerged.length) {
    return { ok: false, reason: "files are still unmerged", files: unmerged };
  }
  const withMarkers: string[] = [];
  for (const f of conflictedFiles) {
    let text: string;
    try {
      text = await readImpl(path.join(worktree, f));
    } catch {
      continue; // deleted while resolving
    }
    if (hasConflictMarkers(text)) withMarkers.push(f);
  }
  if (withMarkers.length) {
    return { ok: false, reason: "conflict markers remain", files: withMarkers };
  }
  const pending = await gitImpl(worktree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (pending.code === 0) {
    return {
      ok: false,
      reason: "the merge was not committed (MERGE_HEAD is still set)",
      files: [],
    };
  }
  return { ok: true };
}

/** @deprecated Use mergeOntoBase — rebasing rewrites pushed history. */
export async function rebaseOntoBase(worktree: string, settings?: RunnerSettings): Promise<void> {
  return mergeOntoBase(worktree, settings);
}
