import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PRGENIE_RUNNER_SERVICE_NAME,
  installRunnerUserService,
  planRunnerUserService,
  renderRunnerUserService,
  resolveServiceEntry,
  type CommandResult,
} from "./install-service.js";

describe("install-service", () => {
  it("renders a oneshot user unit that restarts without git pull", () => {
    const plan = planRunnerUserService({
      execPath: "/usr/bin/node",
      entry: "/opt/prgenie/local-runner/dist/runner.cjs",
      buildRoot: "/opt/prgenie",
      host: "0.0.0.0",
    });
    const unit = renderRunnerUserService(plan);
    assert.match(unit, /^Type=oneshot$/m);
    assert.match(unit, /^RemainAfterExit=yes$/m);
    assert.match(unit, /^KillMode=process$/m);
    assert.match(unit, /^Environment=PRGENIE_RUNNER_HOST=0\.0\.0\.0$/m);
    assert.match(unit, /^WorkingDirectory=\/opt\/prgenie$/m);
    assert.match(unit, /restart --build/);
    assert.doesNotMatch(unit, /^ExecStart=.*git pull/m);
    assert.match(unit, /Does not git pull/);
    assert.equal(plan.usesBuild, true);
  });

  it("omits --build when there is no workspace root", () => {
    const plan = planRunnerUserService({
      execPath: "/usr/bin/node",
      entry: "/usr/lib/node_modules/prgenie/runner.cjs",
      buildRoot: null,
    });
    assert.equal(plan.usesBuild, false);
    assert.match(plan.execStart, /restart$/);
    assert.doesNotMatch(plan.execStart, /--build/);
    assert.equal(plan.host, "0.0.0.0");
  });

  it("writes the unit and enables it without starting it", async () => {
    const unitDir = await mkdtemp(path.join(os.tmpdir(), "lr-unit-"));
    const commands: string[] = [];
    const run = async (command: string, args: string[]): Promise<CommandResult> => {
      commands.push([command, ...args].join(" "));
      return { code: 0, stderr: "" };
    };
    const plan = planRunnerUserService({
      execPath: "/usr/bin/node",
      entry: "/opt/prgenie/runner.cjs",
      buildRoot: "/opt/prgenie",
    });
    const installed = await installRunnerUserService({
      plan,
      unitDir,
      user: "brett",
      run,
    });
    const onDisk = await readFile(installed.unitPath, "utf8");
    assert.equal(onDisk, renderRunnerUserService(plan));
    assert.equal(path.basename(installed.unitPath), PRGENIE_RUNNER_SERVICE_NAME);
    assert.equal(installed.linger, true);
    assert.deepEqual(commands, [
      "systemctl --user daemon-reload",
      `systemctl --user enable ${PRGENIE_RUNNER_SERVICE_NAME}`,
      "loginctl enable-linger brett",
    ]);
    assert.equal(
      commands.some((c) => c.includes("--now") || c.includes(" start ")),
      false,
    );
  });

  it("keeps the unit when linger is denied", async () => {
    const unitDir = await mkdtemp(path.join(os.tmpdir(), "lr-unit-linger-"));
    const run = async (command: string): Promise<CommandResult> => {
      if (command === "loginctl") return { code: 1, stderr: "permission denied" };
      return { code: 0, stderr: "" };
    };
    const installed = await installRunnerUserService({
      plan: planRunnerUserService({
        execPath: "/usr/bin/node",
        entry: "/opt/prgenie/runner.cjs",
        buildRoot: null,
      }),
      unitDir,
      user: "brett",
      run,
    });
    assert.equal(installed.linger, false);
    assert.match(await readFile(installed.unitPath, "utf8"), /Type=oneshot/);
  });

  it("prefers dist/runner.cjs when launched from source", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lr-entry-"));
    const src = path.join(dir, "src", "bin.ts");
    const dist = path.join(dir, "dist", "runner.cjs");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(src), { recursive: true });
    await mkdir(path.dirname(dist), { recursive: true });
    await writeFile(src, "");
    await writeFile(dist, "");
    assert.equal(resolveServiceEntry(src), dist);
    assert.equal(resolveServiceEntry(src, "/opt/custom/runner.cjs"), "/opt/custom/runner.cjs");
  });
});
