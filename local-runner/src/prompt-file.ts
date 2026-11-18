import { readFile } from "node:fs/promises";
import path from "node:path";
import { git } from "./github.js";
import { baseRefProbeOrder, resolveWorktreeBaseRef } from "./repo-base.js";
import type { RunnerSettings } from "./settings.js";
import { ValidationError } from "./validation-error.js";
import { bestEffortFetchOrigin } from "./worktree.js";

/** Where a relative prompt path is resolved. Worktree wins so branch edits are picked up. */
export type PromptFileBases = {
  worktreePath?: string | null;
  repoPath?: string | null;
};

export class PromptFileError extends Error {
  /** True when every candidate was missing (`ENOENT`), so a git ref may still hold the file. */
  readonly notFound: boolean;

  constructor(message: string, notFound = false) {
    super(message);
    this.name = "PromptFileError";
    this.notFound = notFound;
  }
}

const SUBMIT_PROMPT_FIELDS = ["promptFile", "reviewPromptFile", "fixPromptFile"] as const;

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object" || !("code" in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function promptCandidates(filePath: string, bases: PromptFileBases): string[] {
  if (path.isAbsolute(filePath)) return [filePath];
  const out: string[] = [];
  for (const base of [bases.worktreePath, bases.repoPath]) {
    const dir = base?.trim();
    if (!dir) continue;
    const resolved = path.resolve(dir, filePath);
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

/**
 * Read a stage prompt. Empty `filePath` returns null so the caller can use its default.
 * Relative paths are resolved against the worktree first, then `repoPath` — not the runner cwd.
 * A set path that cannot be read throws instead of falling back to the default.
 */
export async function readStagePromptFile(
  filePath: string | undefined,
  bases: PromptFileBases,
  label = "prompt file",
): Promise<string | null> {
  const raw = filePath?.trim() ?? "";
  if (!raw) return null;

  const candidates = promptCandidates(raw, bases);
  if (candidates.length === 0) {
    throw new PromptFileError(
      `${label} ${raw} is relative and the job has no worktree or repoPath to resolve it against`,
    );
  }

  let last: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    try {
      return await readFile(candidate, "utf8");
    } catch (err) {
      last = err;
      const more = i < candidates.length - 1;
      if (more && errorCode(err) === "ENOENT") continue;
      break;
    }
  }

  const tried = candidates.join(", ");
  const code = errorCode(last);
  const notFound = code === "ENOENT";
  const why = notFound ? "not found" : last instanceof Error ? last.message : String(last);
  throw new PromptFileError(`${label} not readable: ${raw} (tried ${tried}); ${why}`, notFound);
}

/** Repo-relative git path, or null when it would leave the tree. */
function repoRelativeGitPath(filePath: string): string | null {
  const posix = filePath.replace(/\\/g, "/").trim();
  if (!posix || path.posix.isAbsolute(posix)) return null;
  const norm = path.posix.normalize(posix);
  if (!norm || norm === "." || norm === ".." || norm.startsWith("../")) return null;
  return norm;
}

async function refVerifies(repoPath: string, ref: string): Promise<boolean> {
  const probe = await git(repoPath, ["rev-parse", "--verify", ref]);
  return probe.code === 0 && probe.stdout.trim().length > 0;
}

/**
 * Ref a new `ensureWorktree` checkout uses, matching that function's success path:
 * best-effort fetch, then `origin/<branch>` when it verifies, then the first probe ref
 * that verifies, then `resolveWorktreeBaseRef` when settings are present.
 * Fetch runs once per submit; a stale or missing `origin/<branch>` is updated before the check.
 */
async function resolveSubmitCheckoutRef(
  repoPath: string,
  branch: string,
  settings?: RunnerSettings,
): Promise<string | null> {
  await bestEffortFetchOrigin(repoPath);
  const remoteRef = `origin/${branch.trim()}`;
  if (await refVerifies(repoPath, remoteRef)) return remoteRef;

  const bases = settings ? baseRefProbeOrder(settings) : ["origin/main", "origin/master", "main"];
  for (const ref of bases) {
    if (ref === remoteRef) continue;
    if (await refVerifies(repoPath, ref)) return ref;
  }

  if (!settings) return null;
  const resolved = await resolveWorktreeBaseRef(repoPath, settings);
  if (await refVerifies(repoPath, resolved.ref)) return resolved.ref;
  return null;
}

/** True when `filePath` is a blob on `ref`. */
async function blobOnRef(repoPath: string, ref: string, filePath: string): Promise<boolean> {
  const gitPath = repoRelativeGitPath(filePath);
  if (!gitPath) return false;
  const typed = await git(repoPath, ["cat-file", "-t", `${ref}:${gitPath}`]);
  return typed.code === 0 && typed.stdout.trim() === "blob";
}

/**
 * Submit-time check for API and MCP `start_job`.
 * An absolute path must be readable as given.
 * A relative path with a local repo must be readable from that working tree, or be a blob on the
 * ref `ensureWorktree` will check out. That ref is resolved once per submit. The stored path is
 * left unchanged so each stage resolves it against the worktree again.
 * Relative paths with no local repo yet (clone-from-remote) are checked when the stage runs.
 */
export async function assertSubmitPromptFiles(args: {
  repoPath?: string | null;
  branch?: string | null;
  settings?: RunnerSettings;
  promptFile?: string;
  reviewPromptFile?: string;
  fixPromptFile?: string;
}): Promise<void> {
  const repoPath = args.repoPath?.trim() ?? "";
  const branch = args.branch?.trim() ?? "";
  let checkoutRef: Promise<string | null> | undefined;
  const checkoutRefOnce = (): Promise<string | null> => {
    checkoutRef ??= resolveSubmitCheckoutRef(repoPath, branch, args.settings);
    return checkoutRef;
  };

  for (const label of SUBMIT_PROMPT_FIELDS) {
    const raw = args[label]?.trim();
    if (!raw) continue;
    if (!path.isAbsolute(raw) && !repoPath) continue;
    try {
      await readStagePromptFile(raw, { repoPath: args.repoPath }, label);
    } catch (err) {
      if (!(err instanceof PromptFileError)) throw err;
      if (err.notFound && repoPath && branch && !path.isAbsolute(raw)) {
        const ref = await checkoutRefOnce();
        if (ref && (await blobOnRef(repoPath, ref, raw))) continue;
      }
      throw new ValidationError(err.message);
    }
  }
}
