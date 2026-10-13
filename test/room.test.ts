import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import {
  RoomError,
  createRoom,
  join,
  movesSince,
  play,
  seatCount,
  stateOf,
  viewOf,
  type Room,
} from "../src/room.ts";
import { legalMoves } from "../src/pond-engine.ts";

const NOW = 1_700_000_000_000;

function fresh(variantId = "standard-4p"): Room {
  return createRoom({ id: "HOPPY", variantId, seed: 7, now: NOW });
}

/** Seat every player, returning their tokens in seat order. */
function seatAll(room: Room): { room: Room; tokens: string[] } {
  let r = room;
  const tokens: string[] = [];
  for (let i = 0; i < seatCount(room); i++) {
    const out = join(r, `P${i + 1}`, `tok${i}`);
    r = out.room;
    tokens[out.player.seat] = out.player.token;
  }
  return { room: r, tokens };
}

/** Take the current player's first legal move. */
function step(room: Room, tokens: string[]): Room {
  const state = stateOf(room);
  return play(room, tokens[state.turn], 0, room.moves.length, NOW);
}

describe("creating a room", () => {
  it("starts empty with every seat open", () => {
    const v = viewOf(fresh());
    expect(v.moves).toHaveLength(0);
    expect(v.players).toHaveLength(0);
    expect(v.openSeats).toEqual([0, 1, 2, 3]);
    expect(v.turn).toBe(0);
    expect(v.finished).toBe(false);
  });

  it("sizes itself to the variant", () => {
    expect(viewOf(fresh("standard-2p")).openSeats).toEqual([0, 1]);
    expect(viewOf(fresh("triple-trouble")).openSeats).toEqual([0, 1, 2]);
  });

  it("rejects an unknown variant at creation, not at the first move", () => {
    expect(() => createRoom({ id: "x", variantId: "nope", seed: 1, now: NOW })).toThrow();
  });
});

describe("joining", () => {
  it("fills seats in order and reports who is in", () => {
    const { room } = seatAll(fresh("standard-2p"));
    const v = viewOf(room);
    expect(v.players).toEqual([
      { seat: 0, name: "P1" },
      { seat: 1, name: "P2" },
    ]);
    expect(v.openSeats).toHaveLength(0);
  });

  it("refuses a full game and a taken seat", () => {
    const { room } = seatAll(fresh("standard-2p"));
    expect(() => join(room, "late", "t")).toThrow();
    const partial = join(fresh(), "a", "t0").room;
    expect(() => join(partial, "b", "t1", 0)).toThrow();
  });

  it("never leaks a token in the view", () => {
    const { room } = seatAll(fresh());
    expect(JSON.stringify(viewOf(room)).includes("tok")).toBe(false);
  });

  it("falls back to a seat name when none is given", () => {
    const { player } = join(fresh(), "   ", "t");
    expect(player.name).toBe("Player 1");
  });
});

describe("playing", () => {
  it("accepts the seated player's move and appends it", () => {
    const { room, tokens } = seatAll(fresh());
    const after = play(room, tokens[0], 0, 0, NOW);
    expect(after.moves).toEqual([0]);
    expect(stateOf(after).history).toHaveLength(1);
  });

  it("refuses someone who is not in the game", () => {
    const { room } = seatAll(fresh());
    expect(() => play(room, "not-a-token", 0, 0, NOW)).toThrow();
  });

  it("refuses a player moving out of turn", () => {
    const { room, tokens } = seatAll(fresh());
    // Seat 0 is to move, so seat 1 must be refused.
    expect(() => play(room, tokens[1], 0, 0, NOW)).toThrow();
  });

  it("refuses a move index that does not exist", () => {
    const { room, tokens } = seatAll(fresh());
    expect(() => play(room, tokens[0], 999, 0, NOW)).toThrow();
    expect(() => play(room, tokens[0], -1, 0, NOW)).toThrow();
  });

  it("refuses a move built on a stale view of the board", () => {
    const { room, tokens } = seatAll(fresh());
    const after = play(room, tokens[0], 0, 0, NOW);
    // This client still thinks the log is empty.
    const stale = () => play(after, tokens[stateOf(after).turn], 0, 0, NOW);
    expect(stale).toThrow();
    // Told the truth, the same move is fine.
    expect(() =>
      play(after, tokens[stateOf(after).turn], 0, after.moves.length, NOW)
    ).not.toThrow();
  });

  it("carries a real game forward and stays replayable", () => {
    let { room, tokens } = seatAll(fresh());
    for (let i = 0; i < 60 && !viewOf(room).finished; i++) room = step(room, tokens);
    const state = stateOf(room);
    expect(room.moves.length).toBeGreaterThan(30);
    expect(state.history.length).toBe(room.moves.length);
    // The log is the whole truth: a fresh rebuild matches.
    expect(stateOf({ ...room }).pieces).toEqual(state.pieces);
  });

  it("refuses everything once the game is over", () => {
    let { room, tokens } = seatAll(fresh("standard-2p"));
    for (let i = 0; i < 4000 && !viewOf(room).finished; i++) room = step(room, tokens);
    expect(viewOf(room).finished).toBe(true);
    expect(viewOf(room).turn).toBe(null);
    expect(() => play(room, tokens[0], 0, room.moves.length, NOW)).toThrow();
  });

  it("reports an error a host can turn into a status code", () => {
    const { room } = seatAll(fresh());
    try {
      play(room, "bogus", 0, 0, NOW);
      throw new Error("should have refused");
    } catch (e) {
      expect(e instanceof RoomError).toBe(true);
      expect((e as RoomError).status).toBe(403);
    }
  });
});

