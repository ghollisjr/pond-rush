import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import {
  NO_SELECTION,
  beginRescue,
  click,
  confirmableMove,
  highlightsFor,
  pendingAt,
  rescuablePieces,
  selectablePieces,
  turnStatus,
} from "../src/ui/hotseat.ts";
import {
  applyMove,
  createGame,
  eq,
  legalMoves,
  type GameState,
  type Move,
} from "../src/pond-engine.ts";
import { BOARD_4P, OFFICIAL_RULES } from "../src/rules.ts";

/** Roll until the current player faces the given kind of die face. */
function rollUntil(kind: "move" | "leap" | "hazard", limit = 400): GameState {
  for (let seed = 1; seed < limit; seed++) {
    let s = createGame(seed, BOARD_4P, OFFICIAL_RULES);
    for (let turn = 0; turn < 12; turn++) {
      s = applyMove(s, { kind: "roll" });
      if (s.pending?.kind === kind) return s;
      s = applyMove(s, { kind: "pass" });
    }
  }
  throw new Error(`never rolled a ${kind} face`);
}

describe("hotseat selection", () => {
  it("does nothing before the roll", () => {
    const s = createGame(3, BOARD_4P, OFFICIAL_RULES);
    expect(highlightsFor(s, NO_SELECTION)).toHaveLength(0);
    const r = click(s, NO_SELECTION, { r: 0, c: 0 });
    expect(r.move).toBe(null);
    expect(turnStatus(s).canRoll).toBe(true);
  });

  it("highlights nothing until a piece is picked up", () => {
    const s = rollUntil("move");
    expect(highlightsFor(s, NO_SELECTION)).toHaveLength(0);

    const id = selectablePieces(s)[0];
    const at = s.pieces.find((p) => p.id === id)!.at!;
    const picked = click(s, NO_SELECTION, at);
    expect(picked.move).toBe(null);
    expect(picked.selection.piece).toBe(id);
    expect(highlightsFor(s, picked.selection).length).toBeGreaterThan(0);
  });

  it("only highlights cells the engine actually allows", () => {
    const s = rollUntil("move");
    const id = selectablePieces(s)[0];
    const sel = click(s, NO_SELECTION, s.pieces.find((p) => p.id === id)!.at!).selection;

    const legal = legalMoves(s).filter(
      (m): m is Extract<Move, { kind: "move" }> => m.kind === "move" && m.piece === id
    );
    for (const h of highlightsFor(s, sel)) {
      expect(legal.some((m) => eq(m.to, h))).toBe(true);
    }
  });

  it("clicking a highlighted cell yields a move the engine accepts", () => {
    const s = rollUntil("move");
    const id = selectablePieces(s)[0];
    const sel = click(s, NO_SELECTION, s.pieces.find((p) => p.id === id)!.at!).selection;
    const dest = highlightsFor(s, sel)[0];

    const r = click(s, sel, dest);
    expect(r.move).not.toBe(null);
    expect(r.selection).toEqual(NO_SELECTION);
    const after = applyMove(s, r.move!); // throws if illegal
    expect(after.pieces.find((p) => p.id === id)!.at).toEqual(dest);
  });

  it("clicking the held piece again puts it down", () => {
    const s = rollUntil("move");
    const id = selectablePieces(s)[0];
    const at = s.pieces.find((p) => p.id === id)!.at!;
    const sel = click(s, NO_SELECTION, at).selection;
    expect(click(s, sel, at).selection).toEqual(NO_SELECTION);
  });

  it("ignores a click on empty water with nothing held", () => {
    const s = rollUntil("move");
    const empty = { r: 4, c: 4 };
    expect(click(s, NO_SELECTION, empty).move).toBe(null);
  });

  it("never returns a move the engine would reject", () => {
    // Sweep every cell against every selection state for a handful of games.
    for (let seed = 1; seed <= 25; seed++) {
      let s = createGame(seed, BOARD_4P, OFFICIAL_RULES);
      for (let turn = 0; turn < 20 && s.phase !== "finished"; turn++) {
        s = applyMove(s, { kind: "roll" });
        let sel = NO_SELECTION;
        for (let r = 0; r < s.cells.length; r++) {
          for (let c = 0; c < s.cells[r].length; c++) {
            const out = click(s, sel, { r, c });
            if (out.move) expect(() => applyMove(s, out.move!)).not.toThrow();
            else sel = out.selection;
          }
        }
        s = applyMove(s, { kind: "pass" });
      }
    }
  });
});

describe("hotseat hazard face", () => {
  it("lights up every legal cell with no piece selected", () => {
    const s = rollUntil("hazard");
    const cells = highlightsFor(s, NO_SELECTION);
    expect(cells.length).toBeGreaterThan(0);

    const r = click(s, NO_SELECTION, cells[0]);
    expect(r.move!.kind).toBe("hazard");
    expect(() => applyMove(s, r.move!)).not.toThrow();
  });
});

