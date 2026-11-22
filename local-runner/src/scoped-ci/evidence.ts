import { PROVE_EVIDENCE_HEADING } from "../prove-it-works.js";
import type { PrePushCiCheckResult } from "./types.js";

function excerpt(text: string, max = 400): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

export function formatPrePushCiEvidence(results: PrePushCiCheckResult[]): string {
  const lines = [PROVE_EVIDENCE_HEADING, "Runner pre-push CI (scoped):"];
  for (const r of results) {
    const status = r.passed ? "pass" : "fail";
    const fix = r.autoFixed ? " (auto-fixed format)" : "";
    lines.push(`- ${r.name}: exit ${r.exitCode} (${status}${fix})`);
    lines.push(`  scope: ${r.scope}`);
    lines.push(`  $ ${r.command}`);
    if (r.excerpt) lines.push(`  ${excerpt(r.excerpt)}`);
  }
  return lines.join("\n");
}

export function proveEvidenceIncludesPrePushCi(
  output: string,
  results: PrePushCiCheckResult[],
): boolean {
  if (results.length === 0) return true;
  const lower = output.toLowerCase();
  if (lower.includes("pre-push ci") || lower.includes("format:check")) {
    for (const r of results) {
      if (!lower.includes(r.name.toLowerCase())) continue;
    }
    return true;
  }
  return false;
}
