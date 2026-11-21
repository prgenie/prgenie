import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CiCheckSelection } from "./types.js";

type PrgenieCoreRuntime = {
  prgenieCiSelection(cwd: string, changedPaths: string[]): Promise<CiCheckSelection>;
  runPrgenieCiChecks(
    cwd: string,
    selection: CiCheckSelection,
    onProgress?: (ev: { check?: string; command?: string }) => void,
  ): Promise<
    Array<{
      name: string;
      passed: boolean;
      excerpt?: string;
      error?: string;
      command?: string;
    }>
  >;
  resolvePrgenieFormatFiles(cwd: string, changedPaths: string[]): Promise<string[]>;
};

let runtime: Promise<PrgenieCoreRuntime> | null = null;

function runtimeModuleUrl(): string {
  try {
    if (typeof import.meta !== "undefined" && import.meta.url) {
      return new URL("./prgenie-core.runtime.mjs", import.meta.url).href;
    }
  } catch {
    /* bundled cjs */
  }
  const runnerDir = path.dirname(process.argv[1] ?? "");
  return pathToFileURL(path.join(runnerDir, "prgenie-core.runtime.mjs")).href;
}

function loadRuntime(): Promise<PrgenieCoreRuntime> {
  if (!runtime) {
    runtime = import(runtimeModuleUrl());
  }
  return runtime;
}

export async function prgenieCiSelection(
  cwd: string,
  changedPaths: string[],
): Promise<CiCheckSelection> {
  const mod = await loadRuntime();
  return mod.prgenieCiSelection(cwd, changedPaths);
}

export async function runPrgenieCiChecks(
  cwd: string,
  selection: CiCheckSelection,
  onProgress?: (ev: { check?: string; command?: string }) => void,
) {
  const mod = await loadRuntime();
  return mod.runPrgenieCiChecks(cwd, selection, onProgress);
}

export async function resolvePrgenieFormatFiles(
  cwd: string,
  changedPaths: string[],
): Promise<string[]> {
  const mod = await loadRuntime();
  return mod.resolvePrgenieFormatFiles(cwd, changedPaths);
}
