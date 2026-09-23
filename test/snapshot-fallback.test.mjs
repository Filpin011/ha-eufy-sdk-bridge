// /snapshot must never answer "no image" while a persisted last-event thumbnail sits on disk: a caller
// that gets nothing falls back to pulling video, which wakes a battery camera for a picture we already
// have. Drives the real handler against a fake SDK camera whose live/stored paths fail the way an
// account without push thumbnails fails.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0xff, 0xd9]); // enough to be recognisable

/** A handler over a fake camera; `live` / `stored` decide how those two paths behave. */
function setup({ live, stored, env = {}, persist = true, battery = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
  if (persist) fs.writeFileSync(path.join(dir, "last-event-CAM1.jpg"), JPEG);
  const calls = { live: 0, stored: 0 };
  const cam = {
    snapshotLive: async () => {
      calls.live += 1;
      if (live === "throw") throw new Error("P2P unreachable");
      return { jpeg: Buffer.from("LIVE") };
    },
    snapshotStored: async () => {
      calls.stored += 1;
      if (stored === "throw") {
        const e = new Error("No stored snapshot is available");
        e.reason = "not-observed";
        throw e;
      }
      return Buffer.from("STORED");
    },
  };
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", ...env });
  const state = createState();
  state.flags.ready = true;
  const ctx = {
    ...config,
    state,
    eventImageDir: dir,
    eventLog: () => {},
    eufy: {
      async getDevice() {
        return {
          camera: () => cam,
          // A battery camera pays a radio wake per still; a mains one does not. The route reads this.
          describe: () => ({ sn: "CAM1", capabilities: battery ? ["camera", "video", "battery"] : ["camera", "video"] }),
        };
      },
    },
  };
  return { handler: createHttpHandler(ctx), calls, dir };
}

/** Run one GET and capture status + body. */
async function get(handler, url = "/snapshot/CAM1") {
  const out = {};
  const res = {
    writeHead(code, headers) { out.code = code; out.headers = headers; },
    end(body) { out.body = body; },
  };
  await handler({ url, headers: { host: "localhost" }, on() {} }, res);
  return out;
}

// Tests that exercise the live path pin `battery: false`: the default "auto" only bursts a mains camera.
test("snapshot: serves the persisted thumbnail when live and stored both fail", async () => {
  const { handler, calls } = setup({ live: "throw", stored: "throw", battery: false });
  const out = await get(handler);
  assert.equal(out.code, 200); // was a 502 before: the caller then pulled video to get a picture
  assert.equal(out.headers["content-type"], "image/jpeg");
  assert.deepEqual(out.body, JPEG);
  assert.equal(calls.live, 1); // a mains camera still gets the burst by default
});

test("snapshot: SNAPSHOT_LIVE=0 never wakes the camera", async () => {
  const { handler, calls } = setup({ live: "throw", stored: "throw", env: { SNAPSHOT_LIVE: "0" } });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.deepEqual(out.body, JPEG);
  assert.equal(calls.live, 0); // no live burst at all — the whole point of the switch
});

test("snapshot: a live still still wins when the camera delivers one", async () => {
  const { handler, calls } = setup({ battery: false });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.equal(out.body.toString(), "LIVE");
  assert.equal(calls.stored, 0); // no need to fall back
});

test("snapshot: reports why when there is no image anywhere", async () => {
  const { handler } = setup({ live: "throw", stored: "throw", persist: false, battery: false });
  const out = await get(handler);
  assert.equal(out.code, 404);
  const body = JSON.parse(out.body);
  assert.match(body.reason, /live burst failed/);
  assert.match(body.reason, /nothing retained/);
});

test("snapshot: SNAPSHOT_LIVE=0 answers from disk without consulting the retained thumbnail", async () => {
  const { handler, calls } = setup({ stored: "throw", env: { SNAPSHOT_LIVE: "0" } });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.deepEqual(out.body, JPEG);
  assert.equal(calls.live, 0);
  assert.equal(calls.stored, 0); // the disk copy is served first — no pointless round-trip per fetch
});

test("snapshot: default (auto) spares a battery camera the live burst", async () => {
  const { handler, calls } = setup({ live: "throw", stored: "throw", battery: true });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.deepEqual(out.body, JPEG); // served from disk
  assert.equal(calls.live, 0); // never wake a camera that runs on a battery
});

test("snapshot: default (auto) still takes a live still from a mains camera", async () => {
  const { handler, calls } = setup({ battery: false });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.equal(out.body.toString(), "LIVE"); // free for a mains device, so take the current picture
  assert.equal(calls.live, 1);
});

test("snapshot: SNAPSHOT_LIVE=1 forces the burst even on a battery camera", async () => {
  const { handler, calls } = setup({ battery: true, env: { SNAPSHOT_LIVE: "1" } });
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.equal(out.body.toString(), "LIVE");
  assert.equal(calls.live, 1);
});

test("snapshot: serves the last live picture when it is newer than the last event", async () => {
  const { handler, calls, dir } = setup({ live: "throw", stored: "throw", battery: true });
  const live = path.join(dir, "last-live-CAM1.jpg");
  fs.writeFileSync(live, Buffer.from("LIVEFRAME"));
  const past = new Date(Date.now() - 3_600_000); // the event was an hour ago
  fs.utimesSync(path.join(dir, "last-event-CAM1.jpg"), past, past);
  const out = await get(handler);
  assert.equal(out.code, 200);
  assert.equal(out.body.toString(), "LIVEFRAME");
  assert.equal(calls.live, 0); // still never woke the battery camera
});

test("snapshot: a newer event thumbnail wins over an older live picture", async () => {
  const { handler, dir } = setup({ live: "throw", stored: "throw", battery: true });
  const live = path.join(dir, "last-live-CAM1.jpg");
  fs.writeFileSync(live, Buffer.from("LIVEFRAME"));
  const past = new Date(Date.now() - 3_600_000); // someone watched an hour ago, the event is fresh
  fs.utimesSync(live, past, past);
  const out = await get(handler);
  assert.deepEqual(out.body, JPEG);
});
