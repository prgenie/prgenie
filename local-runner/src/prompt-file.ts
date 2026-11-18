import { readFile } from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "./validation-error.js";

/** Where a relative prompt path is resolved. Worktree wins so branch edits are picked up. */
export type PromptFileBases = {
  worktreePath?: string | null;
  repoPath?: string | null;
};

export class PromptFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptFileError";
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
  const why = code === "ENOENT" ? "not found" : last instanceof Error ? last.message : String(last);
  throw new PromptFileError(`${label} not readable: ${raw} (tried ${tried}); ${why}`);
}

/**
 * Submit-time check for API and MCP `start_job`.
 * A set file must be readable from `repoPath` (or as an absolute path).
 * The stored path is left unchanged so each stage resolves it against the worktree again.
 * Relative paths with no local repo yet (clone-from-remote) are checked when the stage runs.
 */
export async function assertSubmitPromptFiles(args: {
  repoPath?: string | null;
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
      if (err instanceof PromptFileError) throw new ValidationError(err.message);
      throw err;
    }
  }
}
