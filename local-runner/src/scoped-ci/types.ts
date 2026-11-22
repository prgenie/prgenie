export type CiCheckMapping = {
  check: string;
  reason: string;
};

export type CiCheckSelection = {
  checks: string[];
  reason: string[];
  mapping: CiCheckMapping[];
  uncertain: boolean;
  changedPaths: string[];
  packageScoped?: boolean;
  skipped?: boolean;
  testFiles?: Record<string, string[]>;
};

export type PrePushCiRepoOverride = {
  /** When true, skip the runner pre-push CI gate for matching repos. */
  skip?: boolean;
  /** Force this check list (full commands are still resolved per repo). */
  checks?: string[];
  /** Per-check shell command override (`format:check` → `pnpm format:check`). */
  commands?: Record<string, string>;
  /** When true, always run the discovered full suite (ignore narrow scoping). */
  forceFullSuite?: boolean;
};

export type ParsedPrePushCiSettings = {
  byRepoSlug: Record<string, PrePushCiRepoOverride>;
  byRepoPath: Record<string, PrePushCiRepoOverride>;
  defaultOverride: PrePushCiRepoOverride | null;
};

export type PrePushCiCheckResult = {
  name: string;
  command: string;
  scope: string;
  exitCode: number;
  excerpt: string;
  passed: boolean;
  autoFixed?: boolean;
};

export type PrePushCiGateResult = {
  ok: boolean;
  skipped?: boolean;
  skipReason?: string;
  results: PrePushCiCheckResult[];
  evidenceText: string;
  error?: string;
};
