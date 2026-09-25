// The one-time post-login boot: wire the SDK event handlers, publish the go2rtc config, start go2rtc, arm
// the periodic sweeps, and flip `ready`. Guarded so it runs exactly once — a later re-auth calls it again
// but returns immediately, so listeners and timers are never double-wired. Non-critical warm-ups are
// kicked off after `ready` so they don't hold up serving.
import { spawn, execFile } from "node:child_process";
import fsp from "node:fs/promises";
import { writeGo2rtcConfig } from "../go2rtc-config.mjs";

const PROBE_BUILD = "probe.14";

export function createBoot(ctx) {
  const { cfg, eufy, DEBUG, SCHEMA_VERSION, dbg, DETECTION_EVENTS, FORWARDED_EVENTS } = ctx;

  // TEMPORARY (debug branch): print the RAW push payload for the first few events, to see whether
  // the cloud notification names a recorded clip (video_url / short_video_url / storage_path) or
  // only a thumbnail. Bounded, so it cannot follow every detection into the log.
  let probeLeft = 6;
  let lastClip; // { path, cipher, stationSn, accountId } dall'ultimo push
  // A real clip seen in an earlier push, so the read can be tried without waiting for someone to walk
  // in front of the camera. Override with PROBE_CLIP if this one has been rotated off the card.
  const FALLBACK_CLIP = "/media/mmcblk0p1/Camera00/event/202609/20260925/20260925142939.zxvideo";

  let sdTried = false;

  // Open the camera's own P2P session instead of waiting for a viewer. An idle battery camera holds
  // none, and the leftover ffmpeg retries against /stream are refused by the stream backoff without
  // ever waking the radio — so nothing would ever connect on its own.
  //
  // Every step announces itself: the previous attempt printed nothing at all, which could equally mean
  // the code was absent or a call never returned. Silence must not be ambiguous.
  console.log(`[probe] armed (build ${PROBE_BUILD})`);
  async function kickoff(why) {
    console.log(`[probe] kickoff: ${why}`);
    if (sdTried) return console.log("[probe] already ran");
    let devs;
    try {
      console.log("[probe] listing devices…");
      devs = await eufy.getDevices();
    } catch (e) {
      return console.log(`[probe] getDevices failed: ${e?.message ?? e}`);
    }
    console.log(`[probe] devices: ${devs.map((d) => d?.sn).filter(Boolean).join(", ") || "(none)"}`);
    const sn = devs[0]?.sn;
    if (!sn) return;
    try {
      console.log(`[probe] connectStation(${sn})…`);
      await eufy.connectStation(sn);
      console.log("[probe] session open");
    } catch (e) {
      console.log(`[probe] connectStation failed: ${e?.message ?? e}`);
    }
    await trySdRead(sn);
  }
  // A battery camera drops off P2P when it sleeps, and a connect attempt then times out. One shot at
  // twenty seconds is a coin toss, so keep knocking: every 75s, ten times, stopping as soon as the read
  // has run. ~12 minutes of patience costs nothing and saves a restart per attempt.
  let attempts = 0;
  const knock = setInterval(() => {
    if (sdTried || ++attempts > 10) return clearInterval(knock);
    void kickoff(`attempt ${attempts}/10`);
  }, 75000);
  setTimeout(() => void kickoff("20s after boot"), 20000);
  /**
   * Ask the camera for files on its own SD card, in the order that makes the answer readable.
   *
   * First a JPEG we know is there — the snapshot written beside the clip. That is the CONTROL: if the
   * proven file-read primitive cannot fetch even that, the mechanism does not work on a standalone
   * camera, and the video is not the reason. Only then the clip itself, then the catalogued download
   * and record-list commands.
   *
   * The earlier attempt had the envelope wrong: the first argument of sendStringPayloadCommand is the
   * WRAPPER (CMD_SET_PAYLOAD 1350); the command being asked for goes inside it as `cmd`.
   */
  async function trySdRead(sn) {
    if (sdTried) return;
    const sessions = eufy.getP2pSessions?.() ?? new Map();
    const entry = sn ? [[sn, sessions.get(sn)]] : [...sessions];
    const [stationSn, session] = entry.find(([, s2]) => s2?.isConnected) ?? [];
    if (!session) return console.log("[probe] no connected P2P session yet");
    sdTried = true;

    const clip = process.env.PROBE_CLIP || lastClip?.path || FALLBACK_CLIP;
    const snapshot = clip.replace(/.zxvideo$/, "_snapshot.jpg");
    let accountId = lastClip?.accountId;
    if (!accountId) {
      try {
        const devs = await eufy.getDevices();
        accountId = devs.find((d) => d.raw?.member?.admin_user_id)?.raw?.member?.admin_user_id;
      } catch {
        /* best effort */
      }
    }

    let frames = 0;
    const onData = (frame) => {
      if (frames++ > 120) return;
      const head = frame?.data?.subarray?.(0, 16)?.toString("hex") ?? "";
      const js = frame?.json ? JSON.stringify(frame.json).slice(0, 300) : "";
      console.log(
        `[probe] frame ${frame?.commandName} bytes=${frame?.data?.length ?? 0} head=${head}${js ? " json=" + js : ""}`,
      );
    };
    const onImage = async ({ file, data }) => {
      console.log(`[probe] IMAGE ${file} -> ${data?.length ?? 0} bytes`);
      if (!data?.length || !file.endsWith(".zxvideo")) return;

      // The NAL census came back near-uniform across all 32 types, which no real elementary stream
      // looks like, and the XZYH marks repeat every ~2KB. So the file is a chain of records, and the
      // "start codes" were their headers. Two questions remain, and both are measurable.

      // 1 — the record layout. Print what follows each mark, so the header can be read off directly.
      const marks = [];
      for (let i = 0; i + 4 <= data.length; i++) {
        if (data[i] === 0x58 && data[i + 1] === 0x5a && data[i + 2] === 0x59 && data[i + 3] === 0x48) marks.push(i);
      }
      console.log(`[probe] ${marks.length} XZYH records in ${data.length} bytes`);
      for (const off of marks.slice(0, 6)) {
        console.log(`[probe]   @${String(off).padStart(7)} ${data.subarray(off, off + 32).toString("hex")}`);
      }
      const gaps = marks.slice(1, 9).map((m, i) => m - marks[i]);
      console.log(`[probe] record sizes: ${gaps.join(" ")}`);

      // 2 — is the payload encrypted, or merely a codec we did not recognise? Shannon entropy tells
      // them apart: ciphertext sits at ~8.00 bits per byte, H.264 around 7.3-7.7, and a header region
      // much lower. Measured away from the marks, in the middle of a record.
      const entropy = (buf) => {
        const f = new Array(256).fill(0);
        for (const b of buf) f[b]++;
        let h = 0;
        for (const c of f) if (c) h -= (c / buf.length) * Math.log2(c / buf.length);
        return h.toFixed(3);
      };
      const mid = marks.length > 2 ? marks[2] + 64 : 1024;
      console.log(`[probe] entropy: whole=${entropy(data)} payload@${mid}=${entropy(data.subarray(mid, mid + 8192))}`);
      console.log(`[probe] payload sample: ${data.subarray(mid, mid + 48).toString("hex")}`);

      // 3 — what does the account hand back for this camera's cipher? The record says cipher_id 0 and
      // the push says 95; the SDK can fetch the material for either, and whether it answers at all
      // decides whether decryption is a road or a wall.
      for (const id of [95, 0]) {
        try {
          const got = await eufy.api?.getCiphers?.([id], lastClip?.accountId, lastClip?.stationSn);
          const shape = (got ?? []).map((c) => Object.keys(c ?? {}).join("+")).join(" / ");
          console.log(`[probe] getCiphers(${id}): ${got ? `${got.length} entr(y/ies) [${shape}]` : "no answer"}`);
        } catch (e) {
          console.log(`[probe] getCiphers(${id}) failed: ${e?.message ?? e}`);
        }
      }
    };
    session.on("data", onData);
    session.on("image", onImage);
    console.log(`[probe] station=${stationSn} account=${accountId ?? "?"}`);

    const wrapped = (cmd, payload) => JSON.stringify({ cmd, payload });
    const steps = [
      ["A: requestImage on a JPEG that exists (CONTROL)", () => session.requestImage(snapshot, { accountId })],
      ["B: requestImage on the clip", () => session.requestImage(clip, { accountId })],
    ];
    for (const [label, run] of steps) {
      console.log(`[probe] -- ${label}`);
      try {
        run();
      } catch (e) {
        console.log(`[probe]    threw: ${e?.message}`);
      }
      await new Promise((r) => setTimeout(r, 9000));
    }
    session.off?.("data", onData);
    session.off?.("image", onImage);
    console.log(`[probe] done — ${frames} frame(s) seen`);
  }

  function probePush(name, payload) {
    if (probeLeft <= 0) return;
    probeLeft -= 1;
    try {
      console.log(`[probe] push ${name}: ${JSON.stringify(payload)}`);
      const rec = payload?.rec_content?.[0];
      const clip = rec?.storage_path || payload?.file_path;
      if (clip) {
        lastClip = {
          path: clip,
          cipher: payload?.cipher,
          stationSn: rec?.station_sn ?? payload?.deviceSn,
          accountId: rec?.account, // the push carries it; no need to derive one
        };
        console.log(`[probe] clip on SD: ${clip} (cipher=${payload?.cipher}, cipher_id=${rec?.cipher_id})`);
        void trySdRead();
      }
    } catch (e) {
      console.log(`[probe] push ${name}: unserialisable (${e?.message})`);
    }
  }
  const { flags, timers } = ctx.state;

  /** Spawn the bundled go2rtc against the generated config. Non-fatal if the binary isn't present (dev). */
  function startGo2rtc() {
    if (!cfg.go2rtcEnable) return;
    if (flags.go2rtcProc) return;
    try {
      flags.go2rtcProc = spawn("go2rtc", ["-config", cfg.go2rtcConfig], { stdio: "inherit" });
      flags.go2rtcProc.on("error", (e) => console.error(`[bridge] go2rtc not started (${e.message}) — WS/control still up`));
      flags.go2rtcProc.on("exit", (code) => { console.error(`[bridge] go2rtc exited (${code})`); flags.go2rtcProc = undefined; });
    } catch (e) {
      console.error(`[bridge] go2rtc spawn failed: ${e?.message ?? e}`);
    }
  }

  /** Runs once, after a successful login: wire events, write go2rtc.yaml, start go2rtc, go ready. */
  async function completeBoot() {
    if (flags.ready || flags.booting) return;
    flags.booting = true;
    try {
      eufy.on("deviceState", ctx.bumpActivity); // poll heartbeat — the watchdog's liveness signal
      if (DEBUG) {
        eufy.on("p2pConnect", (sn) => dbg(`p2pConnect station=${sn}`));
        eufy.on("p2pClose", (sn) => dbg(`p2pClose station=${sn}`));
        eufy.on("commandAck", (info) => dbg(`commandAck ${JSON.stringify(info)}`));
      }
      // TEMPORARY (debug branch): when a P2P session opens, ask the camera for the last clip we saw
      // on its SD card and log EVERY frame that comes back — including a refusal, which is itself an
      // answer. Two attempts: the proven file-read primitive, then the catalogued download command.
      eufy.on("p2pConnect", (sn) => void trySdRead(sn));

      for (const e of FORWARDED_EVENTS)
        eufy.on(e, (payload) => {
          probePush(e, payload);
          ctx.bumpActivity();
          const detection = DETECTION_EVENTS.has(e);
          if (detection) {
            ctx.noteDetection(payload?.deviceSn);
            // Local-storage accounts get no push thumbnail, so pull the fresh event cover from HomeBase
            // storage and (if it changed) nudge HA to re-fetch — otherwise "Last event" stays frozen.
            ctx.onDetectionRefresh?.(payload?.deviceSn);
          }
          // Narrow event trace (on by default): a push/semantic event arrived — say what it is, which
          // device, whether it's a detection (which is what makes HA refresh "Last event"), and how many
          // frontend clients it reaches. 0 clients means HA is not connected, so nothing updates there.
          const clients = ctx.state.clients.size;
          ctx.eventLog(
            `push in: ${e} sn=${payload?.deviceSn ?? "?"}` +
              `${detection ? " [detection → HA refreshes Last event]" : ""}` +
              ` → broadcast to ${clients} frontend client(s)` +
              `${clients === 0 ? " (NONE CONNECTED — HA will not update)" : ""}`,
          );
          ctx.broadcast({ event: e, ...ctx.enrichPersonName(e, payload) });
        });
      // Use the same capability-based view the WS/HA side uses: a camera is a device describeDevice gave
      // a `stream`, NOT deviceClass==="camera" (the SDK downgrades a camera behind a HomeBase to "other"),
      // so go2rtc registers exactly the cameras HA shows.
      const summaries = await ctx.deviceList();
      const cams = await writeGo2rtcConfig(cfg, summaries);
      startGo2rtc();
      flags.ready = true;
      flags.lastActivity = Date.now(); // start the liveness clock at boot, before the first poll
      timers.watchdog ??= setInterval(() => void ctx.watchdogTick(), 2 * 60_000);
      if (cfg.streamIdleMs) timers.streamIdle ??= setInterval(() => ctx.streamIdleTick(), 30_000);
      if (cfg.rtspIdleOffMs) timers.rtspIdle ??= setInterval(() => void ctx.rtspIdleSweep(), 60_000);
      console.log(`[bridge] ready — ${summaries.length} devices, ${cams.length} camera stream(s)`);
      ctx.broadcast({ event: "ready", schemaVersion: SCHEMA_VERSION });
      // Both read the P2P DB via a shared `dbChunk` stream — run sequentially so their accumulators don't
      // cross-contaminate. Non-blocking so `ready` isn't held up.
      void (async () => {
        await ctx.warmFaceRoster(); // resolve person_id -> name for face-recognition events
        await ctx.warmLastEventImages(); // populate "Last event" from local HomeBase storage on first load
      })();
    } finally {
      flags.booting = false;
    }
  }

  return { completeBoot, startGo2rtc };
}
