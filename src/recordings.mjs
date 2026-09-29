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
const CMD_DATABASE = 1306; // the query reply frame (carries the calendar rows as JSON)
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
  // Log at the visible "[bridge:event]" level (on by default) so a browse/play attempt can be traced
  // without turning on debug — this path is new and worth watching.
  const dbg = ctx.eventLog ?? ctx.dbg ?? (() => {});

  let loggedRowShape = false; // one-time diagnostic: what fields a calendar row actually carries
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

  // ── recent recordings, accumulated from detection pushes ────────────────────────────────────────────
  // The flaky calendar query (10017) needs the battery camera awake; a detection push does not — it comes
  // over FCM and already carries the event's record (storage_path, thumb_path, times). So every detection
  // is remembered here, and a day's listing merges these with whatever the calendar query returns, so
  // recent clips show even when the camera is asleep for the query.
  const recent = new Map(); // sn -> Map<record_id|storage_path, normalized row>
  // A record's day (YYYYMMDD): record_id is a YYYYMMDDhhmmss timestamp; fall back to the path's date folder.
  function dayOf(row) {
    const rid = String(row?.record_id ?? "");
    if (/^\d{8}/.test(rid)) return rid.slice(0, 8);
    const m = String(row?.storage_path ?? "").match(/\/(\d{8})\/[^/]*\.zxvideo$/);
    return m ? m[1] : "";
  }
  let loggedPushShape = false;
  function noteDetectionRecord(evtPayload) {
    const rec = evtPayload?.payload ?? evtPayload;
    const sn = evtPayload?.deviceSn ?? rec?.device_sn ?? rec?.deviceSn;
    const row = normalize(rec);
    if (!sn || typeof row.storage_path !== "string" || !row.storage_path.endsWith(".zxvideo")) {
      // One-time look at a detection push that carried no usable recording path, so we can see whether the
      // record is somewhere else in the payload (or simply not pushed on this camera/account).
      if (!loggedPushShape) {
        loggedPushShape = true;
        const top = Object.keys(evtPayload ?? {}).join(", ");
        const inner = rec && typeof rec === "object" ? Object.keys(rec).join(", ") : typeof rec;
        dbg(`recordings.feed — push had no storage_path. top keys: [${top}] · payload keys: [${inner}]`);
      }
      return;
    }
    let m = recent.get(sn);
    if (!m) {
      m = new Map();
      recent.set(sn, m);
    }
    m.set(String(row.record_id ?? row.storage_path), row);
    while (m.size > 1000) m.delete(m.keys().next().value); // cap memory; oldest-first eviction
    dbg(`recordings.feed ${sn} + ${row.storage_path} (day ${dayOf(row)}, ${m.size} cached)`);
  }
  function recentForDay(sn, day) {
    const m = recent.get(sn);
    return m ? [...m.values()].filter((r) => dayOf(r) === day) : [];
  }
  // Merge calendar rows with push-accumulated rows, newest first, de-duplicated by record_id/storage_path.
  function mergeRows(a, b) {
    const byKey = new Map();
    for (const r of [...a, ...b]) {
      if (!r?.storage_path) continue;
      byKey.set(String(r.record_id ?? r.storage_path), r);
    }
    return [...byKey.values()].sort((x, y) => String(y.start_time).localeCompare(String(x.start_time)));
  }

  // Pull the recording rows out of a 10017 reply, whichever shape the firmware used: the rows may be the
  // payload of the history_record_info table (data:[{table_name, payload:[…]}]) or sit straight in data:[…].
  function rowsFromReply(obj) {
    const d = obj?.data;
    if (d == null || d === "[]") return [];
    const arr = Array.isArray(d) ? d : [d];
    const tables = arr.filter((t) => t && typeof t === "object" && "table_name" in t);
    if (tables.length) {
      return tables
        .filter((t) => t.table_name === "history_record_info")
        .flatMap((t) => (Array.isArray(t.payload) ? t.payload : t.payload ? [t.payload] : []));
    }
    return arr.filter((r) => r && typeof r === "object");
  }

  /** Recording rows for one YYYYMMDD day, newest first. */
  async function listRecordings(sn, day) {
    if (!/^\d{8}$/.test(String(day))) throw new Error("date must be YYYYMMDD");
    dbg(`recordings.list ${sn} ${day} — requested`);
    return withDbLock(async () => {
      let session;
      try {
        session = await readySession(sn);
      } catch (e) {
        dbg(`recordings.list ${sn} ${day} — session failed: ${e?.message ?? e}`);
        throw e;
      }
      const acct = await accountId();

      // One send-and-await-reply. The 10017 calendar reply can come back two ways, and BOTH must be
      // handled or a busy session silently drops it:
      //   • as a CMD_DATABASE (1306) frame on the `data` channel — frame.json carries { cmd:10017,
      //     mIntRet, data:[…] } (this is what a quiet session gives);
      //   • reassembled on `dbChunk` — a plain { data:[…] } with NO cmd field (this is what a session
      //     under streaming load tends to give, and ignoring it for lacking `cmd` is why a healthy
      //     camera read back 0B).
      // The rows themselves are either the payload of the history_record_info table
      // (data:[{table_name, payload:[…rows]}]) or, on some firmwares, the rows straight in data:[…].
      const attemptQuery = () =>
        new Promise((resolve) => {
          let settled = false;
          let chunk = "";
          const done = (val, raw) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            session.off?.("data", onData);
            session.off?.("dbChunk", onChunk);
            resolve({ val, raw });
          };
          const onData = (frame) => {
            const id = frame?.commandId ?? frame?.commandType;
            // Authoritative frame: trust it only when it's actually the 10017 reply (a concurrent 10000
            // reply carries a different cmd and must not be mistaken for ours).
            if (id === CMD_DATABASE && frame?.json?.cmd === QUERY_LOCAL) {
              done(frame.json, JSON.stringify(frame.json).length);
            }
          };
          const onChunk = ({ text }) => {
            // dbChunk has no cmd; we hold the DB lock while listening, so any complete object reassembled
            // here is our reply. Accept it once it parses and exposes a `data`/`mIntRet` field.
            chunk += text;
            const obj = firstJsonObject(chunk);
            if (obj && ("data" in obj || obj.mIntRet !== undefined)) done(obj, chunk.length);
          };
          session.on("data", onData);
          session.on("dbChunk", onChunk);
          const send = () =>
            session.isConnected &&
            session.queryDatabase("history_record_info", { accountId: acct, channel: 0, innerCmd: QUERY_LOCAL, query: calendarQuery(day) });
          send();
          setTimeout(send, 1200); // the first datagram is occasionally dropped; one resend covers it
          const timer = setTimeout(() => done(undefined, chunk.length), 8000);
        });

      // A freshly-(re)connected or busy camera rejects the query with a negative mIntRet (seen: -1100)
      // or just drops it; the very next attempt usually succeeds. So retry — like the eufy app does —
      // until we get mIntRet:0 (even for an empty day). When we already have push-accumulated records for
      // this day, keep it short (they're the reliable fallback); otherwise give it the full budget.
      const fallback = recentForDay(sn, day);
      // The calendar query is now best-effort (push-accumulated records are the reliable source), so keep
      // it short — a long retry budget only backs up a queue of slow queries on a sleeping camera.
      const maxAttempts = fallback.length ? 2 : 3;
      let obj;
      let raw = 0;
      const deadline = Date.now() + (fallback.length ? 10_000 : 18_000);
      for (let attempt = 1; attempt <= maxAttempts && Date.now() < deadline; attempt++) {
        const reply = await attemptQuery();
        obj = reply.val;
        raw = reply.raw ?? 0;
        const code = obj?.mIntRet;
        if (obj && code === 0) break; // accepted (rows or an empty day)
        dbg(`recordings.list ${sn} ${day} — ${code !== undefined ? `rejected (mIntRet=${code})` : "no reply"}, retry ${attempt}`);
        await sleep(900);
      }

      const rejected = obj && obj.mIntRet !== undefined && obj.mIntRet !== 0;
      const rawRows = rejected ? [] : rowsFromReply(obj);
      const calRows = rawRows.map(normalize).filter((r) => r.storage_path);
      const rows = mergeRows(calRows, fallback);
      dbg(
        `recordings.list ${sn} ${day} → ${rows.length} row(s) ` +
          `(calendar ${calRows.length}${rejected ? " rejected" : ""}, push ${fallback.length}, reply ${raw}B)`,
      );
      // One-time visibility into what a calendar row actually carries.
      if (calRows.length && !loggedRowShape) {
        loggedRowShape = true;
        const sample = rawRows[0]?.payload ?? rawRows[0] ?? {};
        dbg(`recordings.list row keys: [${Object.keys(sample).join(", ")}] · thumb=${rows[0].thumb_path ?? "none"}`);
      }
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
  // On a STANDALONE camera the start command is a two-string command sent IN THE CLEAR — isP2PCommandEncrypted
  // (1024) is false, and it is NOT wrapped in CMD_SET_PAYLOAD (that's the HomeBase/T86P2 path). Verified wire
  // shape on a T8171:
  //   payload = [uint16 len][00 00][01 00][channel,0][00 00][5 zero bytes][storage_path @128][admin_id @128]
  // where the two strings are 128-byte padded (stringWithLength). Encrypting it (the T86P2 form) gets silence;
  // an earlier wrong envelope got -1/-104 rejections — the two-string cleartext form is the one it accepts.
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
      let bytes = 0; // running total for progress logging
      const seen = new Map(); // command id → count, so a no-ACK failure can say what the camera DID send
      let firstDl; // first CMD_DOWNLOAD_VIDEO frame we couldn't read as an accept (hex head), for diagnosis
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
        if (code) return;
        const tally = [...seen.entries()].map(([k, v]) => `${k}:${v}`).join(", ") || "nothing";
        dbg(`recordings.download no ACK in 15s — camera sent [${tally}]${firstDl ? ` | 1024 head=${firstDl}` : ""}`);
        finish(new Error("camera did not accept the download (no code returned)"));
      }, 15000);
      const onAbort = () => finish(new Error("download aborted"));
      signal?.addEventListener?.("abort", onAbort, { once: true });

      const onData = (frame) => {
        const id = frame?.commandId ?? frame?.commandType;
        const d = frame?.data;
        if (id !== undefined) seen.set(id, (seen.get(id) ?? 0) + 1);
        if (id === CMD_DOWNLOAD_VIDEO && Buffer.isBuffer(d) && d.length >= 5 && d.readInt32LE(0) === 0 && !code) {
          code = d.subarray(4).toString("ascii").replace(/\0.*$/s, "");
          try {
            key = aesKeyFor(serial, did, code);
          } catch (e) {
            return finish(new Error(`key derivation failed: ${e?.message}`));
          }
          dbg(`recordings.download accepted, code=${code}`);
        } else if (id === CMD_DOWNLOAD_VIDEO && Buffer.isBuffer(d) && !code) {
          // A 1024 frame that isn't our "accept" shape — capture it once. A non-zero int32 head is the
          // camera's rejection code; this makes it visible instead of silently waiting out the timeout.
          if (!firstDl) firstDl = d.subarray(0, 24).toString("hex");
        } else if (id === CMD_CONVERT_MP4_OK) {
          // Announces the transfer with the total byte count — first sign the camera accepted and is sending.
          const total = Buffer.isBuffer(d) && d.length >= 4 ? d.readUInt32LE(0) : undefined;
          dbg(`recordings.download ${serial} — transfer starting${total ? ` (~${total}B)` : ""}`);
        } else if (id === CMD_VIDEO_FRAME && d?.length > 22) {
          frames.push(Buffer.from(d));
          bytes += d.length;
          if (frames.length % 50 === 0) dbg(`recordings.download ${serial} — ${frames.length} frames, ${bytes}B so far`);
          settleSoon();
        } else if (id === CMD_DOWNLOAD_FINISH) {
          finished = true;
          settleSoon();
        }
      };
      session.on("data", onData);
      // Send the start command, with a couple of resends if the accept code hasn't come yet — a single UDP
      // datagram is occasionally dropped (the calendar query needs the same treatment). Each resend builds a
      // fresh frame under the next sequence number.
      const sendStart = () => {
        if (settled || code) return;
        // Build with the current sequence number, then advance it, then send — the order the SDK's own
        // control-command senders use.
        const bytes = buildDownloadFrame(session, storagePath, acct);
        session.seqNumber = (session.seqNumber + 1) & 0xffff;
        session.send(session.connectAddress, p2pCodec.RequestMessageType.DATA, bytes);
      };
      try {
        sendStart();
        setTimeout(sendStart, 1500);
        setTimeout(sendStart, 4000);
      } catch (e) {
        finish(e);
      }
      void finished;
    });
  }

  /** Download one recording and return a decoded, muxed MP4 Buffer. */
  async function downloadRecording(sn, storagePath, { signal } = {}) {
    dbg(`recordings.download ${sn} — requested ${storagePath}`);
    if (typeof storagePath !== "string" || !storagePath.endsWith(".zxvideo")) throw new Error(`bad recording path: ${storagePath}`);
    return withDbLock(async () => {
      dbg(`recordings.download ${sn} — lock acquired, readying session`);
      // Take the camera's video channel exclusively: tear down any live stream and block its reopen, since
      // a standalone camera won't accept a download while it's streaming. Released in the finally below.
      const held = !!ctx.beginDownloadHold;
      ctx.beginDownloadHold?.(sn);
      try {
        if (held) await sleep(1500); // let the stream's P2P session actually close on the camera
        const session = await readySession(sn, signal);
        dbg(`recordings.download ${sn} — session ready, resolving account`);
        const acct = await accountId();
        const did = await p2pDidOf(sn);
        const addr = session?.connectAddress ? `${session.connectAddress.host}:${session.connectAddress.port}` : "none";
        dbg(`recordings.download ${sn} — acct=${acct || "EMPTY"} did=${did ? "set" : "MISSING"} l1=${session?.level1Key ? "set" : "MISSING"} addr=${addr}`);
        const { frames, key } = await runDownload(session, storagePath, acct, sn, did, signal);
        if (!key) throw new Error("no key material from the download");
        if (!frames.length) throw new Error("download produced no frames");

        const stream = decodeRecordFrames(frames, key);
        const mp4 = await muxToMp4(stream);
        dbg(`recordings.download ${sn} → ${frames.length} frames, ${stream.length}B annexb → ${mp4.length}B mp4`);
        return mp4;
      } catch (e) {
        dbg(`recordings.download ${sn} — FAILED: ${e?.message ?? e}`);
        throw e;
      } finally {
        if (held) ctx.endDownloadHold?.(sn); // let go2rtc reopen the live stream
      }
    });
  }

  return { listRecordings, fetchThumb, downloadRecording, noteDetectionRecord };
}
