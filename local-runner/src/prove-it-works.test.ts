import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_FIX_PROMPT, DEFAULT_IMPLEMENT_PROMPT } from "./prompts.js";
import { DOCS_MARKETING_PROMPT, resolveDocsFixPrompt } from "./docs-prompts.js";
import {
  CODE_PROVE_IT_WORKS_SECTION,
  DOCS_PROVE_IT_WORKS_SECTION,
  PROVE_EVIDENCE_HEADING,
  PSTACK_PROVE_IT_WORKS_ATTRIBUTION,
  hasProveEvidence,
  proveEvidenceGateApplies,
  promptIncludesProveItWorksSection,
} from "./prove-it-works.js";

const SAMPLE_EVIDENCE = `${PROVE_EVIDENCE_HEADING}
$ pnpm test local-runner/src/prove-it-works.test.ts
✓ prove-it-works prompt contract (#246) (4 tests)
✓ 200 passing
`;

describe("prove-it-works prompt contract (#246)", () => {
  it("default implement and fix prompts require real evidence and reject proxies", () => {
    for (const prompt of [DEFAULT_IMPLEMENT_PROMPT, DEFAULT_FIX_PROMPT]) {
      assert.match(prompt, /Prove it works/i);
      assert.match(prompt, /Proxies do not count/i);
      assert.match(prompt, /self-reports/i);
      assert.match(prompt, new RegExp(PROVE_EVIDENCE_HEADING.replace(":", "\\:")));
      assert.match(prompt, /each.*CI command/i);
      assert.ok(prompt.includes(PSTACK_PROVE_IT_WORKS_ATTRIBUTION));
    }
    assert.ok(DEFAULT_IMPLEMENT_PROMPT.includes(CODE_PROVE_IT_WORKS_SECTION));
    assert.ok(DEFAULT_FIX_PROMPT.includes(CODE_PROVE_IT_WORKS_SECTION));
  });

  it("docs implement and fix prompts require source/path verification evidence", () => {
    assert.ok(DOCS_MARKETING_PROMPT.includes(DOCS_PROVE_IT_WORKS_SECTION));
    assert.match(DOCS_MARKETING_PROMPT, /fetch or open the sources/i);
    assert.match(resolveDocsFixPrompt(), /Markdown doc feedback/i);
    assert.ok(resolveDocsFixPrompt().includes(DOCS_PROVE_IT_WORKS_SECTION));
  });

  it("parses PROVE: EVIDENCE with command output from text and stream-json", () => {
    assert.equal(hasProveEvidence(SAMPLE_EVIDENCE, "text"), true);
    assert.equal(
      hasProveEvidence(
        `{"type":"result","result":${JSON.stringify(SAMPLE_EVIDENCE)}}\n`,
        "stream-json",
      ),
      true,
    );
    assert.equal(hasProveEvidence("done\n", "text"), false);
    assert.equal(hasProveEvidence(`${PROVE_EVIDENCE_HEADING}\nshort`, "text"), false);
  });

  it("gates default prompts only when no custom prompt file is set", () => {
    assert.equal(proveEvidenceGateApplies(""), true);
    assert.equal(proveEvidenceGateApplies("prompts/x.md"), false);
    assert.equal(promptIncludesProveItWorksSection(DEFAULT_IMPLEMENT_PROMPT), true);
    assert.equal(promptIncludesProveItWorksSection("Build the feature.\n"), false);
  });
});
