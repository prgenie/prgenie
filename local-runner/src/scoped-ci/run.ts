import { spawnCommand } from "../spawn-cmd.js";
import { discoverCiChecks, isPrGenieRepo, pmExecPrefix } from "./discover.js";
import { isFormatablePath, normalizeCiPath } from "./paths.js";
import { resolvePrgenieFormatFiles, runPrgenieCiChecks } from "./prgenie-core.js";
import type { CiCheckSelection, PrePushCiCheckResult, PrePushCiRepoOverride } from "./types.js";

function excerpt(stdout: string, stderr: string, max = 500): string {
  const merged = `${stdout}\n${stderr}`.trim();
  if (!merged) return "";
  return merged.length <= max ? merged : `${merged.slice(0, max)}…`;
}

async function runShell(
  cwd: string,
  command: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const trimmed = command.trim();
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0]!;
  const args = parts.slice(1);
  if (cmd === "pnpm" || cmd === "npm" || cmd === "yarn") {
    return spawnCommand(cmd, cwd, args);
  }
  if (process.platform === "win32") {
    return spawnCommand("cmd.exe", cwd, ["/d", "/s", "/c", trimmed]);
  }
  return spawnCommand("sh", cwd, ["-c", trimmed]);
}

function scopeForCheck(selection: CiCheckSelection, check: string): string {
  const mapped = selection.mapping.find((m) => m.check === check);
  if (mapped?.reason) return mapped.reason;
  return selection.changedPaths.join(", ") || "full suite";
}

function resolveGenericCommand(
  cwd: string,
  check: string,
  selection: CiCheckSelection,
  override?: PrePushCiRepoOverride | null,
): { command: string; scope: string } {
  const scope = scopeForCheck(selection, check);
  if (override?.commands?.[check]) {
    return { command: override.commands[check]!, scope };
  }
  const discovered = discoverCiChecks(cwd);
  const prefix = pmExecPrefix(discovered.packageManager);
  if (check === "format:check" && selection.mapping.find((m) => m.check === check)) {
    const files = scope
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter(isFormatablePath);
    if (files.length > 0 && discovered.hasPrettier) {
      return {
        command: `pnpm exec prettier --check ${files.join(" ")}`,
        scope: files.join(", "),
      };
    }
  }
  if (check === "lint" && scope.includes(".")) {
    const files = scope
      .split(",")
      .map((s) => s.trim())
      .filter((p) => /\.[cm]?[jt]sx?$/i.test(p));
    if (files.length > 0) {
      return {
        command: `pnpm exec eslint ${files.join(" ")}`,
        scope: files.join(", "),
      };
    }
  }
  const testFiles = selection.testFiles?.[check];
  if (testFiles && testFiles.length > 0 && check.startsWith("test:")) {
    return {
      command: `pnpm exec tsx --test ${testFiles.join(" ")}`,
      scope: testFiles.join(", "),
    };
  }
  if (prefix === "npm run") return { command: `npm run ${check}`, scope };
  return { command: `${prefix} ${check}`, scope };
}

async function tryAutoFormat(cwd: string, selection: CiCheckSelection): Promise<boolean> {
  let files: string[] = [];
  const fmtMapping = selection.mapping.find((m) => m.check === "format:check");
  if (fmtMapping?.reason) {
    files = fmtMapping.reason
      .split(",")
      .map((s) => normalizeCiPath(s.trim()))
      .filter(Boolean)
      .filter(isFormatablePath);
  }
  if (files.length === 0 && isPrGenieRepo(cwd)) {
    try {
      files = await resolvePrgenieFormatFiles(cwd, selection.changedPaths);
    } catch {
      /* ignore */
    }
  }
  if (files.length === 0) return false;
  const write = await runShell(cwd, `pnpm exec prettier --write ${files.join(" ")}`);
  return write.code === 0;
}

export async function runPlannedCiChecks(options: {
  cwd: string;
  selection: CiCheckSelection;
  override?: PrePushCiRepoOverride | null;
  onLog?: (line: string) => void | Promise<void>;
}): Promise<PrePushCiCheckResult[]> {
  const { cwd, selection, override, onLog } = options;
  if (selection.skipped || selection.checks.length === 0) return [];

  const results: PrePushCiCheckResult[] = [];
  const log = async (line: string) => {
    await onLog?.(line);
  };

  if (isPrGenieRepo(cwd)) {
    const raw = await runPrgenieCiChecks(cwd, selection, (ev) => {
      if (ev.command) void log(`[runner] pre-push CI ${ev.check ?? ""}: ${ev.command}`);
    });
    for (const r of raw) {
      let autoFixed = false;
      const command = (r as { command?: string }).command ?? `pnpm ${r.name}`;
      if (!r.passed && r.name === "format:check") {
        const fixed = await tryAutoFormat(cwd, selection);
        if (fixed) {
          autoFixed = true;
          const retry = await runPrgenieCiChecks(cwd, {
            ...selection,
            checks: ["format:check"],
          });
          const rr = retry[0];
          results.push({
            name: r.name,
            command,
            scope: scopeForCheck(selection, r.name),
            exitCode: rr?.passed ? 0 : 1,
            excerpt: rr?.excerpt ?? rr?.error ?? "",
            passed: rr?.passed ?? false,
            autoFixed: true,
          });
          continue;
        }
      }
      results.push({
        name: r.name,
        command,
        scope: scopeForCheck(selection, r.name),
        exitCode: r.passed ? 0 : 1,
        excerpt: r.excerpt ?? r.error ?? "",
        passed: r.passed,
        autoFixed,
      });
    }
    return results;
  }

  for (const check of selection.checks) {
    const { command, scope } = resolveGenericCommand(cwd, check, selection, override);
    await log(`[runner] pre-push CI ${check}: ${command}`);
    let run = await runShell(cwd, command);
    let autoFixed = false;
    if (run.code !== 0 && check === "format:check") {
      const fixed = await tryAutoFormat(cwd, selection);
      if (fixed) {
        autoFixed = true;
        run = await runShell(cwd, command);
      }
    }
    results.push({
      name: check,
      command,
      scope,
      exitCode: run.code,
      excerpt: excerpt(run.stdout, run.stderr),
      passed: run.code === 0,
      autoFixed,
    });
    if (run.code !== 0) break;
  }
  return results;
}
