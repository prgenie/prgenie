import { readFile } from "node:fs/promises";
import path from "node:path";
import { git } from "./github.js";
import { baseRefProbeOrder } from "./repo-base.js";
import type { RunnerSettings } from "./settings.js";
import { ValidationError } from "./validation-error.js";

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

/**
 * Refs `ensureWorktree` checks out, first hit wins: `origin/<branch>` when that ref exists,
 * otherwise the same base list (`origin/main`, then `origin/master`, `main`, and `master`
 * when runner settings are supplied).
 */
function worktreeCheckoutRefOrder(branch: string, settings?: RunnerSettings): string[] {
  const remoteRef = `origin/${branch.trim()}`;
  const bases = settings ? baseRefProbeOrder(settings) : ["origin/main", "origin/master", "main"];
  return [remoteRef, ...bases.filter((ref) => ref !== remoteRef)];
}

/** Repo-relative git path, or null when it would leave the tree. */
function repoRelativeGitPath(filePath: string): string | null {
  const posix = filePath.replace(/\\/g, "/").trim();
  if (!posix || path.posix.isAbsolute(posix)) return null;
  const norm = path.posix.normalize(posix);
  if (!norm || norm === "." || norm === ".." || norm.startsWith("../")) return null;
  return norm;
}

async function firstExistingRef(repoPath: string, refs: string[]): Promise<string | null> {
  for (const ref of refs) {
    const probe = await git(repoPath, ["rev-parse", "--verify", "--quiet", ref]);
    if (probe.code === 0 && probe.stdout.trim()) return ref;
  }
  return null;
}

/** True when `filePath` is a blob on the ref a new worktree will check out. */
async function relativePromptOnCheckoutRef(
  repoPath: string,
  branch: string,
  filePath: string,
  settings?: RunnerSettings,
): Promise<boolean> {
  const gitPath = repoRelativeGitPath(filePath);
  if (!gitPath) return false;
  const ref = await firstExistingRef(repoPath, worktreeCheckoutRefOrder(branch, settings));
  if (!ref) return false;
  const typed = await git(repoPath, ["cat-file", "-t", `${ref}:${gitPath}`]);
  return typed.code === 0 && typed.stdout.trim() === "blob";
}

/**
 * Submit-time check for API and MCP `start_job`.
 * An absolute path must be readable as given.
 * A relative path with a local repo must be readable from that working tree, or be a blob on the
 * ref `ensureWorktree` will check out. The stored path is left unchanged so each stage resolves
 * it against the worktree again.
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
  for (const label of SUBMIT_PROMPT_FIELDS) {
    const raw = args[label]?.trim();
    if (!raw) continue;
    if (!path.isAbsolute(raw) && !args.repoPath?.trim()) continue;
    try {
      await readStagePromptFile(raw, { repoPath: args.repoPath }, label);
    } catch (err) {
      if (!(err instanceof PromptFileError)) throw err;
      const repoPath = args.repoPath?.trim();
      const branch = args.branch?.trim();
      if (
        err.notFound &&
        repoPath &&
        branch &&
        !path.isAbsolute(raw) &&
        (await relativePromptOnCheckoutRef(repoPath, branch, raw, args.settings))
      ) {
        continue;
      }
      throw new ValidationError(err.message);
    }
  }
}
