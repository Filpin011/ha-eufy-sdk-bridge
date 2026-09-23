// Construct the one EufyMega SDK client the bridge logs in with. Kept tiny and dependency-light so the
// heavier modules depend on the instance via `ctx.eufy`, not on how it was built. Event wiring that
// needs other modules (error → session recovery, push liveness) lives in server.mjs, after ctx is whole.
import { EufyMega, FileSessionStore, FileFcmStore, ConsoleLogger } from "@mega-yfue/eufy-sdk";

/**
 * Build the SDK client from config. `logger` is attached only under BRIDGE_DEBUG_P2P (raw transport logs).
 *
 * The logger is constructed WITHOUT a level so `ConsoleLogger`'s own `"debug"` default applies. The
 * transport lines this flag exists for are emitted at `debug`, and `LEVEL_RANK` puts `debug` below
 * `info`, so passing `"info"` here silenced exactly what the flag is meant to turn on: with it set you
 * got `p2pConnect` and nothing else, never the `[p2p] <sn> <<< …` frames.
 */
export function createEufy({ cfg, DEBUG_P2P }) {
  return new EufyMega({
    email: cfg.email,
    password: cfg.password,
    countryCode: cfg.country,
    store: new FileSessionStore(cfg.session),
    // Persist the FCM push registration so a restart RECONNECTS with the same token + seen-ids instead of
    // re-registering fresh each boot (the SDK defaults to MemoryFcmStore without this). See issue #30.
    pushStore: new FileFcmStore(cfg.pushSession),
    // Distinct per-install identity when set (BRIDGE_OPENUDID); undefined → the SDK's email-derived
    // default. Set it when running more than one client on an account (see cfg.openudid).
    openudid: cfg.openudid,
    pollMs: cfg.pollMs, // undefined → SDK default; changeable live via config.set
    // Event pre-warm is OFF by default (`[]` = no event opens P2P speculatively) so a battery camera's
    // radio isn't held open ~28s per doorbell/person/pet/package event. BRIDGE_PREWARM=1 → undefined,
    // which lets the SDK use its default high-intent pre-warm events.
    prewarmEvents: cfg.prewarm ? undefined : [],
    logger: DEBUG_P2P ? new ConsoleLogger() : undefined,
  });
}
