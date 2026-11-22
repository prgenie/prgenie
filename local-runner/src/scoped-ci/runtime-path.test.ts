import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const shim = path.join(here, "prgenie-core.runtime.mjs");

describe("prgenie-core.runtime.mjs", () => {
  // scripts/build.mjs bundles the shim into local-runner/dist/, one level shallower
  // than src/scoped-ci/ and with no access to packages/core/src at runtime.
  const outDir = path.join(repoRoot, "local-runner", ".runtime-path-test");
  after(() => rmSync(outDir, { recursive: true, force: true }));

  it("loads core from the source location", async () => {
    const mod = await import(pathToFileURL(shim).href);
    assert.ok(await mod.prgenieCiSelection(repoRoot, ["README.md"]));
  });

  it("works as a dist-depth bundle under plain node module loading", async () => {
    const outfile = path.join(outDir, "prgenie-core.runtime.mjs");
    await esbuild.build({
      absWorkingDir: repoRoot,
      entryPoints: [shim],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["prettier"],
      logLevel: "silent",
      banner: {
        js: 'import { createRequire as __prgenieCreateRequire } from "node:module";\nconst require = __prgenieCreateRequire(import.meta.url);',
      },
    });
    const mod = await import(pathToFileURL(outfile).href);
    assert.ok(await mod.prgenieCiSelection(repoRoot, ["local-runner/src/scoped-ci/plan.ts"]));
  });
});
