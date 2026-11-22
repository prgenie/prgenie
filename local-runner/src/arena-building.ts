import { arenaCandidateBranch, repoSlugFromPath } from "./paths.js";
import type { JobRecord } from "./types.js";
import type { RunnerSettings } from "./settings.js";
import {
  ARENA_TOO_FEW_SURVIVORS,
  arenaSynthesisProveOk,
  buildArenaCandidatePrompt,
  buildArenaSynthesisPrompt,
  candidateProducedOutput,
  resolveArenaCandidateCount,
  resolveArenaCandidateModel,
  type ArenaSurvivorRef,
} from "./arena-implement.js";
import { ensureArenaCandidateWorktree, removeArenaCandidateWorktree } from "./worktree.js";

export type ArenaStageRun = (
  index: number,
  cwd: string,
  prompt: string,
  model: string,
) => Promise<{ code: number; output: string } | null>;

export type ArenaSynthesisRun = (
  cwd: string,
  prompt: string,
  model: string,
) => Promise<{ code: number; output: string } | null>;

export type RunArenaBuildingInput = {
  job: JobRecord;
  settings: RunnerSettings;
  dataDir?: string;
  repoRoot: string;
  mainWorktree: string;
  taskPrompt: string;
  outputFormat: "stream-json" | "text";
  buildModel: string;
  runCandidate: ArenaStageRun;
  runSynthesis: ArenaSynthesisRun;
  onLog: (line: string) => void | Promise<void>;
  /** Unit tests: skip git worktree add. */
  testEnsureCandidateWorktree?: (index: number) => Promise<string>;
  testSkipCleanup?: boolean;
};

export type RunArenaBuildingResult =
  | {
      ok: true;
      synthesisOutput: string;
      survivors: ArenaSurvivorRef[];
      dropouts: number[];
    }
  | { ok: false; error: string; dropouts?: number[] };

export async function runArenaBuildingStage(
  input: RunArenaBuildingInput,
): Promise<RunArenaBuildingResult> {
  const n = resolveArenaCandidateCount(input.job, input.settings);
  const slug = repoSlugFromPath(input.repoRoot);
  const branch = input.job.input.branch;
  const dropouts: number[] = [];
  const survivors: ArenaSurvivorRef[] = [];
  const candidateWtPaths: Array<{ index: number; path: string; branch: string }> = [];

  await input.onLog(`[arena] fan-out: ${n} parallel candidates (#250)`);

  const fanOut = await Promise.all(
    Array.from({ length: n }, async (_, index) => {
      const candBranch = arenaCandidateBranch(branch, index);
      let wtPath: string;
      try {
        if (input.testEnsureCandidateWorktree) {
          wtPath = await input.testEnsureCandidateWorktree(index);
        } else {
          const ensured = await ensureArenaCandidateWorktree(
            input.repoRoot,
            input.job.id,
            index,
            branch,
            input.settings,
            { dataDir: input.dataDir },
          );
          wtPath = ensured.path;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await input.onLog(`[arena] candidate ${index}: worktree failed: ${message}`);
        return { index, dropout: true as const, reason: "worktree" as const };
      }
      const holder = { index, path: wtPath, branch: candBranch };
      const candidatePrompt = buildArenaCandidatePrompt(input.taskPrompt);
      const model = resolveArenaCandidateModel(input.job, index, input.buildModel);
      await input.onLog(`[arena] candidate ${index}: start (model ${model}) at ${wtPath}`);
      const result = await input.runCandidate(index, wtPath, candidatePrompt, model);
      if (!result || result.code !== 0) {
        const code = result?.code ?? "watchdog";
        await input.onLog(`[arena] candidate ${index}: dropout (exit ${code})`);
        return { index, dropout: true as const, reason: "exit" as const, holder };
      }
      if (!candidateProducedOutput(result.output, input.outputFormat)) {
        await input.onLog(`[arena] candidate ${index}: dropout (no output)`);
        return { index, dropout: true as const, reason: "empty" as const, holder };
      }
      await input.onLog(`[arena] candidate ${index}: survived`);
      return {
        index,
        dropout: false as const,
        holder,
        survivor: {
          index,
          worktreePath: wtPath,
          branch: candBranch,
          outputExcerpt: result.output.slice(0, 400),
        },
      };
    }),
  );

  for (const row of fanOut) {
    if ("holder" in row && row.holder) {
      candidateWtPaths.push(row.holder);
    }
    if (row.dropout) {
      dropouts.push(row.index);
    } else if ("survivor" in row && row.survivor) {
      survivors.push(row.survivor);
    }
  }

  if (survivors.length < 2) {
    if (!input.testSkipCleanup) await cleanupArenaWorktrees(input.repoRoot, candidateWtPaths);
    return { ok: false, error: ARENA_TOO_FEW_SURVIVORS, dropouts };
  }

  const synthesisPrompt = buildArenaSynthesisPrompt(
    input.taskPrompt,
    survivors,
    dropouts,
    branch,
    input.mainWorktree,
  );
  await input.onLog(
    `[arena] synthesis: ${survivors.length} survivors, ${dropouts.length} dropout(s) → ${input.mainWorktree}`,
  );
  const synthesis = await input.runSynthesis(input.mainWorktree, synthesisPrompt, input.buildModel);
  if (!input.testSkipCleanup) await cleanupArenaWorktrees(input.repoRoot, candidateWtPaths);

  if (!synthesis || synthesis.code !== 0) {
    const code = synthesis?.code ?? "watchdog";
    return { ok: false, error: `arena synthesis agent exited ${code}`, dropouts };
  }
  if (!arenaSynthesisProveOk(synthesis.output, input.outputFormat)) {
    return {
      ok: false,
      error:
        "arena synthesis finished without ARENA: SYNTHESIS and PROVE: EVIDENCE (command output required)",
      dropouts,
    };
  }

  await input.onLog(`[arena] synthesis complete; candidate worktrees removed`);
  return {
    ok: true,
    synthesisOutput: synthesis.output,
    survivors,
    dropouts,
  };
}

async function cleanupArenaWorktrees(
  repoRoot: string,
  candidates: Array<{ index: number; path: string; branch: string }>,
): Promise<void> {
  for (const { path, branch } of candidates) {
    await removeArenaCandidateWorktree(repoRoot, path, branch).catch(() => undefined);
  }
}
