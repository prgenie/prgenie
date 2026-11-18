import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { findBuildRoot } from "./runner-restart.js";

const execFileAsync = promisify(execFile);

export const PRGENIE_RUNNER_SERVICE_NAME = "prgenie-runner.service";

export type RunnerServicePlan = {
  execStart: string;
  workingDirectory: string | null;
  /** True when ExecStart includes `restart --build` (monorepo checkout). */
  usesBuild: boolean;
  host: string;
};

export type CommandResult = { code: number; stderr: string };

function quoteSystemdArg(arg: string): string {
  if (/^[\w./:@+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\])/g, "\\$1")}"`;
}

/** Prefer the built runner.cjs when install-service is launched from TypeScript source. */
export function resolveServiceEntry(argv1: string | undefined, envBinary?: string): string {
  if (envBinary?.trim()) return path.resolve(envBinary.trim());
  if (!argv1?.trim()) {
    throw new Error("cannot resolve runner entry (set PRGENIE_RUNNER_BINARY)");
  }
  const bundled = path.resolve(argv1);
  if (bundled.endsWith(`${path.sep}dist${path.sep}runner.cjs`)) return bundled;
  const dist = path.resolve(path.dirname(bundled), "..", "dist", "runner.cjs");
  if (existsSync(dist)) return dist;
  return bundled;
}

export function planRunnerUserService(opts: {
  execPath: string;
  entry: string;
  buildRoot: string | null;
  host?: string;
}): RunnerServicePlan {
  const args = [opts.execPath, opts.entry, "restart"];
  if (opts.buildRoot) args.push("--build");
  return {
    execStart: args.map(quoteSystemdArg).join(" "),
    workingDirectory: opts.buildRoot,
    usesBuild: Boolean(opts.buildRoot),
    host: opts.host?.trim() || "0.0.0.0",
  };
}

export function planRunnerUserServiceFromEntry(opts: {
  execPath: string;
  entry: string;
  host?: string;
}): RunnerServicePlan {
  return planRunnerUserService({
    execPath: opts.execPath,
    entry: opts.entry,
    buildRoot: findBuildRoot(opts.entry),
    host: opts.host,
  });
}

/** systemd user unit: oneshot restart, no git pull, detached workers survive stop. */
export function renderRunnerUserService(plan: RunnerServicePlan): string {
  const lines = [
    "[Unit]",
    "Description=PR Genie local runner",
    "After=network.target",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    "# Stop kills only this oneshot, not detached serve or job workers.",
    "KillMode=process",
    "# Rebuild and relaunch serve. Does not git pull.",
    `ExecStart=${plan.execStart}`,
  ];
  if (plan.workingDirectory) {
    lines.push(`WorkingDirectory=${quoteSystemdArg(plan.workingDirectory)}`);
  }
  lines.push(`Environment=PRGENIE_RUNNER_HOST=${plan.host}`);
  lines.push("");
  lines.push("[Install]");
  lines.push("WantedBy=default.target");
  lines.push("");
  return lines.join("\n");
}

async function defaultRun(command: string, args: string[]): Promise<CommandResult> {
  try {
    const { stderr } = await execFileAsync(command, args);
    return { code: 0, stderr: stderr ?? "" };
  } catch (err) {
    const e = err as { code?: number; stderr?: string; message?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stderr: e.stderr || e.message || "command failed",
    };
  }
}

export async function installRunnerUserService(opts: {
  plan: RunnerServicePlan;
  unitDir: string;
  user: string;
  enableLinger?: boolean;
  run?: (command: string, args: string[]) => Promise<CommandResult>;
}): Promise<{ unitPath: string; linger: boolean }> {
  const unitPath = path.join(opts.unitDir, PRGENIE_RUNNER_SERVICE_NAME);
  await mkdir(opts.unitDir, { recursive: true });
  await writeFile(unitPath, renderRunnerUserService(opts.plan), "utf8");

  const run = opts.run ?? defaultRun;
  const reload = await run("systemctl", ["--user", "daemon-reload"]);
  if (reload.code !== 0) {
    throw new Error(
      `wrote ${unitPath} but systemctl --user daemon-reload failed: ${reload.stderr.trim()}`,
    );
  }
  const enable = await run("systemctl", ["--user", "enable", PRGENIE_RUNNER_SERVICE_NAME]);
  if (enable.code !== 0) {
    throw new Error(
      `wrote ${unitPath} but systemctl --user enable failed: ${enable.stderr.trim()}`,
    );
  }

  let linger = false;
  if (opts.enableLinger !== false) {
    const lingerResult = await run("loginctl", ["enable-linger", opts.user]);
    linger = lingerResult.code === 0;
  }
  return { unitPath, linger };
}
