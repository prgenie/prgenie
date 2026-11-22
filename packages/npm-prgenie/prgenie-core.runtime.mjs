import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const coreRoot = path.join(here, "../../../packages/core/src");

let selectFn = null;

async function loadSelectCiChecks() {
  if (selectFn) return selectFn;
  const mod = await import(pathToFileURL(path.join(coreRoot, "ci-select.ts")).href);
  selectFn = mod.selectCiChecks;
  return selectFn;
}

export async function prgenieCiSelection(cwd, changedPaths) {
  const selectCiChecks = await loadSelectCiChecks();
  return selectCiChecks(changedPaths, {
    cwd,
    exists: (rel) => existsSync(path.join(cwd, rel)),
  });
}

export async function runPrgenieCiChecks(cwd, selection, onProgress) {
  const { runCiChecks } = await import(pathToFileURL(path.join(coreRoot, "ci-runner.ts")).href);
  const { ciCheckCommand } = await import(pathToFileURL(path.join(coreRoot, "progress.ts")).href);
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
  const { resolveFormatCheckFiles } = await import(
    pathToFileURL(path.join(coreRoot, "ci-runner.ts")).href
  );
  const { files } = await resolveFormatCheckFiles(cwd, {
    changedPaths,
    formatScoped: true,
  });
  return files;
}
