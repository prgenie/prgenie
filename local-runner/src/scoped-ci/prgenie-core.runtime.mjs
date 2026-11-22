import { existsSync } from "node:fs";
import path from "node:path";

// Static imports so scripts/build.mjs can bundle core into
// local-runner/dist/prgenie-core.runtime.mjs. A runtime path to packages/core
// broke once the shim was copied to dist/ (one level shallower), and plain node
// cannot load core's .ts sources (their imports use .js specifiers) anyway.
import { selectCiChecks } from "../../../packages/core/src/ci-select.ts";
import { runCiChecks, resolveFormatCheckFiles } from "../../../packages/core/src/ci-runner.ts";
import { ciCheckCommand } from "../../../packages/core/src/progress.ts";

export async function prgenieCiSelection(cwd, changedPaths) {
  return selectCiChecks(changedPaths, {
    cwd,
    exists: (rel) => existsSync(path.join(cwd, rel)),
  });
}

export async function runPrgenieCiChecks(cwd, selection, onProgress) {
  const runner = await runCiChecks(cwd, {
    checks: selection.checks,
    selection,
    skipCache: true,
    skipToolchainEnsure: true,
    failFast: true,
    onProgress: (ev) => {
      if (ev.command) onProgress?.({ check: ev.check, command: ev.command });
    },
  });
  return runner.checks.map((r) => ({
    name: r.name,
    passed: r.passed,
    excerpt: r.excerpt ?? r.error,
    error: r.error,
    command: ciCheckCommand(r.name, selection.testFiles?.[r.name]),
  }));
}

export async function resolvePrgenieFormatFiles(cwd, changedPaths) {
  const { files } = await resolveFormatCheckFiles(cwd, {
    changedPaths,
    formatScoped: true,
  });
  return files;
}
