import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

// Small cooldown so the "re-fires after cooldown" case doesn't slow the suite. Set BEFORE importing
// warmup, which reads it into a module const at load — hence the dynamic import below.
process.env.EVENT_IMAGE_AUTOHEAL_COOLDOWN_MS = "40";
const { createWarmup } = await import("../src/warmup.mjs");

/** A warmup bound to a fake SDK that counts how many times the local-cover refresh actually runs. */
function setup() {
  let refreshRuns = 0;
  const ctx = {
    eventImageDir: os.tmpdir(),
    eventLog: () => {},
    broadcast: () => {},
    state: { faceNames: new Map() },
    eufy: {
      // The refresh acquires the DB lock, then bails on an empty session set — a fast no-op that still
      // proves it ran (this is the only call before the early return).
      getP2pSessions: () => {
        refreshRuns += 1;
        return new Map();
      },
    },
  };
  return { warm: createWarmup(ctx), runs: () => refreshRuns };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("autoHealEventImage runs the local-cover refresh once, then throttles a burst", async () => {
  const { warm, runs } = setup();

  warm.autoHealEventImage("SN1");
  await tick();
  assert.equal(runs(), 1); // first fetch triggers a refresh

  warm.autoHealEventImage("SN1");
  warm.autoHealEventImage("SN1");
  await tick();
  assert.equal(runs(), 1); // repeated fetches within the cooldown do NOT re-query the HomeBase
});

test("autoHealEventImage re-fires after the cooldown elapses", async () => {
  const { warm, runs } = setup();

  warm.autoHealEventImage("SN1");
  await tick();
  assert.equal(runs(), 1);

  await new Promise((r) => setTimeout(r, 60)); // > cooldown (40ms)
  warm.autoHealEventImage("SN1");
  await tick();
  assert.equal(runs(), 2);
});

test("autoHealEventImage ignores a missing serial", async () => {
  const { warm, runs } = setup();
  warm.autoHealEventImage(undefined);
  warm.autoHealEventImage("");
  await tick();
  assert.equal(runs(), 0);
});

/** A warmup whose SDK lists the given sessions and records whether the device list was read. */
function withSessions(entries) {
  let listed = false;
  const warm = createWarmup({
    eventImageDir: os.tmpdir(),
    eventLog: () => {},
    broadcast: () => {},
    state: { faceNames: new Map() },
    eufy: {
      getP2pSessions: () => new Map(entries),
      getDevices: async () => {
        listed = true;
        return [];
      },
    },
  });
  return { warm, listed: () => listed };
}

test("refreshLastEventImageFor skips a camera's media session (only stations hold the DB)", async () => {
  const { warm, listed } = withSessions([["T8030P0000000000#live:1", { isConnected: true }]]);
  assert.equal(await warm.refreshLastEventImageFor("SN1"), false);
  assert.equal(listed(), false); // bailed before any query: no station session to run one on
});

test("refreshLastEventImageFor still considers a station's own session", async () => {
  const { warm, listed } = withSessions([
    ["T8030P0000000000", { isConnected: false }],
    ["T8030P0000000000#live:1", { isConnected: true }],
  ]);
  assert.equal(await warm.refreshLastEventImageFor("SN1"), false);
  assert.equal(listed(), true); // the station session kept the refresh going
});
