import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunnerSettings } from "../settings.js";
import { parsePrePushCiSettings, resolvePrePushCiOverride } from "./settings.js";

describe("prePushCi settings (#255)", () => {
  it("parses per-repo overrides", () => {
    const settings = {
      jobTypes: {
        prePushCi: {
          byRepoSlug: {
            "acme/widget": { skip: true },
          },
          default: { forceFullSuite: true },
        },
      },
    } as unknown as RunnerSettings;
    const parsed = parsePrePushCiSettings(settings);
    assert.equal(parsed.byRepoSlug["acme/widget"]?.skip, true);
    assert.equal(parsed.defaultOverride?.forceFullSuite, true);
    const o = resolvePrePushCiOverride(parsed, "acme/widget", null);
    assert.equal(o?.skip, true);
  });
});
