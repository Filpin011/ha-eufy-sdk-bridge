// Saved SD-card recordings for a STANDALONE camera (station_sn == device_sn, storage on the camera,
// no HomeBase). Three capabilities, all over the camera's own P2P session:
//
//   list      queryDatabase("history_record_info", innerCmd 10017) over a day → the recording rows.
//             (innerCmd 10000, the HomeBase full-table form, returns nothing on a standalone camera.)
//   thumbnail requestImage(thumb_path) → the event snapshot JPEG (cheap; no full download).
//   download  CMD_DOWNLOAD_VIDEO → the camera streams the clip back and hands us a per-recording code;
//             the frames are H.264 with only each keyframe's first 128 bytes AES-128-ECB encrypted
//             under getImageKey(serial, p2p_did, code). Decrypt, concat Annex-B, mux to MP4.
//
// The key derivation and download handshake were verified on a T8171; getImageKey / p2pCodec are
// existing SDK exports. The heavy download runs only when a clip is actually opened.
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import * as sdk from "@mega-yfue/eufy-sdk";
import { firstJsonObject } from "./faces.mjs";

const { p2pCodec } = sdk;
const CMD_DOWNLOAD_VIDEO = 1024;
const CMD_VIDEO_FRAME = 1300;
const CMD_CONVERT_MP4_OK = 1303;
const CMD_DOWNLOAD_FINISH = 1304;
const QUERY_LOCAL = 10017; // the SD-card calendar query (vs 10000, the HomeBase full-table read)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── getImageKey: prefer the SDK's export, fall back to a local transcription (verified identical) ─────
function idSuffix(did) {
  const m = String(did).match(/^[A-Z]+-(\d+)-[A-Z]+$/);
  if (!m) return 0;
  const d = m[1];
  let r = +d[0] + +d[1] + +d[3];
  if (+d[3] < 5) r += +d[3];
  return r + +d[5];
}
function localImageKey(serial, did, code) {
  let nr = Number.parseInt(`0x${serial[serial.length - 1]}`);
  nr = (nr + 10) % 10;
  const baseCode = serial.substring(nr) + idSuffix(did);
  const seed = crypto
    .createHash("md5")
    .update(`${1000 - idSuffix(did)}${Number.parseInt(String(code).substring(2))}`)
    .digest("hex")
    .toUpperCase();
  const h = [...crypto.createHash("sha256").update(`01${baseCode}${seed}`).digest()];
  const startByte = h[10];
  for (let i = 0; i < 32; i++) {
    const byte = h[i];
    const fixed = i < 31 ? h[i + 1] : startByte;
    if (i === 31 || (i & 1) !== 0) {
      h[10] = fixed;
      if (byte > 126 || h[10] > 126) h[i] = byte < h[10] || byte - h[10] === 0 ? h[10] - byte : byte - h[10];
    } else if (byte < 125 || fixed < 125) {
      h[i] = fixed + byte;
    }
  }
  return Buffer.from(h.slice(16)).toString("hex").toUpperCase();
}
function aesKeyFor(serial, did, code) {
  const hex = typeof sdk.getImageKey === "function" ? sdk.getImageKey(serial, did, code) : localImageKey(serial, did, code);
  return Buffer.from(hex, "ascii").subarray(0, 16); // first 16 chars of the hex string, as ASCII → AES-128
}

/**
 * Turn the raw download frames into one Annex-B stream. Pure and I/O-free so it can be tested without a
 * camera. Each frame is `[uint32 payloadLen][kf flag @4]…[22-byte inner header][payload]`; a keyframe's
 * first 128 payload bytes are AES-128-ECB under `key`, the rest — and every P-frame — is plaintext.
 */
export function decodeRecordFrames(frames, key) {
  const parts = [];
  for (const frame of frames) {
    if (frame.length < 22 || frame.readUInt32LE(0) !== frame.length - 22) continue; // not a record frame
    let payload = frame.subarray(22);
    if (frame[4] === 1 && payload.length >= 128) {
      const dec = crypto.createDecipheriv("aes-128-ecb", key, null);
      dec.setAutoPadding(false);
      payload = Buffer.concat([dec.update(payload.subarray(0, 128)), dec.final(), payload.subarray(128)]);
    }
    parts.push(payload);
  }
  return Buffer.concat(parts);
}