describe("catching up", () => {
  it("returns only what the client has not seen", () => {
    let { room, tokens } = seatAll(fresh());
    for (let i = 0; i < 5; i++) room = step(room, tokens);
    expect(movesSince(room, 0)).toHaveLength(5);
    expect(movesSince(room, 3)).toEqual(room.moves.slice(3));
    expect(movesSince(room, 5)).toHaveLength(0);
  });

  it("copes with a client claiming an impossible position", () => {
    let { room, tokens } = seatAll(fresh());
    room = step(room, tokens);
    expect(movesSince(room, 999)).toHaveLength(0);
    expect(movesSince(room, -5)).toEqual(room.moves);
  });

  it("is all a reconnect needs", () => {
    let { room, tokens } = seatAll(fresh());
    for (let i = 0; i < 12; i++) room = step(room, tokens);
    // A client that saw the first 4 moves replays the rest and agrees.
    const caughtUp = [...room.moves.slice(0, 4), ...movesSince(room, 4)];
    expect(caughtUp).toEqual(room.moves);
  });
});

describe("the server trusts nothing", () => {
  it("only ever accepts a move the engine already offered", () => {
    const { room, tokens } = seatAll(fresh());
    const options = legalMoves(stateOf(room));
    // Every in-range index is acceptable; everything else is refused.
    for (let i = 0; i < options.length; i++) {
      expect(() => play(room, tokens[0], i, 0, NOW)).not.toThrow();
    }
    expect(() => play(room, tokens[0], options.length, 0, NOW)).toThrow();
  });
});

describe("waiting for a full table", () => {
  it("refuses play while a seat is empty", () => {
    // Turn order visits every seat on the board, so an empty one is a turn
    // nobody can take. Without this the game deadlocks a move or two in.
    const partial = join(fresh("standard-2p"), "solo", "t0").room;
    expect(viewOf(partial).openSeats).toHaveLength(1);
    expect(() => play(partial, "t0", 0, 0, NOW)).toThrow();
  });

  it("allows play the moment the last seat is taken", () => {
    const { room, tokens } = seatAll(fresh("standard-2p"));
    expect(viewOf(room).openSeats).toHaveLength(0);
    expect(() => play(room, tokens[0], 0, 0, NOW)).not.toThrow();
  });
})

describe("rejoining", () => {
  it("hands back the seat you already hold rather than a new one", () => {
    const first = join(fresh(), "Alice", "tok-a");
    expect(first.player.seat).toBe(0);
    const again = join(first.room, "Alice", "tok-a");
    expect(again.player.seat).toBe(0);
    expect(again.room.players).toHaveLength(1);
    expect(viewOf(again.room).openSeats).toHaveLength(3);
  });

  it("does not let one client occupy the table", () => {
    // Four joins with the same token must leave three seats open, not none.
    let room = fresh();
    for (let i = 0; i < 4; i++) room = join(room, "Alice", "tok-a").room;
    expect(viewOf(room).openSeats).toEqual([1, 2, 3]);
  });

  it("refuses to move a seated player to another seat", () => {
    const { room } = join(fresh(), "Alice", "tok-a");
    expect(() => join(room, "Alice", "tok-a", 2)).toThrow();
  });
})
