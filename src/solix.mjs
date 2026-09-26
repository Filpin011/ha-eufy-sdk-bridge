// Optional Anker Solix support — a SEPARATE account/login from the eufy one, on a separate device
// backend (AWS-IoT MQTT), so it is fully independent of the eufy client: enabled only when SOLIX_EMAIL
// + SOLIX_PASSWORD are set, and its failures never affect eufy devices. It logs in, discovers the
// account's Solix devices as capability-driven SolixDevice objects, opens the shared SecureMqtt
// telemetry stream, and forwards devices + live readings to WS clients (events `solixReady` /
// `solixReading` / `solixAuth`; queried via `solix.devices` / `solix.status`).
import {
  SolixClient,
  FileSessionStore,
  SolixMqtt,
  discoverSolixDevices,
  solarbankSceneReadings,
} from "@mega-yfue/eufy-sdk";

// Shown when a Solix command is used but Solix isn't configured (its `ctx.*` handler is absent).
export const SOLIX_DISABLED = "solix is not enabled (set SOLIX_EMAIL / SOLIX_PASSWORD)";

// ── Anker Solix control commands (WS `solix.*`) ─────────────────────────────────────────────────────
// The WS dispatcher (ws-server.mjs) drives these; the handlers they name are installed on `ctx` by
// `createSolix` below (its return object). Keeping the table beside the handlers means adding a control
// is a single-file change: one `ctx.solix*` handler + one entry here. Every control has the same shape —
// require Solix enabled (the `ctx[fn]` handler exists) and a target device, call the handler, echo a
// small confirmation — so the dispatcher applies those guards once rather than repeating them per case.
//   fn    — the ctx.* handler method name (its presence IS the "Solix enabled" test)
//   needs — usage hint shown (as `<cmd> needs <needs>`) when the request is missing a required field
//   req   — extra required msg fields beyond deviceSn (rejected when `== null`); optional
//   check — optional extra predicate over msg (false ⇒ rejected with `needs`)
//   run   — (fn, msg) => the handler call; its resolved value is passed to `out`
//   out   — (msg, result) => the reply body
export const SOLIX_CONTROLS = {
  "solix.setLight": {
    // Toggle a Solarbank's ambient light (encrypted+signed set_device_attrs write).
    fn: "solixSetAmbientLight",
    needs: "{ deviceSn, on }",
    run: (fn, m) => fn(m.deviceSn, !!m.on),
    out: (m) => ({ deviceSn: m.deviceSn, on: !!m.on }),
  },
  "solix.setDeviceAttrs": {
    // Generic Solix attribute write (snake_case keys), for future controls.
    fn: "solixSetDeviceAttrs",
    needs: "{ deviceSn, attributes }",
    run: (fn, m) => fn(m.deviceSn, m.attributes),
    out: (m) => ({ deviceSn: m.deviceSn }),
  },
  "solix.getDeviceAttrs": {
    // Read device attributes (e.g. screen_off_time) — plain authed read.
    fn: "solixGetDeviceAttrs",
    needs: "{ deviceSn, keys? }",
    run: (fn, m) => fn(m.deviceSn, m.keys),
    out: (m, attributes) => ({ deviceSn: m.deviceSn, attributes }),
  },
  "solix.setScreenOffTime": {
    // Set the Solarbank display screen-off timeout (seconds); "Never" is a device sentinel.
    fn: "solixSetScreenOffTime",
    needs: "{ deviceSn, seconds }",
    req: ["seconds"],
    run: (fn, m) => fn(m.deviceSn, m.seconds),
    out: (m) => ({ deviceSn: m.deviceSn, seconds: Number(m.seconds) }),
  },
  "solix.getPowerCutoff": {
    // Read the battery discharge-cutoff (minimum-SOC) preset options.
    fn: "solixGetPowerCutoff",
    needs: "{ deviceSn, siteId? }",
    run: (fn, m) => fn(m.deviceSn, m.siteId),
    out: (m, options) => ({ deviceSn: m.deviceSn, options }),
  },
  "solix.setPowerCutoff": {
    // Select a discharge-cutoff preset by id (id comes from getPowerCutoff).
    fn: "solixSetPowerCutoff",
    needs: "{ deviceSn, cutoffDataId }",
    req: ["cutoffDataId"],
    run: (fn, m) => fn(m.deviceSn, m.cutoffDataId),
    out: (m) => ({ deviceSn: m.deviceSn, cutoffDataId: Number(m.cutoffDataId) }),
  },
  "solix.setDisplayTimeout": {
    // Set the Solarbank display screen-off timeout by 1-based index (10s=1…30m=6) — MQTT command.
    fn: "solixSetDisplayTimeout",
    needs: "{ deviceSn, index }",
    req: ["index"],
    run: (fn, m) => fn(m.deviceSn, m.index),
    out: (m) => ({ deviceSn: m.deviceSn, index: Number(m.index) }),
  },
  "solix.getSocParams": {
    // Read the Solarbank battery SOC-limit block (discharge/charge limit, backup reserve).
    fn: "solixGetSocParams",
    needs: "{ deviceSn }",
    run: (fn, m) => fn(m.deviceSn),
    out: (m, params) => ({ deviceSn: m.deviceSn, params }),
  },
  "solix.setSocLimits": {
    // Write the discharge and/or charge limit (whole-percent). Read-modify-write preserves the rest.
    fn: "solixSetSocLimits",
    needs: "{ deviceSn, dischargeLowerLimit? and/or chargeUpperLimit? }",
    check: (m) => m.dischargeLowerLimit != null || m.chargeUpperLimit != null,
    run: (fn, m) => {
      const changes = {};
      if (m.dischargeLowerLimit != null) changes.dischargeLowerLimit = Number(m.dischargeLowerLimit);
      if (m.chargeUpperLimit != null) changes.chargeUpperLimit = Number(m.chargeUpperLimit);
      return fn(m.deviceSn, changes);
    },
    out: (m, params) => ({ deviceSn: m.deviceSn, params }),
  },
};

