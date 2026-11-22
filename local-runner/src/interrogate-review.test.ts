import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ShellRunResult } from "./interrogate-review.js";
import {
  buildCombinedInterrogateComment,
  challengerDroppedSelfReport,
  findingProvenOnRerun,
  interrogateReviewEnabled,
  mergeFindingsByRootCause,
  parseInterrogateFindings,
  parsePrimaryReviewVerdict,
  resolveInterrogateVerdict,
  rootCauseKey,
  verifyInterrogateFindings,
  CODE_INTERROGATE_CHALLENGER_SECTION,
} from "./interrogate-review.js";
import type { JobRecord } from "./types.js";
import type { RunnerSettings } from "./settings.js";
import { parseVerdictFromText } from "./github.js";

const baseSettings = (): RunnerSettings =>
  ({
    interrogateReview: false,
  }) as RunnerSettings;

const baseJob = (over: Partial<JobRecord> = {}): JobRecord =>
  ({
    input: {},
    effectiveSnapshot: undefined,
    ...over,
  }) as JobRecord;

describe("interrogate review (#249)", () => {
  it("is off by default in settings and jobs", () => {
    assert.equal(interrogateReviewEnabled(baseJob(), baseSettings()), false);
    const onSettings = { ...baseSettings(), interrogateReview: true } as RunnerSettings;
    assert.equal(interrogateReviewEnabled(baseJob(), onSettings), true);
    assert.equal(
      interrogateReviewEnabled(
        baseJob({ input: { interrogateReview: true } as JobRecord["input"] }),
        baseSettings(),
      ),
      true,
    );
    assert.equal(
      interrogateReviewEnabled(
        baseJob({
          input: { interrogateReview: false } as JobRecord["input"],
          effectiveSnapshot: { interrogateReview: true } as JobRecord["effectiveSnapshot"],
        }),
        baseSettings(),
      ),
      true,
    );
  });

  it("challenger prompt carries MIT attribution", () => {
    assert.match(CODE_INTERROGATE_CHALLENGER_SECTION, /Lauren Tan/);
    assert.match(CODE_INTERROGATE_CHALLENGER_SECTION, /interrogate/i);
  });

  it("parses structured challenger findings", () => {
    const text = `## Reported findings
### Empty mesh crash
- **Command:** \`pnpm test crash.test.ts\`
- **Output:**
\`\`\`
FAIL crash.test.ts
AssertionError: expected true to be false
\`\`\`
- **Required:**
\`\`\`
passing test
\`\`\`
## Dropped (self-reported)
- **Count:** 2
- **Why:** style only`;
    const parsed = parseInterrogateFindings(text);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.title, "Empty mesh crash");
    assert.equal(parsed[0]!.command, "pnpm test crash.test.ts");
    assert.match(parsed[0]!.reportedOutput, /AssertionError/);
    assert.equal(challengerDroppedSelfReport(text, "text"), 2);
  });

  it("rerun proof keeps findings whose output matches", () => {
    const finding = parseInterrogateFindings(
      `### Bug\n- **Command:** \`true\`\n- **Output:**\n\`\`\`\nFAIL test\n\`\`\`\n- **Required:**\n\`\`\`\nok\n\`\`\``,
    )[0]!;
    const rerun: ShellRunResult = { stdout: "FAIL test\n", stderr: "", exitCode: 1 };
    assert.equal(findingProvenOnRerun(finding, rerun), true);
    assert.equal(findingProvenOnRerun(finding, { stdout: "ok", stderr: "", exitCode: 0 }), false);
  });

  it("merges findings sharing a root cause", () => {
    const a = {
      title: "Null deref",
      command: "pnpm test a.test.ts",
      reportedOutput: "FAIL",
      requiredOutput: "",
      source: "challenger" as const,
      verifyOutput: "FAIL",
      verifyExitCode: 1,
      verified: true,
    };
    const b = { ...a, title: "NULL DEREF", reportedOutput: "FAIL again" };
    assert.equal(rootCauseKey(a), rootCauseKey(b));
    const merged = mergeFindingsByRootCause([a, b]);
    assert.equal(merged.length, 1);
    assert.match(merged[0]!.title, /Null deref/);
  });

  it("combined comment ends with exactly one VERDICT line", () => {
    const body = buildCombinedInterrogateComment({
      primaryText: "### What changed\n\nStuff.\n\nVERDICT: APPROVE",
      verified: [],
      dropped: {
        selfReportedCount: 1,
        runnerDroppedCount: 0,
        runnerDropReason: "n/a",
      },
      verdict: "APPROVE",
    });
    const matches = body.match(/^VERDICT: (APPROVE|CHANGES)\s*$/gm);
    assert.equal(matches?.length, 1);
    assert.equal(parseVerdictFromText(body), "APPROVE");
  });

  it("verified challenger findings force CHANGES even when primary approved", () => {
    assert.equal(
      resolveInterrogateVerdict("APPROVE", [
        {
          title: "x",
          command: "c",
          reportedOutput: "FAIL",
          requiredOutput: "",
          source: "challenger",
          verifyOutput: "FAIL",
          verifyExitCode: 1,
          verified: true,
        },
      ]),
      "CHANGES",
    );
    assert.equal(resolveInterrogateVerdict("APPROVE", []), "APPROVE");
  });

  it("verifyInterrogateFindings drops unproven findings and counts them", async () => {
    const findings = parseInterrogateFindings(
      `### A\n- **Command:** \`echo a\`\n- **Output:**\n\`\`\`\nA-out\n\`\`\`\n### B\n- **Command:** \`echo b\`\n- **Output:**\n\`\`\`\nB-out\n\`\`\``,
    );
    const result = await verifyInterrogateFindings("/tmp", findings, async (cmd) => ({
      stdout: cmd.includes("echo a") ? "A-out\n" : "unrelated\n",
      stderr: "",
      exitCode: 0,
    }));
    assert.equal(result.verified.length, 1);
    assert.equal(result.dropped.runnerDroppedCount, 1);
  });

  it("reads primary verdict from stream-json review output", () => {
    const out =
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Review.\\n\\nVERDICT: CHANGES"}]}}\n';
    assert.equal(parsePrimaryReviewVerdict(out, "stream-json"), "CHANGES");
  });
});
