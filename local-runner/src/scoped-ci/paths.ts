import { git } from "../github.js";

export function normalizeCiPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

const FULL_SUITE_RES = [
  /^\.github\/workflows\//,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /(^|\/)(eslint|prettier|tsconfig)(\.[^/]+)?$/,
  /^scripts\/build\.[^/]+$/,
  /^local-runner\/package\.json$/,
];

/** Shared config, lockfile, or repo build files → full local CI suite. */
export function isRunnerHardConfigPath(filePath: string): boolean {
  const p = normalizeCiPath(filePath);
  return FULL_SUITE_RES.some((re) => re.test(p));
}

const SOURCE_EXT = /\.([cm]?[jt]sx?|vue|svelte)$/i;
const TEST_EXT = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const FORMAT_EXT = /\.([cm]?[jt]sx?|json|md|css|scss|html|ya?ml)$/i;

export function isSourcePath(filePath: string): boolean {
  const p = normalizeCiPath(filePath);
  return SOURCE_EXT.test(p) && !TEST_EXT.test(p);
}

export function isTestPath(filePath: string): boolean {
  return TEST_EXT.test(normalizeCiPath(filePath));
}

export function isFormatablePath(filePath: string): boolean {
  const p = normalizeCiPath(filePath);
  const base = p.split("/").pop() ?? p;
  if (base === "pnpm-lock.yaml" || base === "package-lock.json") return false;
  return FORMAT_EXT.test(p);
}

export function siblingTestPath(filePath: string): string | null {
  const p = normalizeCiPath(filePath);
  if (TEST_EXT.test(p)) return p;
  if (!SOURCE_EXT.test(p)) return null;
  return p.replace(SOURCE_EXT, ".test.$1");
}

export function packageDirFromPath(filePath: string): string | null {
  const p = normalizeCiPath(filePath);
  const m = p.match(/^(packages\/[^/]+)\//);
  if (m?.[1]) return m[1];
  if (p.startsWith("local-runner/")) return "local-runner";
  return null;
}

async function diffNameOnly(cwd: string, range: string): Promise<string[]> {
  const diff = await git(cwd, ["diff", "--name-only", range]);
  if (diff.code !== 0) return [];
  return diff.stdout
    .split(/\r?\n/)
    .map((l) => normalizeCiPath(l))
    .filter(Boolean);
}

/** Paths changed on the branch vs merge-base(baseRef, HEAD), including uncommitted work. */
export async function changedPathsVsBase(cwd: string, baseRef: string): Promise<string[]> {
  const paths = new Set<string>();
  const base = baseRef.trim() || "origin/main";
  const mb = await git(cwd, ["merge-base", "HEAD", base]);
  const range = mb.code === 0 && mb.stdout.trim() ? `${mb.stdout.trim()}...HEAD` : `${base}...HEAD`;
  for (const p of await diffNameOnly(cwd, range)) paths.add(p);
  for (const args of [
    ["diff", "--name-only", "HEAD"],
    ["diff", "--name-only", "--cached"],
    ["ls-files", "-o", "--exclude-standard"],
  ] as const) {
    const st = await git(cwd, [...args]);
    if (st.code !== 0) continue;
    for (const line of st.stdout.split(/\r?\n/)) {
      const p = normalizeCiPath(line);
      if (p) paths.add(p);
    }
  }
  return [...paths];
}
