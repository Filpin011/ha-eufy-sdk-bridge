// Face-recognition name resolution. A `personDetected` push carries only a numeric `person_id`, not the
// recognised person's name — the name lives in the on-HomeBase `person_basic_info` table (read over P2P
// at startup by warmup.mjs into `ctx.state.faceNames`). Here: parse that table, and enrich a push with
// the resolved name. `parseFaceRoster` / `firstJsonObject` are pure and unit-tested.

/** Parse `person_basic_info` rows out of a reassembled P2P DB reply (name precedes person_id). */
export function parseFaceRoster(text) {
  const rows = text.matchAll(/\{"age":\d+,[^{}]*?"name":"([^"]*)"[^{}]*?"person_id":(\d+),"relation":"([^"]*)"/g);
  const out = new Map();
  for (const m of rows) {
    const id = Number(m[2]);
    if (!out.has(id)) out.set(id, { name: m[1], familiar: !/^stranger\d+$/.test(m[1]) });
  }
  return out;
}

/** The first complete brace-balanced JSON object in a string (the P2P DB reply has trailing padding). */
export function firstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Face enrichment bound to the shared roster. */
export function createFaces(ctx) {
  const { faceNames } = ctx.state;

  /**
   * Attach the recognised person's name to a `personDetected` payload.
   *
   * The push carries only `person_id`; look it up in the roster to add `person_name` + `recognized`.
   * `person_id <= 0` (or -1) means "a person, but no face match" → left unresolved (recognized:false).
   * Unmapped positive ids are logged so a first real recognition confirms the id-space live.
   */
  function enrichPersonName(event, payload) {
    if (event !== "personDetected") return payload;
    const pid = Number(payload?.person_id);
    if (!Number.isFinite(pid) || pid <= 0) return { ...payload, recognized: false };
    const rec = faceNames.get(pid);
    if (!rec) {
      console.log(`[bridge] personDetected person_id=${pid} not in roster (${faceNames.size} known)`);
      return { ...payload, recognized: false };
    }
    return { ...payload, person_name: rec.name, recognized: rec.familiar };
  }

  return { enrichPersonName };
}