export function createSolix(ctx) {
  const { cfg } = ctx;
  const s = cfg.solix;
  if (!s) return {}; // disabled — no SOLIX_EMAIL/PASSWORD

  const st = ctx.state.solix; // { status, devices: Map<sn,SolixDevice>, client, mqtt }
  st.client = new SolixClient({
    email: s.email,
    password: s.password,
    countryCode: s.country,
    store: new FileSessionStore(s.session),
  });

  /** A WS-facing summary of one Solix device: identity + capabilities + the latest telemetry values. */
  function summarize(dev) {
    const id = dev.identity();
    return {
      source: "solix",
      sn: dev.serial,
      productCode: dev.productCode,
      name: id.name,
      category: id.category,
      capabilities: dev.capabilities,
      firmware: dev.firmware()?.version,
      online: dev.connectivity()?.online ?? null,
      ssid: dev.connectivity()?.ssid ?? null, // the Wi-Fi network the device is on
      rssi: dev.connectivity()?.rssi ?? null,
      values: dev.telemetry(), // decoded channels from the latest reading (empty until one arrives)
    };
  }
  function solixDeviceList() {
    return [...st.devices.values()].map(summarize);
  }
  function solixStatus() {
    return { enabled: true, state: st.status, deviceCount: st.devices.size };
  }

  /** After a successful login: discover devices, open the telemetry stream, forward readings. */
  async function attach() {
    // discoverDevices moved off the wire client into the model layer (transport ⊥ model): the client is
    // now wire-only, and discoverSolixDevices composes its reads into capability-driven SolixDevice models.
    const devices = await discoverSolixDevices(st.client);
    st.devices = new Map(devices.map((d) => [d.serial, d]));
    st.status = "ready";
    console.log(
      `[bridge] solix ready — ${devices.length} device(s): ${devices.map((d) => `${d.productCode}/${d.serial}`).join(", ") || "none"}`,
    );
    ctx.broadcast({ event: "solixReady", devices: solixDeviceList() });

    // Live telemetry over the shared AWS-IoT broker (same transport the eufy path uses).
    try {
      // Arm faster than the SDK's 25s default so state changes made outside HA (the app, the
      // physical button) show up in the realtime frame — and thus on the switches/sensors — within
      // ~12s instead of ~25s. The device only pushes `param_info` while a client keeps requesting it.
      const mqtt = new SolixMqtt({ mqttInfo: await st.client.getUserMqttInfo(), armIntervalMs: 12_000 });
      st.mqtt = mqtt;
      mqtt.on("error", (e) => console.error(`[bridge] solix mqtt: ${e?.message ?? e}`));
      mqtt.on("reading", (r) => {
        st.devices.get(r.deviceSn)?.applyReading(r);
        // App-side control changes (ambient light / display timeout) arrive as a command on the device
        // /req channel that the SDK turns into a reading carrying just that key. Log them so an app
        // toggle can be confirmed end-to-end (they're rare — only on a change, not every telemetry frame).
        if ("ambientLightOn" in r.values || "displayTimeoutIndex" in r.values) {
          console.log(`[bridge] solix app control: sn=${r.deviceSn} ${JSON.stringify(r.values)}`);
        }
        ctx.broadcast({ event: "solixReading", deviceSn: r.deviceSn, productCode: r.productCode, values: r.values });
      });
      for (const d of devices) {
        try {
          await mqtt.watch(d.record);
        } catch (e) {
          console.error(`[bridge] solix watch ${d.serial}: ${e?.message ?? e}`);
        }
      }
    } catch (e) {
      // Reads still work without the live stream — don't fail the whole Solix path on an MQTT hiccup.
      console.error(`[bridge] solix telemetry unavailable: ${e?.message ?? e}`);
    }

    // Low-rate scene BACKSTOP for Solarbank batteries. The realtime ff09 push is the fast source
    // (power/SOC every ~5-12s) but it does NOT reliably carry battery TEMPERATURE — the fast frame's
    // BMS blob is empty, so the decoder withholds it. So poll the site "scene" snapshot (the app's own
    // dashboard read) at a slow cadence and merge just the gap fields (batteryTemperature + a SOC
    // cross-check) onto the SAME reading path (applyReading + solixReading). This is additive, never a
    // replacement for the push. Runs independently of MQTT (a plain authed read), and only when a
    // battery device is present.
    startScenePoll(devices);
  }

  // The scene backstop poll (see attach): timer + the routine that fetches and forwards readings.
  let scenePollTimer = null;
  const SCENE_POLL_MS = s.scenePollMs; // slow — fills gap fields; MQTT push carries realtime (SOLIX_SCENE_POLL_MS)
  async function pollScene() {
    try {
      const sites = await st.client.getSites();
      for (const site of sites) {
        const siteId = site?.site_id;
        if (!siteId) continue;
        const scene = await st.client.getSiteScene(siteId);
        for (const r of solarbankSceneReadings(scene)) {
          const dev = st.devices.get(r.deviceSn);
          if (!dev) continue;
          dev.applyReading(r);
          ctx.broadcast({
            event: "solixReading",
            deviceSn: r.deviceSn,
            productCode: dev.productCode,
            values: r.values,
          });
        }
      }
    } catch (e) {
      console.error(`[bridge] solix scene poll: ${e?.message ?? e}`);
    }
  }
  function startScenePoll(devices) {
    if (scenePollTimer) return; // already running (re-attach after 2FA)
    const hasBattery = devices.some((d) => d.capabilities?.includes("battery"));
    if (!hasBattery) return; // scene backstop only matters for a Solarbank/battery
    void pollScene(); // seed immediately so temperature isn't blank until the first interval
    scenePollTimer = setInterval(() => void pollScene(), SCENE_POLL_MS);
    scenePollTimer.unref?.(); // never keep the process alive just to poll
  }

  // Self-heal a failed login WITHOUT hammering: Anker throttles repeated logins (26161 "too
  // frequent") and can escalate to a captcha requirement, so retry gently on a long, escalating
  // backoff instead of tight-looping (or having the user manually restart, which re-arms the
  // throttle). Cleared on success and on shutdown.
  let solixRetryTimer = null;
  let solixRetryMs = 0;
  const SOLIX_RETRY_BASE_MS = s.retryBaseMs; // 15 min default — past the login throttle window (SOLIX_RETRY_BASE_MS)
  const SOLIX_RETRY_MAX_MS = s.retryMaxMs; // cap the escalating backoff, default 1 h (SOLIX_RETRY_MAX_MS)
  function scheduleSolixRetry() {
    if (solixRetryTimer) return;
    solixRetryMs = solixRetryMs ? Math.min(solixRetryMs * 2, SOLIX_RETRY_MAX_MS) : SOLIX_RETRY_BASE_MS;
    console.log(`[bridge] solix: will retry login in ~${Math.round(solixRetryMs / 60000)} min`);
    solixRetryTimer = setTimeout(() => {
      solixRetryTimer = null;
      void startSolix();
    }, solixRetryMs);
    solixRetryTimer.unref?.(); // never keep the process alive just to retry
  }

  /** Log in (independent of eufy). Surfaces 2FA over WS; a stored session makes this a no-op re-login. */
  async function startSolix() {
    if (st.status === "ready" || st.status === "connecting") return;
    st.status = "connecting";
    ctx.broadcast({ event: "solixAuth", state: "connecting" });
    try {
      const r = await st.client.login();
      if (r.status === "2fa") {
        st.status = "2fa";
        console.log(`[bridge] solix: 2FA required (${r.method}) — submit via WS 'solix.submitCode'`);
        ctx.broadcast({ event: "solixAuth", state: "2fa", method: r.method });
        return;
      }
      await attach();
      solixRetryMs = 0; // a clean login resets the backoff
    } catch (e) {
      st.status = "error";
      console.error(`[bridge] solix start failed: ${e?.message ?? e}`);
      ctx.broadcast({ event: "solixAuth", state: "error", error: String(e?.message ?? e) });
      scheduleSolixRetry();
    }
  }

  /** Complete a pending Solix 2FA with the code the account was sent. */
  async function solixSubmitCode(code) {
    if (st.status !== "2fa") throw new Error("no solix 2FA is pending");
    const r = await st.client.submitVerifyCode(String(code ?? ""));
    if (r.status !== "ok") throw new Error(`solix 2FA not accepted (${r.status})`);
    await attach();
  }

  /** Stop the telemetry stream (shutdown). */
  async function stopSolix() {
    if (solixRetryTimer) {
      clearTimeout(solixRetryTimer);
      solixRetryTimer = null;
    }
    if (scenePollTimer) {
      clearInterval(scenePollTimer);
      scenePollTimer = null;
    }
    try {
      await st.mqtt?.close?.();
    } catch {
      /* best-effort */
    }
  }

  /** Control a Solix device attribute (encrypted+signed write), e.g. the Solarbank ambient light. */
  async function solixSetAmbientLight(deviceSn, on) {
    if (!st.client) throw new Error("solix not connected");
    await st.client.setAmbientLight(deviceSn, !!on);
  }
  async function solixSetDeviceAttrs(deviceSn, attributes) {
    if (!st.client) throw new Error("solix not connected");
    await st.client.setDeviceAttrs(deviceSn, attributes || {});
  }
  /** Read device attributes (e.g. the display `screen_off_time`) — a plain authed read. */
  async function solixGetDeviceAttrs(deviceSn, keys) {
    if (!st.client) throw new Error("solix not connected");
    return st.client.getDeviceAttrs(deviceSn, Array.isArray(keys) ? keys : []);
  }
  /** Set the Solarbank display screen-off timeout, in seconds (`screen_off_time`). */
  async function solixSetScreenOffTime(deviceSn, seconds) {
    if (!st.client) throw new Error("solix not connected");
    await st.client.setScreenOffTime(deviceSn, Number(seconds));
  }
  /** Read the Solarbank battery discharge-cutoff (minimum-SOC) preset options. */
  async function solixGetPowerCutoff(deviceSn, siteId) {
    if (!st.client) throw new Error("solix not connected");
    return st.client.getPowerCutoff(deviceSn, siteId || "");
  }
  /** Select the Solarbank discharge-cutoff preset by option id (from getPowerCutoff). */
  async function solixSetPowerCutoff(deviceSn, cutoffDataId) {
    if (!st.client) throw new Error("solix not connected");
    await st.client.setPowerCutoff(deviceSn, Number(cutoffDataId));
  }
  /** Set the Solarbank display screen-off timeout by 1-based index (10s=1…30m=6) — MQTT command. */
  async function solixSetDisplayTimeout(deviceSn, index) {
    if (!st.mqtt) throw new Error("solix telemetry (MQTT) not connected");
    const dev = st.devices.get(deviceSn);
    if (!dev) throw new Error(`unknown solix device ${deviceSn}`);
    await st.mqtt.setDisplayTimeout(dev.record, Number(index));
  }

  // The SOC-limit settings are keyed by SITE, not device — resolve a device's site by finding the site
  // whose member list contains it. Cached after the first lookup (a device never changes sites in a run).
  const siteIdCache = new Map();
  async function siteIdForDevice(deviceSn) {
    if (siteIdCache.has(deviceSn)) return siteIdCache.get(deviceSn);
    const sites = await st.client.getSites();
    for (const site of sites) {
      const members = site?.site_device_list ?? [];
      if (members.some((m) => m?.device_sn === deviceSn)) {
        siteIdCache.set(deviceSn, site.site_id);
        return site.site_id;
      }
    }
    // Single-site accounts: fall back to the only site rather than failing the control.
    if (sites.length === 1 && sites[0]?.site_id) {
      siteIdCache.set(deviceSn, sites[0].site_id);
      return sites[0].site_id;
    }
    throw new Error(`no site found for solix device ${deviceSn}`);
  }

  /** Read the Solarbank's battery SOC-limit settings (discharge/charge limit, backup reserve). */
  async function solixGetSocParams(deviceSn) {
    if (!st.client) throw new Error("solix not connected");
    return st.client.getSafetySocParams(await siteIdForDevice(deviceSn));
  }

  /**
   * Write the Solarbank's discharge and/or charge limit (whole-percent). Read-modify-write in the SDK
   * preserves the fields not passed. Broadcasts the new limits on the reading path immediately so HA
   * reflects the change without waiting for the device's `b5` telemetry to echo it back (~≤12s).
   */
  async function solixSetSocLimits(deviceSn, changes) {
    if (!st.client) throw new Error("solix not connected");
    const merged = await st.client.setSafetySocParams(await siteIdForDevice(deviceSn), changes);
    const values = { dischargeLimit: merged.dischargeLowerLimit, chargeLimit: merged.chargeUpperLimit };
    st.devices.get(deviceSn)?.applyReading({ deviceSn, values });
    ctx.broadcast({ event: "solixReading", deviceSn, productCode: st.devices.get(deviceSn)?.productCode, values });
    return merged;
  }

  return {
    startSolix,
    solixSubmitCode,
    solixDeviceList,
    solixStatus,
    stopSolix,
    solixSetAmbientLight,
    solixSetDeviceAttrs,
    solixGetDeviceAttrs,
    solixSetScreenOffTime,
    solixGetPowerCutoff,
    solixSetPowerCutoff,
    solixSetDisplayTimeout,
    solixGetSocParams,
    solixSetSocLimits,
  };
}
