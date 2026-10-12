import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import {
  decodeGame,
  encodeGame,
  loadSaved,
  replayIndices,
  saveGame,
  toIndices,
  type GameRef,
  type KeyValueStore,
  type SavedGame,
} from "../src/session.ts";
import {
  applyMove,
  createGame,
  legalMoves,
  moveIndex,
  scores,
  type GameState,
  type Move,
} from "../src/pond-engine.ts";
import { VariantRegistry } from "../src/rules.ts";

const reg = new VariantRegistry();

/** Play a game deterministically and return it with its move log. */
function play(variantId: string, seed: number, turns: number): GameState {
  const { board, rules } = reg.resolve(variantId);
  let s = createGame(seed, board, rules);
  for (let t = 0; t < turns && s.phase !== "finished"; t++) {
    const opts = legalMoves(s);
    s = applyMove(s, opts[(t * 7) % opts.length]);
  }
  return s;
}

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe("move indices", () => {
  it("describe a move completely, because legalMoves is deterministic", () => {
    const { board, rules } = reg.resolve("standard-4p");
    const s = applyMove(createGame(5, board, rules), { kind: "roll" });
    const move = legalMoves(s)[3];
    expect(moveIndex(s, move)).toBe(3);
  });

  it("report -1 for a move that is not legal here", () => {
    const { board, rules } = reg.resolve("standard-4p");
    const fresh = createGame(5, board, rules);
    // Before the roll, the only legal move is the roll itself.
    expect(moveIndex(fresh, { kind: "pass" } as Move)).toBe(-1);
  });

  it("round-trip a whole game back to the identical state", () => {
    const played = play("standard-4p", 9, 120);
    const { board, rules } = reg.resolve("standard-4p");
    const idx = toIndices(9, played.history, board, rules);
    const rebuilt = replayIndices(
      { variantId: "standard-4p", seed: 9, moves: idx },
      board,
      rules
    );
    expect(rebuilt.history.length).toBe(played.history.length);
    expect(rebuilt.turn).toBe(played.turn);
    expect(rebuilt.phase).toBe(played.phase);
    expect(scores(rebuilt)).toEqual(scores(played));
    expect(rebuilt.pieces).toEqual(played.pieces);
    expect(rebuilt.hazard).toEqual(played.hazard);
  });

  it("are far shorter than the moves themselves", () => {
    const played = play("standard-4p", 9, 120);
    const { board, rules } = reg.resolve("standard-4p");
    const idx = toIndices(9, played.history, board, rules);
    const link = encodeGame({ variantId: "standard-4p", seed: 9, moves: idx });
    expect(link.length < JSON.stringify(played.history).length / 10).toBe(true);
  });
});

describe("game links", () => {
  it("round-trip through encode and decode", () => {
    const ref: GameRef = { variantId: "gap-jump", seed: 42, moves: [0, 3, 1, 17, 200, 4095] };
    expect(decodeGame(encodeGame(ref))).toEqual(ref);
  });

  it("survive indices too large for one byte", () => {
    // A Gap Jump leap face can offer hundreds of options; a byte would wrap.
    const ref: GameRef = { variantId: "gap-jump", seed: 1, moves: [127, 128, 129, 16383, 16384] };
    expect(decodeGame(encodeGame(ref)).moves).toEqual(ref.moves);
  });

  it("handle a game with no moves yet", () => {
    const ref: GameRef = { variantId: "standard-2p", seed: 7, moves: [] };
    expect(decodeGame(encodeGame(ref))).toEqual(ref);
  });

  it("are URL-fragment safe", () => {
    const played = play("standard-4p", 3, 90);
    const { board, rules } = reg.resolve("standard-4p");
    const link = encodeGame({
      variantId: "standard-4p",
      seed: 3,
      moves: toIndices(3, played.history, board, rules),
    });
    expect(encodeURIComponent(link)).toBe(link);
  });

  it("reject nonsense rather than guessing", () => {
    expect(() => decodeGame("")).toThrow();
    expect(() => decodeGame("v1.standard-4p")).toThrow();
    expect(() => decodeGame("v2.standard-4p.1.AA")).toThrow();
    expect(() => decodeGame("v1..1.AA")).toThrow();
    expect(() => decodeGame("v1.standard-4p.abc.AA")).toThrow();
  });

  it("reject a tampered link instead of playing a wrong game", () => {
    const { board, rules } = reg.resolve("standard-4p");
    const played = play("standard-4p", 9, 20);
    const moves = toIndices(9, played.history, board, rules);
    // An index past the end of legalMoves cannot be anything but corruption.
    const tampered = { variantId: "standard-4p", seed: 9, moves: [...moves, 9999] };
    expect(() => replayIndices(tampered, board, rules)).toThrow();
  });
});

describe("saved games", () => {
  const base: SavedGame = {
    id: "a", variantId: "standard-4p", seed: 1, moves: [0], updatedAt: 1000,
  };

  it("start empty and survive a corrupted store", () => {
    expect(loadSaved(memoryStore())).toHaveLength(0);
    const broken = memoryStore();
    broken.data.set("pond-rush/games", "{not json");
    expect(loadSaved(broken)).toHaveLength(0);
  });

  it("round-trip", () => {
    const store = memoryStore();
    saveGame(store, base);
    expect(loadSaved(store)).toEqual([base]);
  });

  it("update a game in place rather than duplicating it", () => {
    const store = memoryStore();
    saveGame(store, base);
    saveGame(store, { ...base, moves: [0, 1, 2], updatedAt: 2000 });
    const saved = loadSaved(store);
    expect(saved).toHaveLength(1);
    expect(saved[0].moves).toEqual([0, 1, 2]);
  });

  it("keep the newest first and cap the list", () => {
    const store = memoryStore();
    for (let i = 0; i < 25; i++) {
      saveGame(store, { ...base, id: `g${i}`, updatedAt: 1000 + i });
    }
    const saved = loadSaved(store);
    expect(saved).toHaveLength(20);
    expect(saved[0].id).toBe("g24");
  });

  it("do not throw when storage refuses to write", () => {
    const readOnly: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    // Losing a save is survivable; throwing mid-move is not.
    expect(() => saveGame(readOnly, base)).not.toThrow();
  });
});
