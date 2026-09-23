import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";
const base = { EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" };
test("event log is ON by default", () => {
  assert.equal(loadConfig(base).EVENT_LOG, true);
});
test("BRIDGE_EVENT_LOG=0 silences it", () => {
  assert.equal(loadConfig({ ...base, BRIDGE_EVENT_LOG: "0" }).EVENT_LOG, false);
  assert.equal(loadConfig({ ...base, BRIDGE_EVENT_LOG: "false" }).EVENT_LOG, false);
  assert.equal(loadConfig({ ...base, BRIDGE_EVENT_LOG: "1" }).EVENT_LOG, true);
});
