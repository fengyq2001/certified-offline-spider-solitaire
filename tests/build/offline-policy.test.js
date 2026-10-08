import assert from "node:assert/strict";
import test from "node:test";

import { assertOfflineSource } from "../../scripts/verify-dist.js";

test("offline scanner permits literal local fetch and bundled dynamic import", () => {
  assert.equal(assertOfflineSource('fetch("./data/local.json"); import("app:/runtime/index.js");', "fixture"), true);
});

const blocked = [
  ["remote literal", 'const endpoint = "https://example.invalid/api";', /remote URL literal/],
  ["dynamic fetch", 'const endpoint = "ht" + "tps://example.invalid"; fetch(endpoint);', /fetch with a dynamic URL/],
  ["XHR", "const request = new XMLHttpRequest();", /XMLHttpRequest/],
  ["sendBeacon", 'navigator.sendBeacon("/metrics", body);', /sendBeacon/],
  ["Worker", 'new Worker("worker.js");', /Worker or SharedWorker/],
  ["SharedWorker", 'new SharedWorker("worker.js");', /Worker or SharedWorker/],
  ["importScripts", 'importScripts("worker.js");', /importScripts/],
  ["WebSocket", 'new WebSocket("/socket");', /WebSocket or EventSource/],
  ["EventSource", 'new EventSource("/events");', /WebSocket or EventSource/],
  ["dynamic import", "const moduleUrl = chooseModule(); import(moduleUrl);", /import\(\) with a dynamic URL/],
];

for (const [name, source, error] of blocked) {
  test(`offline scanner rejects ${name}`, () => {
    assert.throws(() => assertOfflineSource(source, "fixture"), error);
  });
}
