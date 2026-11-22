import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROVE_EVIDENCE_HEADING } from "../prove-it-works.js";
import { formatPrePushCiEvidence } from "./evidence.js";

describe("pre-push CI evidence (#255)", () => {
  it("formats command, scope, and exit code per check", () => {
    const text = formatPrePushCiEvidence([
      {
        name: "format:check",
        command: "pnpm exec prettier --check a.ts",
        scope: "a.ts",
        exitCode: 0,
        excerpt: "All matched files use Prettier code style!",
        passed: true,
      },
    ]);
    assert.ok(text.startsWith(PROVE_EVIDENCE_HEADING));
    assert.match(text, /format:check/);
    assert.match(text, /scope: a\.ts/);
    assert.match(text, /exit 0/);
  });
});
