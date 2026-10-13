// ============================================================================
// server-api.ts
//
// The game server, as a plain `Request -> Response` function.
//
// Nothing here knows which host it is running on. Storage, the clock and the
// random generator are passed in, so this file can be tested under node, run
// under Deno, or dropped into a Worker without edits — and so the host can be
// changed later without touching the rules of a shared game.
//
// The protocol is polling, not sockets. The game is turn-based, so nobody
// notices a two-second delay, and every response carries the full move log
// position — which means reconnecting is not a special case. A client that
// has been asleep for an hour asks for everything after move N exactly like
// one that blinked.
//
// Four endpoints:
//
//   POST /api/rooms              make a room
//   POST /api/rooms/:id/join     take a seat, receive a private token
//   GET  /api/rooms/:id?since=N  the room, plus the moves you have not seen
//   POST /api/rooms/:id/move     play; validated against the engine
// ============================================================================

import {
  RoomError,
  createRoom,
  join,
  movesSince,
  play,
  viewOf,
  type Room,
} from "./room.ts";

/**
 * Rooms live wherever the host keeps them. `swap` is compare-and-set: it must
 * only write if the stored room is still the one that was read, or two players
 * moving at the same instant can lose a move. A host without atomic writes can
 * implement it as a plain put, accepting that risk — the move-count check in
 * `play` already catches the common case.
 */
export interface RoomStore {
  get(id: string): Promise<Room | null>;
  swap(previous: Room | null, next: Room): Promise<boolean>;
}

export interface ServerDeps {
  store: RoomStore;
  now(): number;
  /** Short, human-sayable room code. */
  newRoomId(): string;
  /** Unguessable per-player secret. */
  newToken(): string;
  /** Origins allowed to call this server. `*` for a public demo. */
  allowOrigin?: string;
  /**
   * What is holding the rooms. Reported by /api/health, because a server
   * that silently fell back to per-isolate memory looks identical to a
   * working one until a game intermittently vanishes — which is exactly how
   * this field came to exist.
   */
  storage?: string;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const STATUS_PAGE = `<!doctype html><meta charset="utf-8">
<title>Pond Rush server</title>
<style>
  body{background:#0d1116;color:#e8eef2;font:15px/1.6 system-ui,sans-serif;
       margin:0;display:grid;place-items:center;min-height:100vh;padding:24px}
  main{max-width:34rem}
  h1{font-size:18px;letter-spacing:.04em;margin:0 0 4px}
  p{opacity:.75;margin:0 0 12px}
  code{background:#161b21;border:1px solid #2b343d;border-radius:4px;padding:1px 6px}
  a{color:#ffd400}
</style>
<main>
  <h1>POND RUSH \u2014 SERVER</h1>
  <p>Running. This is the game server, not the game \u2014 there is no page to
     look at here.</p>
  <p>Play at <a href="https://ghollisjr.github.io/pond-rush/">ghollisjr.github.io/pond-rush</a>.</p>
  <p>Liveness: <code>/api/health</code></p>
</main>`;

/**
 * Echo back the caller's origin when it is on the allowed list, rather than
 * naming a single one. A deployment usually needs at least two — the real
 * page and a developer's localhost — and a lone fixed value silently locks
 * one of them out.
 */
function allowedOrigin(deps: ServerDeps, req?: Request): string {
  const allow = deps.allowOrigin ?? "*";
  if (allow === "*") return "*";
  const list = allow.split(",").map((o) => o.trim()).filter(Boolean);
  const asked = req?.headers.get("origin") ?? "";
  if (asked && list.includes(asked)) return asked;
  return list[0] ?? "*";
}

function cors(deps: ServerDeps, req?: Request): Record<string, string> {
  return {
    "access-control-allow-origin": allowedOrigin(deps, req),
    vary: "origin",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
  };
}

// CORS is applied once, in `handle`, to whatever comes back. Threading the
// request through every call site is how the health endpoint quietly ended up
// announcing the wrong origin: one of them simply did not pass it on.
function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function fail(err: unknown): Response {
  const status = err instanceof RoomError ? err.status : 500;
  const message =
    err instanceof RoomError
      ? err.message
      : // Never hand an internal failure's details to a client.
        "Something went wrong on the server.";
  if (status === 500) console.error("pond-rush:", err);
  return reply({ error: message }, status);
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Read, change, write — retried, because two players can poll and move in the
 * same instant and the loser of that race should simply try again rather than
 * see an error.
 */
async function mutate(
  deps: ServerDeps,
  id: string,
  change: (room: Room) => Room
): Promise<Room> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await deps.store.get(id);
    if (!current) throw new RoomError("No such game.", 404);
    const next = change(current);
    if (await deps.store.swap(current, next)) return next;
  }
  throw new RoomError("The game is busy — try again.", 503);
}

