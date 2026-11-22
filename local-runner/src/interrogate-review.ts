/**
 * Adapted from pstack "Interrogate" (MIT, Copyright (c) 2026 Lauren Tan).
 * @see https://github.com/cursor/plugins/tree/main/pstack/skills/interrogate
 */
import { exec } from "node:child_process";
import type { Verdict } from "./github.js";
import type { JobRecord } from "./types.js";
import type { RunnerSettings } from "./settings.js";
import { reviewerFinalText } from "./review-verdict.js";
import { parseVerdictFromText } from "./github.js";

export const PSTACK_INTERROGATE_ATTRIBUTION =
  'Adapted from pstack "Interrogate" (MIT, Copyright (c) 2026 Lauren Tan).';

export const INTERROGATE_FINDING_HEADING = "## Interrogate findings (runner-verified)";

export const CODE_INTERROGATE_CHALLENGER_SECTION = `## Challenger (adversarial review)
You are the **challenger**: try to **break** this change. Do not merge, push, or implement fixes. Do not open a GitHub pull request comment or use review APIs.

For each issue you believe exists, **run** the real code (failing test, repro script, or command that shows wrong behavior) in this checkout. Report only findings you actually ran.

Use this structure in your final message:

## Reported findings
For each finding, use a \`### Title\` heading and these bullets:
- **Command:** the exact shell command (in backticks)
- **Output:** fenced code block with the command output you saw
- **Required:** fenced code block describing what output the intent requires (or expected failure)

## Dropped (self-reported)
- **Count:** number of findings you considered but did not run
- **Why:** one line on why they were dropped (style-only, unrun theory, etc.)

If you have no run-backed findings, say so under **## Reported findings** as "none".

Do not end with VERDICT; the runner posts one combined comment after verification.

${PSTACK_INTERROGATE_ATTRIBUTION}`;

export const DOCS_INTERROGATE_CHALLENGER_SECTION = `## Challenger (adversarial review, proportional)
You are the **challenger** for a documentation PR: try to **break** reader trust (broken links, wrong paths, contradictions with code). Do not fix or post PR comments.

Prove each finding with a real fetch or filesystem check. Use the same **## Reported findings** / **## Dropped (self-reported)** structure as the code challenger brief.

${PSTACK_INTERROGATE_ATTRIBUTION}`;

/** When interrogate is on, the primary reviewer returns text locally; the runner posts one combined comment. */
export const INTERROGATE_PRIMARY_REVIEW_SUPPLEMENT = `

## Interrogate (runner)
A second challenger model will stress-test this change after you finish. Do **not** post a GitHub PR comment this round — put your full review (including required blast-radius sections and a \`VERDICT:\` line) in your final message only. The runner will verify challenger findings and post exactly one combined PR comment.`;

export type ShellRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type InterrogateFinding = {
  title: string;
  command: string;
  reportedOutput: string;
  requiredOutput: string;
  source: "challenger";
};

export type VerifiedInterrogateFinding = InterrogateFinding & {
  verifyOutput: string;
  verifyExitCode: number | null;
  verified: boolean;
};

export type InterrogateDroppedSummary = {
  selfReportedCount: number;
  runnerDroppedCount: number;
  runnerDropReason: string;
};

export function interrogateReviewEnabled(job: JobRecord, settings: RunnerSettings): boolean {
  const snap = job.effectiveSnapshot?.interrogateReview;
  if (snap !== undefined) return Boolean(snap);
  if (job.input.interrogateReview !== undefined) return Boolean(job.input.interrogateReview);
  return Boolean(settings.interrogateReview);
}

export function promptIncludesInterrogateChallengerSection(prompt: string): boolean {
  return (
    prompt.includes(CODE_INTERROGATE_CHALLENGER_SECTION) ||
    prompt.includes(DOCS_INTERROGATE_CHALLENGER_SECTION)
  );
}

function stripVerdictTail(text: string): string {
  const lines = text.split("\n");
  while (
    lines.length > 0 &&
    /^VERDICT:\s*(APPROVE|CHANGES)\s*$/i.test(lines[lines.length - 1]!.trim())
  ) {
    lines.pop();
  }
  return lines.join("\n").trimEnd();
}

const FENCED = /```[^\n]*\n([\s\S]*?)```/g;

