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
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function cors(deps: ServerDeps): Record<string, string> {
  return {
    "access-control-allow-origin": deps.allowOrigin ?? "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
  };
}

function reply(deps: ServerDeps, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...cors(deps) },
  });
}

function fail(deps: ServerDeps, err: unknown): Response {
  const status = err instanceof RoomError ? err.status : 500;
  const message =
    err instanceof RoomError
      ? err.message
      : // Never hand an internal failure's details to a client.
        "Something went wrong on the server.";
  if (status === 500) console.error("pond-rush:", err);
  return reply(deps, { error: message }, status);
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
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(deps) });
  }

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
      return reply(deps, { room: viewOf(room) }, 201);
    }

    const roomMatch = /^\/api\/rooms\/([A-Za-z0-9_-]{1,32})(\/[a-z]+)?$/.exec(path);
    if (roomMatch) {
      const [, id, action] = roomMatch;

      if (req.method === "GET" && !action) {
        const room = await deps.store.get(id);
        if (!room) throw new RoomError("No such game.", 404);
        const since = Number(url.searchParams.get("since") ?? 0);
        return reply(deps, {
          room: viewOf(room),
          since: Number.isFinite(since) ? since : 0,
          moves: movesSince(room, Number.isFinite(since) ? since : 0),
        });
      }

      if (req.method === "POST" && action === "/join") {
        const body = await readJson(req);
        const token = deps.newToken();
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
        return reply(deps, { token, seat: seated!.player.seat, room: viewOf(room) }, 201);
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
        return reply(deps, { room: viewOf(room) });
      }
    }

    if (req.method === "GET" && path === "/api/health") {
      return reply(deps, { ok: true });
    }

    return reply(deps, { error: "Not found." }, 404);
  } catch (err) {
    return fail(deps, err);
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
