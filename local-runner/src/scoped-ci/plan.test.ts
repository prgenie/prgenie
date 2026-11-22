import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildPrePushCiPlan } from "./plan.js";
import { isRunnerHardConfigPath } from "./paths.js";

describe("scoped-ci plan (#255)", () => {
  it("treats lockfile and workflow edits as full suite", () => {
    assert.equal(isRunnerHardConfigPath("pnpm-lock.yaml"), true);
    assert.equal(isRunnerHardConfigPath(".github/workflows/ci.yml"), true);
    assert.equal(isRunnerHardConfigPath("local-runner/src/job-runner.ts"), false);
  });

  it("scopes prgenie local-runner-only changes away from root test", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "lr-ci-plan-"));
    writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "prgenie", scripts: { "format:check": "x", test: "x" } }),
    );
    mkdirSync(path.join(cwd, "packages", "core", "src"), { recursive: true });
    const plan = await buildPrePushCiPlan({
      cwd,
      changedPaths: ["local-runner/src/foo.ts"],
      docsOnly: false,
      override: null,
    });
    assert.ok(!plan.selection.checks.includes("test"), plan.selection.checks.join(","));
    assert.ok(plan.selection.checks.length > 0);
  });

  it("docs jobs prefer format on changed markdown", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "lr-ci-docs-"));
    writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ scripts: { "format:check": "prettier --check ." } }),
    );
    const plan = await buildPrePushCiPlan({
      cwd,
      changedPaths: ["docs/guide.md"],
      docsOnly: true,
      override: null,
    });
    assert.deepEqual(plan.selection.checks, ["format:check"]);
  });

  it("honors settings skip", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "lr-ci-skip-"));
    writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const plan = await buildPrePushCiPlan({
      cwd,
      changedPaths: ["src/a.ts"],
      docsOnly: false,
      override: { skip: true },
    });
    assert.equal(plan.selection.skipped, true);
  });
});
