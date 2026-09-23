// List the devices the bridge sees, over the WS.
//
// Run from the bridge repo (so `ws` resolves):  node scripts/devices.mjs  [ws://host:3000/ws]
// If the bridge still needs auth it says so — run `node scripts/login.mjs` first.
import WebSocket from "ws";

const URL = process.argv[2] || process.env.BRIDGE_WS || "ws://localhost:3000/ws";
const ws = new WebSocket(URL);

let nextId = 0;
const pending = new Map();
const rpc = (cmd, extra = {}) =>
  new Promise((res, reject) => {
    const id = ++nextId;
    pending.set(id, { res, reject });
    ws.send(JSON.stringify({ id, cmd, ...extra }));
  });

ws.on("message", (data) => {
  const m = JSON.parse(data.toString());
  if (m.id && pending.has(m.id)) {
    pending.get(m.id).res(m);
    pending.delete(m.id);
  }
});
ws.on("error", (e) => {
  console.error("WS error:", e.message);
  process.exit(1);
});

ws.on("open", async () => {
  const { auth } = await rpc("auth.status");
  if (auth?.state !== "ok") {
    console.error(`bridge not authenticated (state: ${auth?.state}). Run: node scripts/login.mjs`);
    process.exit(2);
  }
  const { ok, devices, error } = await rpc("devices.list");
  if (!ok) {
    console.error("devices.list failed:", error);
    process.exit(1);
  }

  console.log(`\n${devices.length} device(s):\n`);
  for (const d of devices) {
    if (d.error) {
      console.log(`  ✗ ${d.sn}: ${d.error}`);
      continue;
    }
    const stream = d.stream ? `  stream=${d.stream}` : "";
    console.log(`  • ${d.name}  [${d.codec}]  ${d.sn}${stream}`);
    console.log(`      caps: ${(d.capabilities || []).join(", ")}`);
  }
  console.log();
  ws.close();
  process.exit(0);
});
