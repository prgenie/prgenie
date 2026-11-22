import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_REVIEW_PROMPT } from "./prompts.js";
import { DOCS_REVIEW_PROMPT } from "./docs-prompts.js";
import {
  CODE_REVIEW_BLAST_RADIUS_SECTION,
  DOCS_REVIEW_BLAST_RADIUS_SECTION,
  PSTACK_BLAST_RADIUS_ATTRIBUTION,
  REVIEW_COMMENT_HEADINGS,
  promptIncludesBlastRadiusReviewSection,
  reviewBlastRadiusGateApplies,
  reviewRoundSupplement,
} from "./blast-radius-review.js";

describe("blast-radius review prompt contract (#248)", () => {
  it("default code review prompt requires blast radius, safety proof, and structured comment", () => {
    assert.ok(DEFAULT_REVIEW_PROMPT.includes(CODE_REVIEW_BLAST_RADIUS_SECTION));
    assert.match(DEFAULT_REVIEW_PROMPT, /blast radius \(required\)/i);
    assert.match(DEFAULT_REVIEW_PROMPT, /caller list.*no run is not sufficient/i);
    assert.match(DEFAULT_REVIEW_PROMPT, /Unproven safety.*APPROVE/i);
    assert.match(DEFAULT_REVIEW_PROMPT, /VERDICT: APPROVE/);
    assert.match(DEFAULT_REVIEW_PROMPT, /Never use.*gh pr review/);
    for (const heading of REVIEW_COMMENT_HEADINGS) {
      assert.ok(DEFAULT_REVIEW_PROMPT.includes(heading), `missing ${heading}`);
    }
    assert.ok(DEFAULT_REVIEW_PROMPT.includes(PSTACK_BLAST_RADIUS_ATTRIBUTION));
    assert.equal(promptIncludesBlastRadiusReviewSection(DEFAULT_REVIEW_PROMPT), true);
  });

  it("docs review prompt has a proportional blast-radius bar", () => {
    assert.ok(DOCS_REVIEW_PROMPT.includes(DOCS_REVIEW_BLAST_RADIUS_SECTION));
    assert.match(DOCS_REVIEW_PROMPT, /broken links/i);
    assert.match(DOCS_REVIEW_PROMPT, /paths outside/i);
    assert.match(DOCS_REVIEW_PROMPT, /URL lists with no fetch/i);
    for (const heading of REVIEW_COMMENT_HEADINGS) {
      assert.ok(DOCS_REVIEW_PROMPT.includes(heading), `missing ${heading}`);
    }
    assert.ok(DOCS_REVIEW_PROMPT.includes(PSTACK_BLAST_RADIUS_ATTRIBUTION));
  });

  it("custom reviewPromptFile opts out of the default blast-radius contract", () => {
    assert.equal(reviewBlastRadiusGateApplies(""), true);
    assert.equal(reviewBlastRadiusGateApplies("prompts/review.md"), false);
    assert.equal(promptIncludesBlastRadiusReviewSection("You are the reviewer.\n"), false);
  });

  it("appends re-review context for rounds after the first", () => {
    assert.equal(reviewRoundSupplement(1), "");
    assert.match(reviewRoundSupplement(2), /Re-review round 2/);
    assert.match(reviewRoundSupplement(3), /safety fact/i);
  });
});