describe("hotseat leap chains", () => {
  it("builds a chain one landing at a time and confirms a legal prefix", () => {
    const s = rollUntil("leap");
    const chained = legalMoves(s).filter(
      (m): m is Extract<Move, { kind: "leap" }> => m.kind === "leap" && m.path.length > 1
    );
    if (!chained.length) return; // this roll had no chain available

    const target = chained[0];
    let sel = click(s, NO_SELECTION, s.pieces.find((p) => p.id === target.piece)!.at!).selection;
    expect(sel.piece).toBe(target.piece);

    const first = click(s, sel, target.path[0]);
    sel = first.selection;
    // A chain is available, so the first landing must not auto-commit.
    expect(sel.path).toHaveLength(1);
    expect(first.move).toBe(null);

    const stopHere = confirmableMove(sel)!;
    expect(() => applyMove(s, stopHere)).not.toThrow();
  });

  it("commits immediately when the chain cannot continue", () => {
    const s = rollUntil("leap");
    const leaps = legalMoves(s).filter(
      (m): m is Extract<Move, { kind: "leap" }> => m.kind === "leap"
    );
    if (!leaps.length) return;

    // A landing with no legal extension is a dead end by definition.
    const deadEnd = leaps.find(
      (m) => !leaps.some((x) => x.piece === m.piece && x.path.length === m.path.length + 1)
    );
    if (!deadEnd || deadEnd.path.length !== 1) return;

    const sel = click(s, NO_SELECTION, s.pieces.find((p) => p.id === deadEnd.piece)!.at!).selection;
    const r = click(s, sel, deadEnd.path[0]);
    expect(r.move).not.toBe(null);
    expect(r.selection).toEqual(NO_SELECTION);
  });

  it("offers nothing to confirm with no chain under way", () => {
    expect(confirmableMove(NO_SELECTION)).toBe(null);
  });

  it("reports where the chain currently stands, so the board can show it", () => {
    const s = rollUntil("leap");
    const chained = legalMoves(s).filter(
      (m): m is Extract<Move, { kind: "leap" }> => m.kind === "leap" && m.path.length > 1
    );
    if (!chained.length) return;
    const target = chained[0];
    const start = s.pieces.find((p) => p.id === target.piece)!.at!;

    let sel = click(s, NO_SELECTION, start).selection;
    // Holding a piece is not a chain: it is still on its own cell.
    expect(pendingAt(sel)).toBe(null);

    sel = click(s, sel, target.path[0]).selection;
    expect(pendingAt(sel)).toEqual(target.path[0]);
    expect(eq(pendingAt(sel)!, start)).toBe(false);

    // And the cells offered next are the ones reachable from there.
    for (const h of highlightsFor(s, sel)) {
      expect(
        legalMoves(s).some(
          (m) =>
            m.kind === "leap" &&
            m.piece === target.piece &&
            m.path.length === 2 &&
            eq(m.path[0], target.path[0]) &&
            eq(m.path[1], h)
        )
      ).toBe(true);
    }
  });

  it("has no pending cell while rescuing — that piece is off the board", () => {
    expect(pendingAt({ piece: "p0-0", path: [{ r: 1, c: 1 }], rescuing: true })).toBe(null);
  });
});

describe("hotseat rescue", () => {
  it("is offered only when the ruleset enables it", () => {
    const s = rollUntil("move");
    expect(rescuablePieces(s)).toHaveLength(0); // official rules: no rescue
  });

  it("highlights start cells and produces a legal rescue", () => {
    // Rescue needs an enabled ruleset, a captured piece, and a free start
    // cell. Early on every start cell is still occupied by its own piece, so
    // the situation is built directly: capturing a piece is exactly what
    // frees the cell it came from.
    const rules = {
      ...OFFICIAL_RULES,
      rescue: { ...OFFICIAL_RULES.rescue, enabled: true, maxPerGame: null },
    };
    const rolled = applyMove(createGame(5, BOARD_4P, rules), { kind: "roll" });
    const victim = rolled.pieces.find((p) => p.owner === rolled.turn)!;
    const s: GameState = {
      ...rolled,
      pieces: rolled.pieces.map((p) =>
        p.id === victim.id ? { ...p, state: "captured" as const, at: null } : p
      ),
    };

    expect(rescuablePieces(s).includes(victim.id)).toBe(true);
    const sel = beginRescue(victim.id);
    const cells = highlightsFor(s, sel);
    expect(cells.length).toBeGreaterThan(0);

    const r = click(s, sel, cells[0]);
    expect(r.move!.kind).toBe("rescue");
    const after = applyMove(s, r.move!);
    expect(after.pieces.find((p) => p.id === victim.id)!.state).toBe("active");
  });
});

describe("turnStatus", () => {
  it("reports the roll gate and the rolled face as an abstract key", () => {
    const fresh = createGame(2, BOARD_4P, OFFICIAL_RULES);
    expect(turnStatus(fresh).faceKey).toBe(null);
    expect(turnStatus(fresh).canRoll).toBe(true);

    const rolled = applyMove(fresh, { kind: "roll" });
    const st = turnStatus(rolled);
    expect(st.canRoll).toBe(false);
    expect(st.canPass).toBe(true);
    expect(st.faceKey!.startsWith("action.")).toBe(true);
  });
});
