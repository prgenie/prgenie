import path from "node:path";
import { existsSync } from "node:fs";
import { discoverCiChecks, isPrGenieRepo } from "./discover.js";
import { prgenieCiSelection } from "./prgenie-core.js";
import type { CiCheckSelection } from "./types.js";
import {
  isFormatablePath,
  isRunnerHardConfigPath,
  isSourcePath,
  isTestPath,
  packageDirFromPath,
  siblingTestPath,
} from "./paths.js";
import type { PrePushCiRepoOverride } from "./types.js";

export type PrePushCiPlan = {
  selection: CiCheckSelection;
  fullSuite: boolean;
};

function skipSelection(reason: string, changedPaths: string[]): CiCheckSelection {
  return {
    checks: [],
    reason: [reason],
    mapping: [],
    uncertain: false,
    changedPaths,
    skipped: true,
  };
}

function fullSuiteSelection(
  checks: string[],
  changedPaths: string[],
  reason: string,
): CiCheckSelection {
  return {
    checks,
    reason: [reason],
    mapping: checks.map((c) => ({ check: c, reason })),
    uncertain: false,
    changedPaths,
    packageScoped: false,
    skipped: false,
  };
}

function genericPlan(
  cwd: string,
  changedPaths: string[],
  docsOnly: boolean,
  forceFullSuite: boolean,
  overrideChecks: string[] | undefined,
): PrePushCiPlan {
  const discovered = discoverCiChecks(cwd);
  const checksAvailable =
    overrideChecks && overrideChecks.length > 0 ? overrideChecks : discovered.checks;
  if (checksAvailable.length === 0) {
    return {
      fullSuite: false,
      selection: skipSelection(
        "no CI scripts discovered in package.json or workflows",
        changedPaths,
      ),
    };
  }

  const hard = changedPaths.filter(isRunnerHardConfigPath);
  const fullSuite = forceFullSuite || hard.length > 0;
  if (fullSuite) {
    return {
      fullSuite: true,
      selection: fullSuiteSelection(
        checksAvailable,
        changedPaths,
        hard.length > 0
          ? `hard config changed (${hard.join(", ")}) → full local CI`
          : "settings forceFullSuite → full local CI",
      ),
    };
  }

  if (changedPaths.length === 0) {
    return {
      fullSuite: false,
      selection: skipSelection("no changed paths", changedPaths),
    };
  }

  if (docsOnly) {
    const md = changedPaths.filter((p) => p.endsWith(".md"));
    const fmtPaths = md.filter(isFormatablePath);
    if (fmtPaths.length === 0) {
      return {
        fullSuite: false,
        selection: skipSelection("docs job — no markdown changes to check", changedPaths),
      };
    }
    if (checksAvailable.includes("format:check")) {
      return {
        fullSuite: false,
        selection: {
          checks: ["format:check"],
          reason: ["docs job → format:check on changed markdown"],
          mapping: [{ check: "format:check", reason: fmtPaths.join(", ") }],
          uncertain: false,
          changedPaths,
          packageScoped: false,
          skipped: false,
        },
      };
    }
    return {
      fullSuite: false,
      selection: skipSelection("docs job — format:check not available", changedPaths),
    };
  }

  const checks: string[] = [];
  const mapping: { check: string; reason: string }[] = [];
  const testFiles: Record<string, string[]> = {};

  const fmtPaths = changedPaths.filter(isFormatablePath);
  if (fmtPaths.length > 0 && checksAvailable.includes("format:check")) {
    checks.push("format:check");
    mapping.push({ check: "format:check", reason: fmtPaths.join(", ") });
  }

  const lintTargets = changedPaths.filter((p) => isSourcePath(p) || isTestPath(p));
  if (lintTargets.length > 0 && checksAvailable.includes("lint")) {
    checks.push("lint");
    mapping.push({ check: "lint", reason: lintTargets.join(", ") });
  }

  const pkgs = new Set<string>();
  for (const p of changedPaths) {
    const dir = packageDirFromPath(p);
    if (dir) pkgs.add(dir);
  }
  if (pkgs.size === 1 && checksAvailable.includes("typecheck")) {
    const pkg = [...pkgs][0]!;
    const tsconfig = path.join(cwd, pkg, "tsconfig.json");
    if (existsSync(tsconfig)) {
      checks.push("typecheck");
      mapping.push({ check: "typecheck", reason: `${pkg}/**` });
    }
  } else if (pkgs.size > 1 && checksAvailable.some((c) => c.startsWith("typecheck:"))) {
    for (const pkgDir of pkgs) {
      const short = pkgDir.replace(/^packages\//, "");
      const name = `typecheck:${short}`;
      if (checksAvailable.includes(name)) {
        checks.push(name);
        mapping.push({ check: name, reason: `${pkgDir}/**` });
      }
    }
  }

  const tests = new Set<string>();
  for (const p of changedPaths) {
    if (isTestPath(p)) tests.add(p);
    const sib = siblingTestPath(p);
    if (sib && existsSync(path.join(cwd, sib))) tests.add(sib);
  }
  if (tests.size > 0) {
    const pkg = packageDirFromPath([...tests][0] ?? "");
    if (pkg?.startsWith("packages/")) {
      const short = pkg.replace(/^packages\//, "");
      const testName = `test:${short}`;
      if (checksAvailable.includes(testName)) {
        checks.push(testName);
        testFiles[testName] = [...tests];
        mapping.push({ check: testName, reason: [...tests].join(", ") });
      } else if (checksAvailable.includes("test")) {
        checks.push("test");
        mapping.push({ check: "test", reason: [...tests].join(", ") });
      }
    } else if (checksAvailable.includes("test")) {
      checks.push("test");
      mapping.push({ check: "test", reason: [...tests].join(", ") });
    }
  }

  const buildPkgs = [...pkgs].filter((d) => {
    const pkgJson = path.join(cwd, d, "package.json");
    return existsSync(pkgJson);
  });
  if (
    buildPkgs.length === 1 &&
    changedPaths.some(isSourcePath) &&
    checksAvailable.includes("build")
  ) {
    checks.push("build");
    mapping.push({ check: "build", reason: `${buildPkgs[0]}/** may affect build output` });
  }

  if (checks.length === 0) {
    return {
      fullSuite: false,
      selection: skipSelection(
        "no applicable scoped checks for this diff — never default to full test suite",
        changedPaths,
      ),
    };
  }

  return {
    fullSuite: false,
    selection: {
      checks,
      reason: ["generic scoped plan from changed paths"],
      mapping,
      uncertain: false,
      changedPaths,
      packageScoped: checks.some((c) => c.includes(":")),
      skipped: false,
      ...(Object.keys(testFiles).length > 0 ? { testFiles } : {}),
    },
  };
}

export async function buildPrePushCiPlan(options: {
  cwd: string;
  changedPaths: string[];
  docsOnly: boolean;
  override?: PrePushCiRepoOverride | null;
}): Promise<PrePushCiPlan> {
  const { cwd, changedPaths, docsOnly, override } = options;
  if (override?.skip) {
    return {
      fullSuite: false,
      selection: skipSelection("prePushCi.skip in runner settings", changedPaths),
    };
  }

  if (isPrGenieRepo(cwd) && !override?.forceFullSuite && !override?.checks?.length) {
    const selection = await prgenieCiSelection(cwd, changedPaths);
    const fullSuite = selection.checks.includes("test") && selection.packageScoped !== true;
    return { selection, fullSuite };
  }

  return genericPlan(
    cwd,
    changedPaths,
    docsOnly,
    Boolean(override?.forceFullSuite),
    override?.checks,
  );
}
