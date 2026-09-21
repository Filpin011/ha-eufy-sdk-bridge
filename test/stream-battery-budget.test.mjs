// A watched battery stream must not be cut every ~55s. The SDK bounds a battery session to a budget (45s)
// plus a grace (10s) and stops it unless the caller extends it; /stream consumes a Readable, which has no
// way to extend, so the only lever is the budget the session is opened with. STREAM_BATTERY_BUDGET_MS
// sets it; unset must leave the SDK's own default untouched.
import { Readable } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";

process.env.BRIDGE_STREAM_CONSUMER_LOG_MS = "0"; // no real HTTP at :1984 from the consumer probe
const { createHttpHandler } = await import("../src/http-routes.mjs");

/** A handler over a fake camera that records the options each openReadable() call received. */
function setup(env = {}) {
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", ...env });
  const state = createState();
  state.flags.ready = true;
  const opened = [];
  const ctx = {
    ...config,
    state,
    eventLog: () => {},
    broadcast: () => {},
    noteStreamOpened: () => {},
    noteStreamFailure: () => {},
    streamBackoffMs: () => 0,
    streamClientFor: async () => ({
      getDevice: async () => ({
        camera: () => ({
          openReadable: async (opts) => {
            opened.push(opts);
            return Readable.from([Buffer.from("frame")]); // one chunk of "video", then the end
          },
        }),
      }),
    }),
  };
  return { handler: createHttpHandler(ctx), opened };
}

async function pull(handler) {
  const out = {};
  const res = {
    writeHead(code) { out.code = code; },
    write() { return true; },
    end() {},
    on() {}, once() {}, emit() {}, removeListener() {}, off() {}, destroy() {},
  };
  await handler({ url: "/stream/CAM1", headers: { host: "localhost" }, on() {} }, res);
  return out;
}

test("unset leaves the SDK's own battery budget alone", async () => {
  const { handler, opened } = setup();
  const out = await pull(handler);
  assert.equal(out.code, 200);
  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.batteryBudgetMs, undefined); // no option at all → the SDK default (45s) applies
});

test("STREAM_BATTERY_BUDGET_MS is handed to the session the stream opens", async () => {
  const { handler, opened } = setup({ STREAM_BATTERY_BUDGET_MS: "180000" });
  const out = await pull(handler);
  assert.equal(out.code, 200);
  assert.equal(opened[0].batteryBudgetMs, 180000);
});

test("a value that is not a positive whole number falls back to the SDK default", () => {
  for (const bad of ["0", "-5", "abc", "1.5", ""]) {
    const { cfg } = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", STREAM_BATTERY_BUDGET_MS: bad });
    assert.equal(cfg.streamBatteryBudgetMs, undefined, `"${bad}" must not reach the SDK`);
  }
});