function extractFieldBlock(section: string, label: string): string {
  const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\n-\\s*\\*\\*|\\n###\\s|$)`, "i");
  const m = section.match(re);
  if (!m) return "";
  const raw = m[1]!.trim();
  const fence = [...raw.matchAll(FENCED)][0];
  if (fence) return fence[1]!.trimEnd();
  return raw.replace(/^`([^`]+)`$/, "$1").trim();
}

function parseDroppedSelfReport(text: string): number {
  const m = text.match(/\*\*Count:\*\*\s*(\d+)/i);
  if (m) return Math.max(0, parseInt(m[1]!, 10));
  const section = text.match(/##\s*Dropped[\s\S]*$/i)?.[0] ?? "";
  const alt = section.match(/Count:\s*(\d+)/i);
  return alt ? Math.max(0, parseInt(alt[1]!, 10)) : 0;
}

/** Parse challenger agent output into structured findings (pre-verification). */
export function parseInterrogateFindings(text: string): InterrogateFinding[] {
  const body = text.trim();
  if (!body || (/\bnone\b/i.test(body) && !/^###\s/m.test(body))) return [];
  const findings: InterrogateFinding[] = [];
  const parts = body.split(/^###\s+/m).slice(1);
  for (const chunk of parts) {
    const nl = chunk.indexOf("\n");
    if (nl < 0) continue;
    const title = chunk.slice(0, nl).trim();
    const section = chunk.slice(nl + 1);
    if (/^Dropped\b/i.test(title)) continue;
    const command = extractFieldBlock(section, "Command");
    const reportedOutput = extractFieldBlock(section, "Output");
    const requiredOutput = extractFieldBlock(section, "Required");
    if (!command.trim() || !reportedOutput.trim()) continue;
    findings.push({
      title,
      command: command.trim(),
      reportedOutput,
      requiredOutput,
      source: "challenger",
    });
  }
  return findings;
}

export function findingProvenOnRerun(finding: InterrogateFinding, rerun: ShellRunResult): boolean {
  const combined = `${rerun.stdout}\n${rerun.stderr}`.trim();
  if (!combined) return false;
  const reported = finding.reportedOutput.trim();
  const lines = reported
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 4);
  if (lines.some((line) => combined.includes(line))) return true;
  if (
    reported.length >= 12 &&
    combined.includes(reported.slice(0, Math.min(80, reported.length)))
  ) {
    return true;
  }
  const wantsFailure =
    /\bfail(ure|ed)?\b/i.test(reported) ||
    /\berror\b/i.test(reported) ||
    /\bassert(ion)?\b/i.test(reported);
  if (wantsFailure && rerun.exitCode !== null && rerun.exitCode !== 0) return true;
  const required = finding.requiredOutput.trim();
  if (required && !combined.includes(required.slice(0, Math.min(60, required.length)))) {
    return true;
  }
  return false;
}

export function rootCauseKey(finding: Pick<InterrogateFinding, "title" | "command">): string {
  const title = finding.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const cmd = finding.command.replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ");
  return `${title}|${cmd}`;
}

/** Merge verified findings that share a root cause (keep the first, annotate others). */
export function mergeFindingsByRootCause(
  findings: VerifiedInterrogateFinding[],
): VerifiedInterrogateFinding[] {
  const byKey = new Map<string, VerifiedInterrogateFinding>();
  for (const f of findings) {
    if (!f.verified) continue;
    const key = rootCauseKey(f);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...f });
      continue;
    }
    const titles = new Set([prev.title, f.title]);
    byKey.set(key, {
      ...prev,
      title: [...titles].join(" / "),
      reportedOutput: `${prev.reportedOutput}\n---\n${f.reportedOutput}`,
    });
  }
  return [...byKey.values()];
}

export function resolveInterrogateVerdict(
  primaryVerdict: Verdict,
  verifiedFindings: VerifiedInterrogateFinding[],
): Verdict {
  if (verifiedFindings.some((f) => f.verified)) return "CHANGES";
  return primaryVerdict;
}

export function buildCombinedInterrogateComment(opts: {
  primaryText: string;
  verified: VerifiedInterrogateFinding[];
  dropped: InterrogateDroppedSummary;
  verdict: Verdict;
}): string {
  const primary = stripVerdictTail(opts.primaryText.trim());
  const lines: string[] = [];
  lines.push(primary);
  lines.push("");
  lines.push(INTERROGATE_FINDING_HEADING);
  if (opts.verified.length === 0) {
    lines.push("No verified challenger findings.");
  } else {
    for (const f of opts.verified) {
      lines.push("");
      lines.push(`### ${f.title}`);
      lines.push(`- **Command:** \`${f.command}\``);
      lines.push("- **Challenger output:**");
      lines.push("```");
      lines.push(f.reportedOutput);
      lines.push("```");
      lines.push("- **Runner re-run output:**");
      lines.push("```");
      lines.push(f.verifyOutput);
      lines.push("```");
    }
  }
  lines.push("");
  lines.push("### Dropped findings");
  lines.push(`- Challenger self-reported dropped: ${opts.dropped.selfReportedCount}`);
  lines.push(
    `- Runner dropped (unproven on re-run): ${opts.dropped.runnerDroppedCount} — ${opts.dropped.runnerDropReason}`,
  );
  lines.push("");
  lines.push(`VERDICT: ${opts.verdict}`);
  return lines.join("\n");
}

export async function shellRunCommand(
  cwd: string,
  command: string,
  timeoutMs = 120_000,
): Promise<ShellRunResult> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const exitCode =
          err && typeof err === "object" && "code" in err && typeof err.code === "number"
            ? err.code
            : err
              ? 1
              : 0;
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          exitCode,
        });
      },
    );
  });
}

export async function verifyInterrogateFindings(
  cwd: string,
  findings: InterrogateFinding[],
  run: (command: string, cwd: string) => Promise<ShellRunResult> = (cmd, c) =>
    shellRunCommand(c, cmd),
): Promise<{ verified: VerifiedInterrogateFinding[]; dropped: InterrogateDroppedSummary }> {
  const verified: VerifiedInterrogateFinding[] = [];
  let runnerDropped = 0;
  for (const finding of findings) {
    const rerun = await run(finding.command, cwd);
    const ok = findingProvenOnRerun(finding, rerun);
    const entry: VerifiedInterrogateFinding = {
      ...finding,
      verifyOutput: `${rerun.stdout}${rerun.stderr ? `\n${rerun.stderr}` : ""}`.trimEnd(),
      verifyExitCode: rerun.exitCode,
      verified: ok,
    };
    verified.push(entry);
    if (!ok) runnerDropped += 1;
  }
  const merged = mergeFindingsByRootCause(verified);
  return {
    verified: merged,
    dropped: {
      selfReportedCount: 0,
      runnerDroppedCount: runnerDropped,
      runnerDropReason: "re-run did not reproduce the reported failure output",
    },
  };
}

export function parsePrimaryReviewVerdict(
  output: string,
  format: "stream-json" | "text",
): Verdict | null {
  return parseVerdictFromText(reviewerFinalText(output, format));
}

export function challengerDroppedSelfReport(
  output: string,
  format: "stream-json" | "text",
): number {
  return parseDroppedSelfReport(reviewerFinalText(output, format));
}
