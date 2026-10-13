// ============================================================================
// server/main.ts
//
// The Deno Deploy entry point. Everything interesting is in
// src/server-api.ts, which is a plain Request -> Response function with no
// idea where it runs — this file only supplies the three things that differ
// between hosts: storage, a clock, and randomness.
//
// Kept out of tsconfig.json deliberately: it refers to Deno globals, and the
// repo's tsc has no Deno types. The logic it wraps is typechecked and tested
// under node like everything else.
//
// Run locally:  deno run --allow-net --allow-env --unstable-kv server/main.ts
//               (PORT=8787 by default)
// ============================================================================

import {
  handle,
  memoryStore,
  randomRoomId,
  randomToken,
  type RoomStore,
  type ServerDeps,
} from "../src/server-api.ts";
import type { Room } from "../src/room.ts";

/**
 * Rooms in Deno KV, so a deploy or a restart does not drop live games.
 *
 * `swap` is a real compare-and-set via KV's atomic check, which is what keeps
 * two players moving in the same instant from losing a move. Falls back to
 * memory when KV is unavailable, which is fine for a local run and wrong for
 * a deployment — hence the warning.
 */
async function kvStore(): Promise<{ store: RoomStore; kind: string }> {
  let kv: Deno.Kv;
  if (typeof Deno.openKv !== "function") {
    console.error(
      "Deno.openKv is not available in this runtime. Attach a Deno KV " +
        "database to this app on the Databases page.",
    );
    return { store: memoryStore(), kind: "memory (openKv missing)" };
  }

  // Some platforms expose KV as an ambient global; others hand out a
  // connection URL and expect it to be passed in. Support both rather than
  // guessing which one this deployment is.
  const url =
    Deno.env.get("DENO_KV_URL") ??
    Deno.env.get("KV_URL") ??
    undefined;

  try {
    kv = url ? await Deno.openKv(url) : await Deno.openKv();
  } catch (err) {
    // This is not a degraded-but-working state. Each isolate gets its own
    // Map, so a room created by one is invisible to the next request routed
    // elsewhere, and games appear and disappear at random. /api/health says
    // so out loud rather than leaving it to be discovered by a player.
    console.error(
      "Deno KV unavailable — falling back to per-isolate memory. Rooms will " +
        "appear to vanish intermittently. Enable KV for this project.",
      err,
    );
    return {
      store: memoryStore(),
      // Carried into /api/health so the reason is visible without dashboard
      // access. It names the failure, not anything about the host.
      kind: `memory (${(err as Error).name}: ${String((err as Error).message).slice(0, 120)})`,
    };
  }

  const key = (id: string) => ["room", id];

  return { kind: url ? "deno-kv (url)" : "deno-kv", store: {
    async get(id) {
      const got = await kv.get<Room>(key(id));
      return got.value ?? null;
    },
    async swap(previous, next) {
      const existing = await kv.get<Room>(key(next.id));
      // Refuse if someone else wrote in between.
      if (previous === null && existing.value !== null) return false;
      if (previous !== null && existing.value === null) return false;
      const result = await kv
        .atomic()
        .check({ key: key(next.id), versionstamp: existing.versionstamp })
        .set(key(next.id), next, { expireIn: 1000 * 60 * 60 * 24 * 30 })
        .commit();
      return result.ok;
    },
  } };
}

const backing = await kvStore();

const deps: ServerDeps = {
  store: backing.store,
  storage: backing.kind,
  now: () => Date.now(),
  newRoomId: () => randomRoomId(),
  newToken: () => randomToken(),
  // Set ALLOW_ORIGIN to the page's origin in production; "*" suits a demo.
  allowOrigin: Deno.env.get("ALLOW_ORIGIN") ?? "*",
};

// Deno Deploy supplies the port; locally it is whatever is free.
const port = Number(Deno.env.get("PORT") ?? 8787);
Deno.serve({ port }, (req) => handle(req, deps));
