// The pure decode step: keyframe openings are AES-128-ECB, the rest is plaintext, and the 22-byte
// inner header is dropped. Built with a known key so it needs no camera.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { decodeRecordFrames } from "../src/recordings.mjs";

const KEY = Buffer.from("0123456789abcdef"); // 16 bytes

// A record frame: [uint32 LE payloadLen][flag@4][17 header bytes = 22 total][payload].
function frame({ keyframe, payload }) {
  const inner = Buffer.alloc(22);
  inner.writeUInt32LE(payload.length, 0);
  inner[4] = keyframe ? 1 : 0;
  return Buffer.concat([inner, payload]);
}

// A keyframe on the wire: first 128 bytes encrypted, the rest already plaintext.
function encryptOpening(plain) {
  const c = crypto.createCipheriv("aes-128-ecb", KEY, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(plain.subarray(0, 128)), c.final(), plain.subarray(128)]);
}

test("decodeRecordFrames decrypts keyframe openings and passes P-frames through", () => {
  const kfPlain = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x67]), crypto.randomBytes(200)]); // SPS + data
  const pfPlain = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x41]), crypto.randomBytes(80)]); // P-slice

  const frames = [
    frame({ keyframe: true, payload: encryptOpening(kfPlain) }),
    frame({ keyframe: false, payload: pfPlain }),
  ];

  const out = decodeRecordFrames(frames, KEY);
  assert.deepEqual(out, Buffer.concat([kfPlain, pfPlain]), "recovers keyframe + p-frame plaintext");
  assert.deepEqual(out.subarray(0, 5), Buffer.from([0, 0, 0, 1, 0x67]), "keyframe opens with an SPS start code");
});

test("decodeRecordFrames skips malformed frames", () => {
  const good = frame({ keyframe: false, payload: Buffer.from([0, 0, 0, 1, 0x41, 9, 9]) });
  const junk = Buffer.from([1, 2, 3, 4, 5]); // length field won't match
  const out = decodeRecordFrames([junk, good], KEY);
  assert.deepEqual(out, Buffer.from([0, 0, 0, 1, 0x41, 9, 9]));
});