/** Wrap a raw H.264 Annex-B stream in a fragmented MP4 with ffmpeg (-c copy: no re-encode). */
function muxToMp4(annexb) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "h264", "-i", "pipe:0",
      "-c", "copy", "-movflags", "frag_keyframe+empty_moov",
      "-f", "mp4", "pipe:1",
    ]);
    const out = [];
    const err = [];
    ff.stdout.on("data", (d) => out.push(d));
    ff.stderr.on("data", (d) => err.push(d));
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(0, 200)}`))));
    ff.stdin.on("error", () => {}); // ignore EPIPE if ffmpeg rejects early
    ff.stdin.end(annexb);
  });
}

export function createRecordings(ctx) {
  const { eufy } = ctx;
  const withDbLock = (fn) => (ctx.withDbLock ? ctx.withDbLock(fn) : fn());
  const dbg = ctx.dbg ?? (() => {});

  const stationSession = (sn) => (eufy.getP2pSessions?.() ?? new Map()).get(sn);
  async function accountId() {
    const devs = await eufy.getDevices();
    return devs.find((d) => d.raw?.member?.admin_user_id)?.raw?.member?.admin_user_id ?? eufy.api?.auth?.userId ?? "";
  }
  async function p2pDidOf(sn) {
    const devs = await eufy.getDevices();
    return (devs.find((d) => d?.sn === sn) ?? devs[0])?.raw?.p2p_did;
  }

  // Open the camera's own session and wait until it can carry a level-2 (file/DB) request.
  async function readySession(sn, signal) {
    let session = stationSession(sn);
    if (!session?.isConnected) {
      await eufy.connectStation(sn, signal);
      session = stationSession(sn);
    }
    if (!session?.isConnected) throw new Error("camera P2P session not ready");
    if (session.awaitLevel2Key) {
      let ok = await session.awaitLevel2Key(20000, "session");
      if (!ok && session.repromptLevel2Key?.()) ok = await session.awaitLevel2Key(20000, "call");
      if (!ok) throw new Error("camera level-2 key unavailable");
    }
    return session;
  }

  // ── list ─────────────────────────────────────────────────────────────────────────────────────────
  function calendarQuery(day) {
    const y = +day.slice(0, 4);
    const m = +day.slice(4, 6);
    const d = +day.slice(6, 8);
    const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10).replaceAll("-", "");
    return { count: 200, start_date: day, end_date: next, start_time: "0", detection_type: 0, event_type: 0, flag: 0, storage_cloud: -1, ai_type: 0 };
  }
  function normalize(rec) {
    const p = rec?.payload ?? rec ?? {};
    return {
      record_id: p.record_id,
      start_time: p.start_time,
      end_time: p.end_time,
      frame_num: p.frame_num,
      storage_path: p.storage_path,
      thumb_path: p.thumb_path ?? p.crop_path,
      cipher_id: p.cipher_id,
      width: p.res_best_width,
      height: p.res_best_height,
    };
  }

  /** Recording rows for one YYYYMMDD day, newest first. */
  async function listRecordings(sn, day) {
    if (!/^\d{8}$/.test(String(day))) throw new Error("date must be YYYYMMDD");
    return withDbLock(async () => {
      const session = await readySession(sn);
      const acct = await accountId();
      let chunk = "";
      const onChunk = ({ text }) => (chunk += text);
      session.on("dbChunk", onChunk);
      const send = () =>
        session.isConnected &&
        session.queryDatabase("history_record_info", { accountId: acct, channel: 0, innerCmd: QUERY_LOCAL, query: calendarQuery(day) });
      send();
      setTimeout(send, 1500); // the first datagram is occasionally dropped; one resend covers it
      let parsed;
      for (let i = 0; i < 70; i++) {
        await sleep(200);
        const obj = firstJsonObject(chunk);
        if (obj && Array.isArray(obj.data)) {
          parsed = obj;
          break;
        }
      }
      session.off?.("dbChunk", onChunk);
      const rows = (parsed?.data ?? [])
        .map(normalize)
        .filter((r) => r.storage_path)
        .sort((a, b) => String(b.start_time).localeCompare(String(a.start_time)));
      dbg(`recordings.list ${sn} ${day} → ${rows.length}`);
      return rows;
    });
  }

  // ── thumbnail ────────────────────────────────────────────────────────────────────────────────────
  /** The event snapshot JPEG for a recording (its thumb_path), or undefined. */
  async function fetchThumb(sn, thumbPath) {
    if (typeof thumbPath !== "string" || !thumbPath.startsWith("/")) throw new Error("bad thumb path");
    return withDbLock(async () => {
      const session = await readySession(sn);
      const acct = await accountId();
      const images = new Map();
      const onImage = ({ file, data }) => {
        if (data?.[0] === 0xff && data?.[1] === 0xd8) images.set(file, data);
      };
      session.on("image", onImage);
      session.requestImage(thumbPath, { accountId: acct });
      for (let i = 0; i < 40 && !images.has(thumbPath); i++) await sleep(200);
      session.off?.("image", onImage);
      return images.get(thumbPath);
    });
  }

  // ── download + decrypt + mux ─────────────────────────────────────────────────────────────────────
  function buildDownloadFrame(session, storagePath, acct) {
    const data = Buffer.concat([Buffer.alloc(5), p2pCodec.stringWithLength(storagePath), p2pCodec.stringWithLength(acct)]);
    const head = Buffer.allocUnsafe(2);
    head.writeUInt16LE(data.length, 0);
    const payload = Buffer.concat([head, Buffer.from([0, 0]), Buffer.from([1, 0]), Buffer.from([0, 0]), Buffer.from([0, 0]), data]);
    return Buffer.concat([p2pCodec.buildCommandHeader(session.seqNumber, CMD_DOWNLOAD_VIDEO), payload]);
  }

  // Send the download command; resolve { frames, key } once the transfer settles.
  function runDownload(session, storagePath, acct, serial, did, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let code;
      let key;
      let finished = false;
      let idle;
      const frames = [];
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimeout);
        clearTimeout(idle);
        clearTimeout(acceptTimeout);
        session.off?.("data", onData);
        signal?.removeEventListener?.("abort", onAbort);
        err ? reject(err) : resolve(value);
      };
      const settleSoon = () => {
        clearTimeout(idle);
        idle = setTimeout(() => finish(undefined, { frames, key }), 3000);
      };
      const hardTimeout = setTimeout(() => finish(new Error("download timed out")), 90000);
      const acceptTimeout = setTimeout(() => {
        if (!code) finish(new Error("camera did not accept the download (no code returned)"));
      }, 15000);
      const onAbort = () => finish(new Error("download aborted"));
      signal?.addEventListener?.("abort", onAbort, { once: true });

      const onData = (frame) => {
        const id = frame?.commandId ?? frame?.commandType;
        const d = frame?.data;
        if (id === CMD_DOWNLOAD_VIDEO && d?.length >= 5 && d.readInt32LE(0) === 0 && !code) {
          code = d.subarray(4).toString("ascii").replace(/\0.*$/s, "");
          try {
            key = aesKeyFor(serial, did, code);
          } catch (e) {
            return finish(new Error(`key derivation failed: ${e?.message}`));
          }
          dbg(`recordings.download accepted, code=${code}`);
        } else if (id === CMD_VIDEO_FRAME && d?.length > 22) {
          frames.push(Buffer.from(d));
          settleSoon();
        } else if (id === CMD_DOWNLOAD_FINISH) {
          finished = true;
          settleSoon();
        }
      };
      session.on("data", onData);
      try {
        session.seqNumber = (session.seqNumber + 1) & 0xffff;
        session.send(session.connectAddress, p2pCodec.RequestMessageType.DATA, buildDownloadFrame(session, storagePath, acct));
      } catch (e) {
        finish(e);
      }
      void finished;
    });
  }

  /** Download one recording and return a decoded, muxed MP4 Buffer. */
  async function downloadRecording(sn, storagePath, { signal } = {}) {
    if (typeof storagePath !== "string" || !storagePath.endsWith(".zxvideo")) throw new Error("bad recording path");
    return withDbLock(async () => {
      const session = await readySession(sn, signal);
      const acct = await accountId();
      const did = await p2pDidOf(sn);
      const { frames, key } = await runDownload(session, storagePath, acct, sn, did, signal);
      if (!key) throw new Error("no key material from the download");
      if (!frames.length) throw new Error("download produced no frames");

      const stream = decodeRecordFrames(frames, key);
      dbg(`recordings.download ${sn} → ${frames.length} frames, ${stream.length}B annexb`);
      return muxToMp4(stream);
    });
  }

  return { listRecordings, fetchThumb, downloadRecording };
}