export async function handle(req: Request, deps: ServerDeps): Promise<Response> {
  const response =
    req.method === "OPTIONS"
      ? new Response(null, { status: 204 })
      : await route(req, deps);

  // Every exit gets the headers, including ones added later.
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors(deps, req))) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function route(req: Request, deps: ServerDeps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  try {
    if (req.method === "POST" && path === "/api/rooms") {
      const body = await readJson(req);
      const variantId = String(body.variantId ?? "standard-4p");
      // An absent seed is the normal case: the server picks, so a player
      // cannot fish for a seed whose rolls they like.
      const seed =
        body.seed === undefined
          ? Math.floor(Math.random() * 2 ** 31)
          : Number(body.seed);

      const room = createRoom({
        id: deps.newRoomId(),
        variantId,
        seed,
        now: deps.now(),
      });
      if (!(await deps.store.swap(null, room))) {
        throw new RoomError("Could not create a game — try again.", 503);
      }
      return reply({ room: viewOf(room) }, 201);
    }

    const roomMatch = /^\/api\/rooms\/([A-Za-z0-9_-]{1,32})(\/[a-z]+)?$/.exec(path);
    if (roomMatch) {
      const [, id, action] = roomMatch;

      if (req.method === "GET" && !action) {
        const room = await deps.store.get(id);
        if (!room) throw new RoomError("No such game.", 404);
        const since = Number(url.searchParams.get("since") ?? 0);
        return reply({
          room: viewOf(room),
          since: Number.isFinite(since) ? since : 0,
          moves: movesSince(room, Number.isFinite(since) ? since : 0),
        });
      }

      if (req.method === "POST" && action === "/join") {
        const body = await readJson(req);
        // A client that already has a token for this room sends it, and gets
        // its own seat back instead of a second one.
        const existing = body.token ? String(body.token) : "";
        const token = existing || deps.newToken();
        let seated;
        const room = await mutate(deps, id, (current) => {
          seated = join(
            current,
            String(body.name ?? ""),
            token,
            body.seat === undefined ? undefined : Number(body.seat)
          );
          return seated.room;
        });
        // The token goes to this client and is never in a room view.
        return reply({ token, seat: seated!.player.seat, room: viewOf(room) }, 201);
      }

      if (req.method === "POST" && action === "/move") {
        const body = await readJson(req);
        const room = await mutate(deps, id, (current) =>
          play(
            current,
            String(body.token ?? ""),
            Number(body.index),
            Number(body.expect),
            deps.now()
          )
        );
        return reply({ room: viewOf(room) });
      }
    }

    if (req.method === "GET" && path === "/api/health") {
      return reply({
        ok: true,
        storage: deps.storage ?? "unknown",
        // Prefix, not equality: the memory store reports why it was chosen,
        // so "memory (openKv missing)" must still count as not durable.
        durable: !(deps.storage ?? "").startsWith("memory"),
      });
    }

    // Opening the server in a browser should say "this is alive and it is
    // not a website", rather than a bare 404 that reads as a broken deploy.
    if (req.method === "GET" && (path === "" || path === "/")) {
      return new Response(STATUS_PAGE, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Browsers ask for this unprompted. 204 keeps it out of the error log.
    if (path === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    return reply({ error: "Not found." }, 404);
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// A store that keeps rooms in memory. Correct for one process, and the thing
// tests and local runs use. A hosted deployment wants a real one.
// ---------------------------------------------------------------------------

export function memoryStore(): RoomStore & { rooms: Map<string, Room> } {
  const rooms = new Map<string, Room>();
  return {
    rooms,
    async get(id) {
      return rooms.get(id) ?? null;
    },
    async swap(previous, next) {
      const current = rooms.get(next.id) ?? null;
      // Reference equality is enough: every change produces a new object.
      if (current !== previous) return false;
      rooms.set(next.id, next);
      return true;
    },
  };
}

/** Room codes people have to read out loud. No 0/O, no 1/I. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomRoomId(length = 5): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
