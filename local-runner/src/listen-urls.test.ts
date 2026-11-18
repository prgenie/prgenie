import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRunnerBindTarget, runnerListenUrls, urlHostForRequest } from "./listen-urls.js";

describe("runner listen URLs", () => {
  it("defaults to localhost URL", () => {
    assert.deepEqual(runnerListenUrls("127.0.0.1", 9473), ["http://127.0.0.1:9473/"]);
  });

  it("includes loopback and LAN hint when bound to all interfaces", () => {
    const urls = runnerListenUrls("0.0.0.0", 9473);
    assert.equal(urls[0], "http://127.0.0.1:9473/");
    assert.ok(urls.length >= 1);
  });

  it("maps 0.0.0.0 to loopback for request URL parsing", () => {
    assert.equal(urlHostForRequest("0.0.0.0"), "127.0.0.1");
  });

  it("names a specific bind host without a LAN note", () => {
    assert.equal(formatRunnerBindTarget("10.1.2.3", 9473, "192.168.1.20"), "10.1.2.3:9473");
    assert.equal(formatRunnerBindTarget("127.0.0.1", 9473), "127.0.0.1:9473");
  });

  it("names an all-interface bind and a LAN UI URL", () => {
    assert.equal(
      formatRunnerBindTarget("0.0.0.0", 9473, "192.168.1.20"),
      "0.0.0.0:9473 (reachable on your network; UI http://192.168.1.20:9473/)",
    );
    assert.equal(
      formatRunnerBindTarget("::", 9473, null),
      "[::]:9473 (reachable on your network; UI http://<lan-ip>:9473/)",
    );
  });
});
