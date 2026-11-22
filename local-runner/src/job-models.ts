import type { RunnerConfig } from "./config.js";
import type { JobInput, JobRecord } from "./types.js";
import {
  BUILTIN_CHALLENGER_MODEL,
  BUILTIN_FIX_MODEL,
  BUILTIN_REREVIEW_MODEL,
} from "./runner-policy.js";
import type { RunnerSettings, StageModelDefaults } from "./settings.js";
import { ValidationError } from "./validation-error.js";

export type ResolvedStageModels = {
  build: string;
  review: string;
  rereview: string;
  fix: string;
  challenger: string;
};

export type ModelSource = "job" | "preset" | "settings" | "env" | "builtin";

export type ResolvedStageModelsWithSources = ResolvedStageModels & {
  sources: Record<keyof ResolvedStageModels, ModelSource>;
};

/** Only cursor-agent resolves the `auto` model id; claude/ollama would receive it literally. */
const AUTO_SUPPORTED_DRIVERS = new Set(["cursor-agent"]);

export function driverSupportsAuto(driverId: string): boolean {
  return AUTO_SUPPORTED_DRIVERS.has(driverId.trim());
}

export function normalizeStageModels(
  raw: Partial<StageModelDefaults> | undefined,
): StageModelDefaults {
  return {
    build: typeof raw?.build === "string" && raw.build.trim() ? raw.build.trim() : null,
    review: typeof raw?.review === "string" && raw.review.trim() ? raw.review.trim() : null,
    rereview: typeof raw?.rereview === "string" && raw.rereview.trim() ? raw.rereview.trim() : null,
    fix: typeof raw?.fix === "string" && raw.fix.trim() ? raw.fix.trim() : null,
    challenger:
      typeof raw?.challenger === "string" && raw.challenger.trim() ? raw.challenger.trim() : null,
  };
}

type ModelCandidate = readonly [value: string | null | undefined, source: ModelSource];

type ResolvedModel = { value: string; source: ModelSource };

function firstModel(candidates: ModelCandidate[], fallback: ResolvedModel): ResolvedModel {
  for (const [value, source] of candidates) {
    const v = value?.trim();
    if (v) return { value: v, source };
  }
  return fallback;
}

function challengerFallback(
  review: ResolvedModel,
  rereview: ResolvedModel,
  supportsAuto: boolean,
): ResolvedModel {
  if (rereview.value !== review.value) return rereview;
  if (supportsAuto) return { value: BUILTIN_CHALLENGER_MODEL, source: "builtin" };
  return rereview;
}

/**
 * Resolve per-stage models at job creation. Each stage takes the first value set, in order:
 * request `stageModels[stage]`, request `model` (legacy, every stage), settings
 * `stageModels[stage]`, the stage default (build: settings `defaultModel`; review: the settings
 * build model; re-review: `auto` on drivers that support it, else the review model; fix: `auto`
 * on drivers that support it, else the build model; challenger: `auto` when supported, else
 * re-review when it differs from review), then the env model.
 */
export function resolveStageModelsForJob(
  config: RunnerConfig,
  settings: RunnerSettings,
  input: JobInput,
  driverId: string,
): ResolvedStageModelsWithSources {
  const supportsAuto = driverSupportsAuto(driverId);
  const requested = input.stageModels;
  const requestAll = input.model;
  const defaults = settings.stageModels;
  const env: ResolvedModel = { value: config.defaultModel, source: "env" };

  const settingsBuild: ModelCandidate[] = [
    [defaults.build, "settings"],
    [settings.defaultModel, "settings"],
  ];
  const build = firstModel([[requested?.build, "job"], [requestAll, "job"], ...settingsBuild], env);
  const review = firstModel(
    [
      [requested?.review, "job"],
      [requestAll, "job"],
      [defaults.review, "settings"],
      ...settingsBuild,
    ],
    env,
  );
  const settingsRereview = defaults.rereview?.trim();
  const rereview = firstModel(
    [
      [requested?.rereview, "job"],
      [requestAll, "job"],
      [settingsRereview === "auto" && !supportsAuto ? null : settingsRereview, "settings"],
      [supportsAuto ? BUILTIN_REREVIEW_MODEL : null, "builtin"],
    ],
    review,
  );
  const settingsFix = defaults.fix?.trim();
  const fix = firstModel(
    [
      [requested?.fix, "job"],
      [requestAll, "job"],
      [settingsFix === "auto" && !supportsAuto ? null : settingsFix, "settings"],
      [supportsAuto ? BUILTIN_FIX_MODEL : null, "builtin"],
    ],
    build,
  );
  const settingsChallenger = defaults.challenger?.trim();
  let challenger = firstModel(
    [
      [requested?.challenger, "job"],
      [settingsChallenger === "auto" && !supportsAuto ? null : settingsChallenger, "settings"],
      [supportsAuto ? BUILTIN_CHALLENGER_MODEL : null, "builtin"],
    ],
    challengerFallback(review, rereview, supportsAuto),
  );
  if (challenger.value === review.value && rereview.value !== review.value) {
    challenger = { ...rereview };
  }

  for (const [stage, model] of [
    ["fix", fix.value],
    ["build", build.value],
    ["review", review.value],
    ["rereview", rereview.value],
    ["challenger", challenger.value],
  ] as const) {
    if (model === "auto" && !supportsAuto) {
      throw new ValidationError(
        `driver ${driverId} does not support model "auto" for ${stage} stage`,
      );
    }
  }

  return {
    build: build.value,
    review: review.value,
    rereview: rereview.value,
    fix: fix.value,
    challenger: challenger.value,
    sources: {
      build: build.source,
      review: review.source,
      rereview: rereview.source,
      fix: fix.source,
      challenger: challenger.source,
    },
  };
}

/** `rereview` is review round 2 and later; earlier review rounds use `review`. */
export function stageModelKeyForRun(
  stage: "building" | "reviewing" | "fixing",
  reviewRound: number,
): keyof Pick<ResolvedStageModels, "build" | "review" | "rereview" | "fix"> {
  if (stage === "building") return "build";
  if (stage === "fixing") return "fix";
  return reviewRound >= 2 ? "rereview" : "review";
}

export function modelForActiveStage(
  job: JobRecord,
  stage: "building" | "reviewing" | "fixing",
): string {
  const models = job.stageModels;
  if (!models) return job.model;
  const key = stageModelKeyForRun(stage, job.reviewRound);
  const actual = job.stageModelActual?.[key];
  if (actual) return actual;
  if (key === "rereview") return models.rereview || models.review;
  return models[key];
}

export function challengerModelForJob(job: JobRecord): string {
  const models = job.stageModels;
  if (!models) return job.model;
  return job.stageModelActual?.challenger ?? models.challenger ?? models.rereview ?? models.review;
}

export function recordActualModel(
  job: JobRecord,
  stage: keyof ResolvedStageModels,
  model: string,
): void {
  if (!job.stageModelActual) job.stageModelActual = {};
  job.stageModelActual[stage] = model;
}
