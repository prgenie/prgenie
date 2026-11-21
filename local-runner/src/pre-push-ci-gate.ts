import type { JobRecord } from "./types.js";
import type { RunnerSettings } from "./settings.js";
import { isDocsJob } from "./doc-checks.js";
import { buildPrePushCiPlan } from "./scoped-ci/plan.js";
import { changedPathsVsBase } from "./scoped-ci/paths.js";
import { parsePrePushCiSettings, resolvePrePushCiOverride } from "./scoped-ci/settings.js";
import { formatPrePushCiEvidence } from "./scoped-ci/evidence.js";
import { runPlannedCiChecks } from "./scoped-ci/run.js";
import type { PrePushCiGateResult } from "./scoped-ci/types.js";

export type PrePushCiGateOptions = {
  cwd: string;
  baseRef: string;
  job: JobRecord;
  settings: RunnerSettings;
  onLog?: (line: string) => void | Promise<void>;
};

export async function runPrePushCiGate(
  options: PrePushCiGateOptions,
): Promise<PrePushCiGateResult> {
  const { cwd, baseRef, job, settings, onLog } = options;
  const parsed = parsePrePushCiSettings(settings);
  const override = resolvePrePushCiOverride(parsed, job.repoSlug, job.input.repoPath);

  if (override?.skip) {
    const reason = "prePushCi.skip in runner settings";
    await onLog?.(`[runner] pre-push CI skipped: ${reason}`);
    return { ok: true, skipped: true, skipReason: reason, results: [], evidenceText: "" };
  }

  const changedPaths = await changedPathsVsBase(cwd, baseRef);
  const { selection } = await buildPrePushCiPlan({
    cwd,
    changedPaths,
    docsOnly: isDocsJob(job),
    override,
  });

  if (selection.skipped || selection.checks.length === 0) {
    const reason = selection.reason.join("; ") || "no checks selected";
    await onLog?.(`[runner] pre-push CI skipped: ${reason}`);
    return { ok: true, skipped: true, skipReason: reason, results: [], evidenceText: "" };
  }

  await onLog?.(
    `[runner] pre-push CI plan: ${selection.checks.join(", ")} (${selection.reason.join("; ")})`,
  );
  const results = await runPlannedCiChecks({ cwd, selection, override, onLog });
  const evidenceText = formatPrePushCiEvidence(results);
  await onLog?.(evidenceText);

  const failed = results.find((r) => !r.passed);
  if (failed) {
    return {
      ok: false,
      results,
      evidenceText,
      error: `pre-push CI failed: ${failed.name} (exit ${failed.exitCode})`,
    };
  }
  return { ok: true, results, evidenceText };
}
