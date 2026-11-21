import path from "node:path";
import type { RunnerSettings } from "../settings.js";
import type { ParsedPrePushCiSettings, PrePushCiRepoOverride } from "./types.js";

function normOverride(raw: unknown): PrePushCiRepoOverride | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: PrePushCiRepoOverride = {};
  if (typeof o.skip === "boolean") out.skip = o.skip;
  if (typeof o.forceFullSuite === "boolean") out.forceFullSuite = o.forceFullSuite;
  if (Array.isArray(o.checks)) {
    out.checks = o.checks.filter((c): c is string => typeof c === "string" && c.trim().length > 0);
  }
  if (o.commands && typeof o.commands === "object" && !Array.isArray(o.commands)) {
    const commands: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.commands as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) commands[k.trim()] = v.trim();
    }
    if (Object.keys(commands).length > 0) out.commands = commands;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normMap(raw: unknown): Record<string, PrePushCiRepoOverride> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, PrePushCiRepoOverride> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim();
    if (!key) continue;
    const parsed = normOverride(v);
    if (parsed) out[key] = parsed;
  }
  return out;
}

export function parsePrePushCiSettings(settings: RunnerSettings): ParsedPrePushCiSettings {
  const bag = settings.jobTypes?.prePushCi;
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) {
    return { byRepoSlug: {}, byRepoPath: {}, defaultOverride: null };
  }
  const o = bag as Record<string, unknown>;
  return {
    byRepoSlug: normMap(o.byRepoSlug),
    byRepoPath: normMap(o.byRepoPath),
    defaultOverride: normOverride(o.default),
  };
}

export function resolvePrePushCiOverride(
  parsed: ParsedPrePushCiSettings,
  repoSlug: string,
  repoPath: string | null | undefined,
): PrePushCiRepoOverride | null {
  const slug = repoSlug.trim();
  if (slug && parsed.byRepoSlug[slug]) return parsed.byRepoSlug[slug]!;
  const resolved = repoPath?.trim() ? path.resolve(repoPath.trim()) : "";
  if (resolved) {
    for (const [key, val] of Object.entries(parsed.byRepoPath)) {
      if (path.resolve(key) === resolved) return val;
    }
  }
  return parsed.defaultOverride;
}
