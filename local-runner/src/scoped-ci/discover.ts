import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const PREFERRED_ORDER = ["format:check", "lint", "typecheck", "test", "build"] as const;

export type DiscoveredCi = {
  /** Script names from package.json / workflows, in run order. */
  checks: string[];
  packageManager: "pnpm" | "npm" | "yarn" | "unknown";
  hasPrettier: boolean;
  hasEslint: boolean;
};

function readRootPackage(cwd: string): { scripts: Record<string, string>; name?: string } | null {
  try {
    const pkgPath = path.join(cwd, "package.json");
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
      name?: string;
    };
    return { scripts: pkg.scripts ?? {}, name: pkg.name };
  } catch {
    return null;
  }
}

function detectPackageManager(cwd: string): DiscoveredCi["packageManager"] {
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(cwd, "package-lock.json"))) return "npm";
  return "unknown";
}

function scriptsFromWorkflows(cwd: string): string[] {
  const wfDir = path.join(cwd, ".github", "workflows");
  if (!existsSync(wfDir)) return [];
  const names = new Set<string>();
  const re = /(?:pnpm|npm run|yarn)\s+([a-zA-Z0-9:_-]+)/g;
  for (const file of readdirSync(wfDir)) {
    if (!/\.(ya?ml)$/i.test(file)) continue;
    try {
      const text = readFileSync(path.join(wfDir, file), "utf8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m[1]) names.add(m[1]);
      }
    } catch {
      /* ignore */
    }
  }
  return [...names];
}

export function isPrGenieRepo(cwd: string): boolean {
  const pkg = readRootPackage(cwd);
  return pkg?.name === "prgenie";
}

/** Discover CI script names available in the target repo. */
export function discoverCiChecks(cwd: string): DiscoveredCi {
  const pkg = readRootPackage(cwd);
  const scripts = { ...pkg?.scripts };
  for (const name of scriptsFromWorkflows(cwd)) {
    if (!(name in scripts)) scripts[name] = `workflow:${name}`;
  }
  const available = new Set(Object.keys(scripts));
  const checks: string[] = [];
  for (const name of PREFERRED_ORDER) {
    if (available.has(name)) checks.push(name);
  }
  for (const name of [...available].sort()) {
    if (!checks.includes(name) && /^[a-z][a-z0-9:_-]*$/i.test(name)) {
      if (name.startsWith("test:") || name.startsWith("lint:") || name.startsWith("typecheck:")) {
        checks.push(name);
      }
    }
  }
  const pm = detectPackageManager(cwd);
  const hasPrettier =
    existsSync(path.join(cwd, "node_modules", "prettier")) ||
    existsSync(path.join(cwd, "node_modules", ".bin", "prettier"));
  const hasEslint =
    existsSync(path.join(cwd, "node_modules", "eslint")) ||
    existsSync(path.join(cwd, "node_modules", ".bin", "eslint"));
  return { checks, packageManager: pm, hasPrettier, hasEslint };
}

export function pmExecPrefix(pm: DiscoveredCi["packageManager"]): string {
  if (pm === "pnpm") return "pnpm";
  if (pm === "yarn") return "yarn";
  return "npm run";
}
