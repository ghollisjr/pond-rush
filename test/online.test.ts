import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import {
  OnlineClient,
  OnlineError,
  recallSeat,
  rememberSeat,
  type Fetcher,
  type SeatStore,
} from "../src/ui/online.ts";
import { handle, memoryStore, type ServerDeps } from "../src/server-api.ts";

/**
 * The real server, called in-process. No HTTP stack, but every byte goes
 * through the same request handling, serialisation and error mapping a
 * deployed server uses — so the client is tested against the server rather
 * than against a mock of it.
 */
function liveClient(): { client: OnlineClient; deps: ServerDeps } {
  const store = memoryStore();
  let n = 0;
  let t = 0;
  const deps: ServerDeps = {
    store,
    now: () => 1_700_000_000_000,
    newRoomId: () => `ROOM${++n}`,
    newToken: () => `tok${++t}`,
  };
  const fetcher: Fetcher = (input, init) =>
    handle(new Request(String(input), init as RequestInit), deps);
  return { client: new OnlineClient("https://server.test", fetcher), deps };
}

function memStore(): SeatStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("talking to the server", () => {
  it("creates a room and joins it", async () => {
    const { client } = liveClient();
    const room = await client.createRoom("standard-2p");
    expect(room.openSeats).toEqual([0, 1]);

    const { seat, room: after } = await client.join(room.id, "Alice");
    expect(seat.seat).toBe(0);
    expect(after.players).toEqual([{ seat: 0, name: "Alice" }]);
    expect(seat.token.length).toBeGreaterThan(0);
  });

  it("never lets the server pick up a client-chosen seed", async () => {
    const { client } = liveClient();
    const a = await client.createRoom("standard-2p");
    const b = await client.createRoom("standard-2p");
    // Two rooms made the same way must not share a seed.
    expect(a.seed === b.seed).toBe(false);
  });

  it("plays a move and sees it reflected", async () => {
    const { client } = liveClient();
    const room = await client.createRoom("standard-2p");
    const a = await client.join(room.id, "A");
    await client.join(room.id, "B");

    // A turn is a roll and then an action, so the first move does not hand
    // over to the other player — the roll belongs to the same turn.
    const afterRoll = await client.move(room.id, a.seat.token, 0, 0);
    expect(afterRoll.moves).toEqual([0]);
    expect(afterRoll.turn).toBe(0);

    const afterAction = await client.move(room.id, a.seat.token, 0, 1);
    expect(afterAction.moves).toHaveLength(2);
    expect(afterAction.turn).toBe(1);
  });

  it("surfaces the server's refusal as a readable error", async () => {
    const { client } = liveClient();
    const room = await client.createRoom("standard-2p");
    await client.join(room.id, "A");
    const b = await client.join(room.id, "B");
    try {
      await client.move(room.id, b.seat.token, 0, 0); // not B's turn
      throw new Error("should have been refused");
    } catch (e) {
      expect(e instanceof OnlineError).toBe(true);
      expect((e as OnlineError).status).toBe(409);
      expect((e as OnlineError).message).toBe("It is not your turn.");
    }
  });

  it("fetches only the moves it has not seen", async () => {
    const { client } = liveClient();
    const room = await client.createRoom("standard-2p");
    const seats = [
      (await client.join(room.id, "A")).seat,
      (await client.join(room.id, "B")).seat,
    ];

    // Follow whose turn the server says it is, rather than assuming.
    let view = (await client.since(room.id, 0)).room;
    for (let i = 0; i < 4; i++) {
      const token = seats.find((s) => s.seat === view.turn)!.token;
      view = await client.move(room.id, token, 0, view.moves.length);
    }

    expect((await client.since(room.id, 0)).moves).toHaveLength(4);
    expect((await client.since(room.id, 3)).moves).toHaveLength(1);
    expect((await client.since(room.id, 4)).moves).toHaveLength(0);
  });

  it("reports an unreachable server rather than throwing something cryptic", async () => {
    const dead: Fetcher = () => Promise.reject(new TypeError("Failed to fetch"));
    const client = new OnlineClient("https://nope.test", dead);
    expect(await client.health()).toBe(false);
    try {
      await client.createRoom("standard-2p");
      throw new Error("should have failed");
    } catch (e) {
      expect(e instanceof OnlineError).toBe(true);
      expect((e as OnlineError).status).toBe(0);
      expect((e as OnlineError).message.includes("Can't reach the server")).toBe(true);
    }
  });

  it("copes with a non-JSON error page from something in the middle", async () => {
    const proxy: Fetcher = async () =>
      new Response("<html>502 Bad Gateway</html>", { status: 502 });
    const client = new OnlineClient("https://x.test", proxy);
    try {
      await client.createRoom("standard-2p");
      throw new Error("should have failed");
    } catch (e) {
      expect((e as OnlineError).status).toBe(502);
      expect((e as OnlineError).message).toBe("Server said 502.");
    }
  });

  it("has a health check that answers true against a real server", async () => {
    const { client } = liveClient();
    expect(await client.health()).toBe(true);
  });
});

describe("calling convention", () => {
  // The browser's fetch must be called with `this` as the window. Storing it
  // as `this.fetcher = fetch` and calling it as a method passes the client as
  // `this`, which Chrome rejects with "Illegal invocation" — and which node
  // accepts silently, so every test here passed while the page was broken.
  // This fetcher is as fussy as a browser so the suite can see it.
  const browserish: Fetcher = function (this: unknown, _input, _init) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  };

  it("calls fetch the way a browser requires", async () => {
    const client = new OnlineClient("https://x.test", browserish);
    expect(await client.health()).toBe(true);
  });

  it("applies to every call, not just the health check", async () => {
    const client = new OnlineClient("https://x.test", function (this: unknown) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(
        new Response(JSON.stringify({ room: { id: "R", openSeats: [] } }))
      );
    } as Fetcher);
    await client.createRoom("standard-2p");
    await client.since("R", 0);
  });
});

describe("remembering a seat", () => {
  it("round-trips per room", () => {
    const store = memStore();
    rememberSeat(store, "ROOM1", { token: "t1", seat: 0 });
    rememberSeat(store, "ROOM2", { token: "t2", seat: 3 });
    expect(recallSeat(store, "ROOM1")).toEqual({ token: "t1", seat: 0 });
    expect(recallSeat(store, "ROOM2")!.seat).toBe(3);
    expect(recallSeat(store, "ROOM3")).toBe(null);
  });

  it("survives a corrupted store", () => {
    const store = memStore();
    store.data.set("pond-rush/seats", "not json");
    expect(recallSeat(store, "ROOM1")).toBe(null);
    expect(() => rememberSeat(store, "ROOM1", { token: "t", seat: 0 })).not.toThrow();
  });

  it("does not throw when storage refuses to write", () => {
    const readOnly: SeatStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    // Losing the token costs the seat on reload; refusing to play costs more.
    expect(() => rememberSeat(readOnly, "R", { token: "t", seat: 0 })).not.toThrow();
  });
});
