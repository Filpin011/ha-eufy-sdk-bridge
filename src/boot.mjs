// The one-time post-login boot: wire the SDK event handlers, publish the go2rtc config, start go2rtc, arm
// the periodic sweeps, and flip `ready`. Guarded so it runs exactly once — a later re-auth calls it again
// but returns immediately, so listeners and timers are never double-wired. Non-critical warm-ups are
// kicked off after `ready` so they don't hold up serving.
import { spawn, execFile } from "node:child_process";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { writeGo2rtcConfig } from "../go2rtc-config.mjs";

const PROBE_BUILD = "probe.22";

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

  // Once a clip has been fetched it is kept, and every later question is asked of the copy. The
  // camera is a battery device that answers when it feels like it; re-downloading the same 450KB
  // for each new measurement was turning a five-minute question into an afternoon.
  const SAVED = "/data/probe-clip.zxvideo";

  let sdTried = false;
  let clipDone = false;
  let haveClip = false;

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
    if (clipDone || ++attempts > 20) return clearInterval(knock);
    void kickoff(`attempt ${attempts}/10`);
  }, 75000);
  setTimeout(async () => {
    try {
      const saved = await fsp.readFile(SAVED);
      haveClip = true; // the bytes are in hand; what is still wanted is playback
      console.log(`[probe] analysing the saved clip (${saved.length} bytes) — the camera is not needed`);
      await analyse(saved);
      void kickoff("playback attempt");
    } catch {
      console.log("[probe] no saved clip yet — fetching one");
      void kickoff("20s after boot");
    }
  }, 20000);

  /**
   * Ask the camera to play a recording back, rather than asking for its file.
   *
   * The key never has to be ours: the app does not decrypt anything either — it asks for playback and
   * the camera sends frames. Those commands are in the catalogue precisely because the app uses them.
   *
   * The earlier attempts at them answered -104, and the reason is now plain. requestImage, which
   * works, wraps `{account_id, cmd, mChannel, payload: [{…}], transaction}` — account id at the top,
   * a channel, an ARRAY payload and a correlation string. The attempts sent `{cmd, payload: {…}}`.
   * That was a malformed envelope, not a refusal.
   */
  async function tryPlayback(session, clipPath, accountId) {
    const heard = { data: 0, video: 0, media: 0, audio: 0 };
    const onData = (f) => {
      heard.data++;
      const js = f?.json ? JSON.stringify(f.json).slice(0, 240) : "";
      if (heard.data <= 40) {
        console.log(`[play] frame ${f?.commandName} bytes=${f?.data?.length ?? 0}${js ? " json=" + js : ""}`);
      }
    };
    const onVideo = (v) => {
      heard.video++;
      if (heard.video <= 5) console.log(`[play] VIDEO frame ${v?.data?.length ?? v?.length ?? "?"} bytes`);
    };
    const onMedia = (m) => {
      heard.media++;
      if (heard.media <= 5) console.log(`[play] MEDIA ${JSON.stringify(m)?.slice(0, 160)}`);
    };
    const onAudio = () => heard.audio++;
    session.on("data", onData);
    session.on("video", onVideo);
    session.on("media", onMedia);
    session.on("audio", onAudio);

    const day = clipPath.split("/").at(-2) ?? "";
    const stamp = (clipPath.split("/").pop() ?? "").replace(".zxvideo", "");
    // Same envelope as the working call; only the command and its payload change.
    const envelope = (cmd, payload) =>
      JSON.stringify({ account_id: accountId ?? "", cmd, mChannel: 0, payload, transaction: clipPath });
    const asks = [
      ["1024 CMD_DOWNLOAD_VIDEO", 1024, [{ file: clipPath }]],
      ["1025 CMD_RECORD_VIEW", 1025, [{ file: clipPath }]],
      ["1042 CMD_RECORDLIST_SEARCH", 1042, [{ date: day }]],
      ["1041 CMD_RECORDDATE_SEARCH", 1041, [{ month: day.slice(0, 6) }]],
      ["1024 with a start time", 1024, [{ file: clipPath, start_time: stamp, type: 0 }]],
    ];

    for (const [label, cmd, payload] of asks) {
      const before = { ...heard };
      console.log(`[play] ── ${label}`);
      try {
        session.sendStringPayloadCommand(1350, envelope(cmd, payload));
      } catch (e) {
        console.log(`[play]    threw: ${e?.message}`);
        continue;
      }
      await new Promise((r) => setTimeout(r, 14000));
      console.log(
        `[play]    +${heard.data - before.data} frames, +${heard.video - before.video} video, ` +
          `+${heard.media - before.media} media, +${heard.audio - before.audio} audio`,
      );
    }

    session.off?.("data", onData);
    session.off?.("video", onVideo);
    session.off?.("media", onMedia);
    session.off?.("audio", onAudio);
    console.log(`[play] totals: ${JSON.stringify(heard)}`);
  }

  /** Everything we know how to ask of a clip, run against bytes from anywhere. */
  async function analyse(data) {

    const HDR = 16;
    const INNER = 22;
    const recs = [];
    for (let i = 0; i + HDR <= data.length; ) {
      if (!(data[i] === 0x58 && data[i + 1] === 0x5a && data[i + 2] === 0x59 && data[i + 3] === 0x48)) break;
      const len = data.readUInt32LE(i + 6);
      const body = data.subarray(i + HDR, i + HDR + len);
      recs.push({ off: i, len, key: data[i + 13] === 1, no: body[6], p: body.subarray(INNER) });
      i += HDR + len;
    }
    const opaqueKeys = recs.filter((r) => r.key && !(r.p[0] === 0 && r.p[1] === 0 && r.p[2] === 0 && r.p[3] === 1));
    console.log(`[probe] ${recs.length} records, ${opaqueKeys.length} encrypted keyframes`);
    if (opaqueKeys.length < 2) return console.log("[probe] need two keyframes to compare");

    const [a, b] = opaqueKeys;
    const n = Math.min(a.p.length, b.p.length);

    // Two keyframes encrypt to the same opening bytes, so there is no per-record IV. How far the
    // agreement runs is how much plaintext they share — an SPS and a PPS, presumably.
    let same = 0;
    while (same < n && a.p[same] === b.p[same]) same++;
    console.log(`[probe] two keyframes agree for ${same} bytes, then diverge`);

    // The discriminator. Under a stream cipher with a fixed keystream, C1^C2 = P1^P2 — two H.264
    // keyframes xored, which keeps structure and measures well below 8 bits. Under a block cipher
    // it is noise. This is the difference between a problem we can solve and one we cannot.
    const x = Buffer.alloc(Math.min(n, 65536));
    for (let i = 0; i < x.length; i++) x[i] = a.p[i] ^ b.p[i];
    const H = (buf) => {
      const f = new Array(256).fill(0);
      for (const v of buf) f[v]++;
      let h = 0;
      for (const c of f) if (c) h -= (c / buf.length) * Math.log2(c / buf.length);
      return h.toFixed(3);
    };
    console.log(`[probe] entropy: C1=${H(a.p.subarray(0, 65536))} C1^C2=${H(x)} (ciphertext ~7.98, xor of two frames should fall well below)`);
    console.log(`[probe] C1^C2 zero bytes: ${x.filter((v) => v === 0).length}/${x.length}`);

    // A repeating keystream would show itself as periodicity: bytes matching their own echo one
    // period away, far more often than the 1-in-256 chance.
    const best = [];
    for (const period of [16, 32, 64, 128, 256, 512, 1024]) {
      let hits = 0;
      const upto = Math.min(a.p.length - period, 40000);
      for (let i = 0; i < upto; i++) if (a.p[i] === a.p[i + period]) hits++;
      best.push(`${period}:${((hits / upto) * 100).toFixed(2)}%`);
    }
    console.log(`[probe] self-match by period (chance is 0.39%): ${best.join(" ")}`);

    // If it is a keystream, this is its opening — a keyframe must begin 00 00 00 01 67.
    const crib = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67]);
    const ks = Buffer.alloc(crib.length);
    for (let i = 0; i < crib.length; i++) ks[i] = a.p[i] ^ crib[i];
    console.log(`[probe] keystream candidate (C ^ expected SPS): ${ks.toString("hex")}`);
    console.log(`[probe] keyframe head: ${a.p.subarray(0, 32).toString("hex")}`);
  }

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
    let clipSeen = false;
    const onImage = async ({ file, data }) => {
      console.log(`[probe] IMAGE ${file} -> ${data?.length ?? 0} bytes`);
      if (!data?.length || !file.endsWith(".zxvideo")) return;
      clipSeen = true;
      clipDone = true;
      try {
        await fsp.writeFile(SAVED, data);
        console.log(`[probe] kept a copy at ${SAVED} — later builds will not need the camera`);
      } catch (e) {
        console.log(`[probe] could not keep a copy: ${e?.message}`);
      }
      await analyse(data);
    };


    session.on("data", onData);
    session.on("image", onImage);
    console.log(`[probe] station=${stationSn} account=${accountId ?? "?"}`);

    // Reading a file rides the level-2 wire and nothing else. The negotiation is one-shot per
    // connection, and once it settles without a key the session stays open while refusing every
    // such request in silence — which is what the last attempt looked like: a session, and no
    // frames at all. So wait for the key, ask again if it never came, and say which happened.
    let l2ok = await session.awaitLevel2Key?.(20000, "session");
    if (!l2ok && session.repromptLevel2Key?.()) {
      console.log("[probe] level-2 never settled — asked again");
      l2ok = await session.awaitLevel2Key?.(20000, "call");
    }
    console.log(`[probe] level-2 key: ${l2ok ? "ready" : "UNAVAILABLE — file reads will be refused"}`);
    if (!l2ok) {
      sdTried = false; // a fresh session negotiates normally; this one never will
      try {
        session.close?.();
      } catch {
        /* closing a dead session is not interesting */
      }
      return;
    }

    const wrapped = (cmd, payload) => JSON.stringify({ cmd, payload });
    const steps = [
      ["A: requestImage on a JPEG that exists (CONTROL)", () => session.requestImage(snapshot, { accountId })],
      ["B: requestImage on the clip", () => session.requestImage(clip, { accountId })],
      ["B2: the clip again", () => session.requestImage(clip, { accountId })],
      ["B3: the clip once more", () => session.requestImage(clip, { accountId })],
    ];
    if (haveClip) console.log("[probe] clip already in hand — skipping the fetch, going to playback");
    for (const [label, run] of steps) {
      if (haveClip) break;
      if (clipSeen) break;
      console.log(`[probe] -- ${label}`);
      try {
        run();
      } catch (e) {
        console.log(`[probe]    threw: ${e?.message}`);
      }
      await new Promise((r) => setTimeout(r, 9000));
    }
    // The file is in hand (or not); either way, ask the camera to play it instead.
    await tryPlayback(session, clip, accountId);

    session.off?.("data", onData);
    session.off?.("image", onImage);
    clipDone = true; // playback was attempted on a live session; that was the point of connecting
    if (!clipSeen && !haveClip) {
      // The transfer never landed — the camera went back to sleep mid-probe. That is a reason to
      // try again, not to call the attempt spent.
      sdTried = false;
      console.log("[probe] no clip arrived — re-arming");
    }
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
