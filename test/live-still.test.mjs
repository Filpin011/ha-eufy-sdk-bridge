// A battery camera's still should show what was last SEEN, not only the last event: the last keyframe of a
// watched stream is kept and written as last-live-<sn>.jpg when the stream ends — never by waking the camera.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { keyframeCodec, createLiveStillTap } from "../src/live-still.mjs";

const SC = [0x00, 0x00, 0x00, 0x01]; // Annex-B start code
const au = (...nals) => Buffer.from(nals.flatMap((n) => [...SC, ...n]));

// H.264: SPS (0x67), PPS (0x68), IDR slice (0x65); a delta frame is a non-IDR slice (0x41).
const H264_KEY = au([0x67, 0x64, 0x00, 0x1f], [0x68, 0xee, 0x3c], [0x65, 0x88, 0x84]);
const H264_DELTA = au([0x41, 0x9a, 0x02]);
// H.265: VPS (0x40 0x01), SPS (0x42 0x01), PPS (0x44 0x01), IDR_W_RADL (0x26 0x01); delta TRAIL_R (0x02 0x01).
const HEVC_KEY = au([0x40, 0x01, 0x0c], [0x42, 0x01, 0x01], [0x44, 0x01, 0xc1], [0x26, 0x01, 0xaf]);
const HEVC_DELTA = au([0x02, 0x01, 0xd0]);

test("keyframeCodec recognises an H.264 keyframe by its SPS", () => {
  assert.equal(keyframeCodec(H264_KEY), "h264");
});

test("keyframeCodec recognises an H.265 keyframe by its VPS", () => {
  assert.equal(keyframeCodec(HEVC_KEY), "hevc");
});

test("keyframeCodec does not mistake an H.264 delta slice for an H.265 VPS", () => {
  // 0x41 is the commonest H.264 slice header and also parses as H.265 type 32; with 0x01 after it, only the
  // missing H.265 SPS tells the two apart.
  assert.equal(keyframeCodec(au([0x41, 0x01, 0x9a])), null);
});

test("keyframeCodec ignores delta frames of either codec", () => {
  assert.equal(keyframeCodec(H264_DELTA), null);
  assert.equal(keyframeCodec(HEVC_DELTA), null);
  assert.equal(keyframeCodec(Buffer.from("not video")), null);
});

function tapInto(dir) {
  const converted = [];
  const tap = createLiveStillTap({
    sn: "CAM1",
    dir,
    toJpeg: async (frame, codec) => {
      converted.push({ frame, codec });
      return Buffer.from(`JPEG:${codec}`);
    },
  });
  return { tap, converted };
}

test("the tap keeps the LATEST keyframe and writes it as last-live-<sn>.jpg on flush", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-"));
  const { tap, converted } = tapInto(dir);
  tap.onChunk(HEVC_KEY);
  tap.onChunk(HEVC_DELTA);
  tap.onChunk(H264_KEY); // a later keyframe replaces the earlier one
  tap.onChunk(H264_DELTA);
  assert.equal(await tap.flush(), true);
  assert.equal(converted.length, 1);
  assert.equal(converted[0].codec, "h264");
  assert.deepEqual(converted[0].frame, H264_KEY);
  assert.equal(fs.readFileSync(path.join(dir, "last-live-CAM1.jpg"), "utf8"), "JPEG:h264");
});

test("a stream that never showed a keyframe writes nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-"));
  const { tap, converted } = tapInto(dir);
  tap.onChunk(H264_DELTA);
  assert.equal(await tap.flush(), false);
  assert.equal(converted.length, 0);
  assert.equal(fs.existsSync(path.join(dir, "last-live-CAM1.jpg")), false);
});

test("flush converts once, however often the route's cleanup fires", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-"));
  const { tap, converted } = tapInto(dir);
  tap.onChunk(H264_KEY);
  await Promise.all([tap.flush(), tap.flush(), tap.flush()]);
  assert.equal(converted.length, 1);
});

test("a failed conversion is reported, not thrown", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-"));
  const logs = [];
  const tap = createLiveStillTap({
    sn: "CAM1", dir, log: (m) => logs.push(m),
    toJpeg: async () => { throw new Error("ffmpeg exited 1"); },
  });
  tap.onChunk(H264_KEY);
  assert.equal(await tap.flush(), false);
  assert.match(logs[0], /could not keep the last live picture: ffmpeg exited 1/);
});
