import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import {
  handle,
  memoryStore,
  randomRoomId,
  randomToken,
  type ServerDeps,
} from "../src/server-api.ts";
import { stateOf, type Room } from "../src/room.ts";
import { legalMoves } from "../src/pond-engine.ts";

/** Deterministic deps: ids and tokens count up, so tests can predict them. */
function deps(over: Partial<ServerDeps> = {}): ServerDeps & { store: ReturnType<typeof memoryStore> } {
  const store = memoryStore();
  let rooms = 0;
  let tokens = 0;
  return {
    store,
    now: () => 1_700_000_000_000,
    newRoomId: () => `ROOM${++rooms}`,
    // Must be distinct per player: an earlier version of this helper reused
    // one token for everybody, and the server happily treated two players as
    // one. That is now rejected outright, but the test was wrong too.
    newToken: () => `tok${++tokens}`,
    ...over,
  } as ServerDeps & { store: ReturnType<typeof memoryStore> };
}

const call = (d: ServerDeps, method: string, path: string, body?: unknown) =>
  handle(
    new Request(`http://x${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
    d
  );

async function json(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

/** Create a room and seat every player, returning their tokens by seat. */
async function table(d: ServerDeps, variantId = "standard-2p") {
  const created = await json(await call(d, "POST", "/api/rooms", { variantId, seed: 7 }));
  const id = created.room.id;
  const tokens: string[] = [];
  for (const seat of [...created.room.openSeats]) {
    const j = await json(await call(d, "POST", `/api/rooms/${id}/join`, { name: `P${seat}` }));
    tokens[j.seat] = j.token;
  }
  return { id, tokens };
}

describe("rooms over HTTP", () => {
  it("creates a room and reports open seats", async () => {
    const d = deps();
    const res = await call(d, "POST", "/api/rooms", { variantId: "standard-2p", seed: 3 });
    expect(res.status).toBe(201);
    const { room } = await json(res);
    expect(room.id).toBe("ROOM1");
    expect(room.openSeats).toEqual([0, 1]);
    expect(room.moves).toHaveLength(0);
  });

  it("picks a seed when none is given, so nobody fishes for good rolls", async () => {
    const d = deps();
    const a = await json(await call(d, "POST", "/api/rooms", {}));
    const b = await json(await call(d, "POST", "/api/rooms", {}));
    expect(a.room.seed === b.room.seed).toBe(false);
  });

  it("refuses an unknown variant", async () => {
    const d = deps();
    const res = await call(d, "POST", "/api/rooms", { variantId: "nonsense" });
    expect(res.status).toBe(400);
  });

  it("404s an unknown room without leaking anything", async () => {
    const d = deps();
    const res = await call(d, "GET", "/api/rooms/NOPE1");
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe("No such game.");
  });

  it("hands each player a private token and never shows it to others", async () => {
    const d = deps();
    const { id, tokens } = await table(d);
    expect(tokens.filter(Boolean)).toHaveLength(2);
    const seen = await call(d, "GET", `/api/rooms/${id}`);
    expect((await seen.text()).includes("tok")).toBe(false);
  });

  it("refuses a third player at a two-seat table", async () => {
    const d = deps();
    const { id } = await table(d);
    const res = await call(d, "POST", `/api/rooms/${id}/join`, { name: "late" });
    expect(res.status).toBe(409);
  });
});

describe("playing over HTTP", () => {
  it("accepts a move from the player to move, and rejects the other", async () => {
    const d = deps();
    const { id, tokens } = await table(d);

    const wrong = await call(d, "POST", `/api/rooms/${id}/move`, {
      token: tokens[1], index: 0, expect: 0,
    });
    expect(wrong.status).toBe(409);

    const right = await call(d, "POST", `/api/rooms/${id}/move`, {
      token: tokens[0], index: 0, expect: 0,
    });
    expect(right.status).toBe(200);
    expect((await json(right)).room.moves).toEqual([0]);
  });

  it("rejects a stranger's token", async () => {
    const d = deps();
    const { id } = await table(d);
    const res = await call(d, "POST", `/api/rooms/${id}/move`, {
      token: "forged", index: 0, expect: 0,
    });
    expect(res.status).toBe(403);
  });

  it("rejects a move built on a stale board", async () => {
    const d = deps();
    const { id, tokens } = await table(d);
    await call(d, "POST", `/api/rooms/${id}/move`, { token: tokens[0], index: 0, expect: 0 });
    const stale = await call(d, "POST", `/api/rooms/${id}/move`, {
      token: tokens[1], index: 0, expect: 0,
    });
    expect(stale.status).toBe(409);
  });

  it("rejects an index that is not on offer", async () => {
    const d = deps();
    const { id, tokens } = await table(d);
    for (const index of [999, -1, "x" as unknown as number]) {
      const res = await call(d, "POST", `/api/rooms/${id}/move`, {
        token: tokens[0], index, expect: 0,
      });
      expect(res.status).toBe(400);
    }
  });

  it("gives a reconnecting client exactly what it missed", async () => {
    const d = deps();
    const { id, tokens } = await table(d);
    for (let i = 0; i < 6; i++) {
      const room: Room = d.store.rooms.get(id)!;
      const seat = stateOf(room).turn;
      await call(d, "POST", `/api/rooms/${id}/move`, {
        token: tokens[seat], index: 0, expect: room.moves.length,
      });
    }
    const all = await json(await call(d, "GET", `/api/rooms/${id}?since=0`));
    const partial = await json(await call(d, "GET", `/api/rooms/${id}?since=4`));
    expect(all.moves).toHaveLength(6);
    expect(partial.moves).toEqual(all.moves.slice(4));
    // A client claiming an impossible position gets nothing, not a crash.
    expect((await json(await call(d, "GET", `/api/rooms/${id}?since=99`))).moves).toHaveLength(0);
  });

  it("only ever accepts a move the engine offered", async () => {
    const d = deps();
    const { id, tokens } = await table(d);
    const count = legalMoves(stateOf(d.store.rooms.get(id)!)).length;
    const res = await call(d, "POST", `/api/rooms/${id}/move`, {
      token: tokens[0], index: count, expect: 0,
    });
    expect(res.status).toBe(400);
  });
});

describe("cross-origin and plumbing", () => {
  it("answers a preflight so a page on another origin can call it", async () => {
    const res = await call(deps(), "OPTIONS", "/api/rooms");
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("can be locked to one origin", async () => {
    const d = deps({ allowOrigin: "https://ghollisjr.github.io" });
    const res = await call(d, "GET", "/api/health");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://ghollisjr.github.io");
  });

  it("shows a page at the root instead of a bare 404", async () => {
    // Opening the server in a browser reads as a broken deploy otherwise.
    const res = await call(deps(), "GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")!.includes("text/html")).toBe(true);
    const body = await res.text();
    expect(body.includes("not the game")).toBe(true);
  });

  it("answers the favicon browsers ask for unprompted", async () => {
    expect((await call(deps(), "GET", "/favicon.ico")).status).toBe(204);
  });

  it("echoes an allowed origin so several can be permitted at once", async () => {
    const d = deps({
      allowOrigin: "https://ghollisjr.github.io, http://localhost:8000",
    });
    const from = (origin: string) =>
      handle(new Request("http://x/api/health", { headers: { origin } }), d);

    expect((await from("http://localhost:8000")).headers.get("access-control-allow-origin"))
      .toBe("http://localhost:8000");
    expect((await from("https://ghollisjr.github.io")).headers.get("access-control-allow-origin"))
      .toBe("https://ghollisjr.github.io");
    // An origin not on the list is not echoed back.
    expect((await from("https://evil.example")).headers.get("access-control-allow-origin"))
      .toBe("https://ghollisjr.github.io");
    // Caches must not serve one origin's response to another.
    expect((await from("http://localhost:8000")).headers.get("vary")).toBe("origin");
  });

  it("has a health check and a 404", async () => {
    const d = deps();
    expect((await json(await call(d, "GET", "/api/health"))).ok).toBe(true);
    expect((await call(d, "GET", "/api/nope")).status).toBe(404);
  });

  it("survives a malformed body instead of returning 500", async () => {
    const d = deps();
    const res = await handle(
      new Request("http://x/api/rooms", { method: "POST", body: "{not json" }),
      d
    );
    expect(res.status).toBe(201); // falls back to defaults
  });
});

describe("identity", () => {
  it("refuses to seat two players under one token", async () => {
    // Impossible with real 24-byte tokens, but if it ever happened the
    // server would quietly treat both as the same player, and the second
    // would be able to move on the first's turn. Fail loudly instead.
    const d = deps({ newToken: () => "same-token" });
    const created = await json(await call(d, "POST", "/api/rooms", { variantId: "standard-2p" }));
    const id = created.room.id;
    expect((await call(d, "POST", `/api/rooms/${id}/join`, { name: "a" })).status).toBe(201);
    expect((await call(d, "POST", `/api/rooms/${id}/join`, { name: "b" })).status).toBe(500);
  });
});

describe("generated ids", () => {
  it("avoid characters people misread aloud", () => {
    const id = randomRoomId(200);
    expect(/[01OI]/.test(id)).toBe(false);
    expect(randomRoomId().length).toBe(5);
  });

  it("make tokens long enough not to guess", () => {
    expect(randomToken().length).toBe(48);
    expect(randomToken() === randomToken()).toBe(false);
  });
});
