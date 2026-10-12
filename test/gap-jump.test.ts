import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import {
  applyMove,
  createGame,
  eq,
  legalMoves,
  occupancy,
  type GameState,
  type Move,
} from "../src/pond-engine.ts";
import { BOARD_4P, OFFICIAL_RULES, VariantRegistry } from "../src/rules.ts";
import { rulesSheet } from "../src/ui/help.ts";
import { Theme } from "../src/theme.ts";
import { PLAIN_THEME } from "../src/ui/default-theme.ts";

const GAP_RULES = {
  ...OFFICIAL_RULES,
  leap: { ...OFFICIAL_RULES.leap, overGaps: true },
};

/** First state whose rolled face is a leap, under the given ruleset. */
function leapState(rules: typeof OFFICIAL_RULES): GameState {
  for (let seed = 1; seed < 400; seed++) {
    let s = createGame(seed, BOARD_4P, rules);
    for (let t = 0; t < 12; t++) {
      s = applyMove(s, { kind: "roll" });
      if (s.pending?.kind === "leap") return s;
      s = applyMove(s, { kind: "pass" });
    }
  }
  throw new Error("no leap face");
}

const leaps = (s: GameState) =>
  legalMoves(s).filter((m): m is Extract<Move, { kind: "leap" }> => m.kind === "leap");

/** The cell a single-hop leap clears. */
function clearedCell(s: GameState, m: Extract<Move, { kind: "leap" }>) {
  const from = s.pieces.find((p) => p.id === m.piece)!.at!;
  const to = m.path[0];
  return { r: (from.r + to.r) / 2, c: (from.c + to.c) / 2 };
}

describe("Gap Jump", () => {
  it("is off in the standard game: every leap clears an occupied cell", () => {
    const s = leapState(OFFICIAL_RULES);
    const occ = occupancy(s);
    for (const m of leaps(s).filter((x) => x.path.length === 1)) {
      const over = clearedCell(s, m);
      expect(occ.has(`${over.r},${over.c}`)).toBe(true);
    }
  });

  it("lets a leap clear an empty cell when on", () => {
    const s = leapState(GAP_RULES);
    const occ = occupancy(s);
    const singles = leaps(s).filter((x) => x.path.length === 1);
    const overGap = singles.filter((m) => {
      const o = clearedCell(s, m);
      return !occ.has(`${o.r},${o.c}`);
    });
    expect(overGap.length).toBeGreaterThan(0);
    // And the engine accepts them, rather than merely listing them.
    expect(() => applyMove(s, overGap[0])).not.toThrow();
  });

  it("strictly adds moves — nothing legal before becomes illegal", () => {
    const plainState = leapState(OFFICIAL_RULES);
    const gapState: GameState = { ...plainState, rules: GAP_RULES };
    const before = leaps(plainState);
    const after = leaps(gapState);
    expect(after.length).toBeGreaterThan(before.length);
    for (const m of before) {
      expect(after.some((x) => x.piece === m.piece && eq(x.path[0], m.path[0]))).toBe(true);
    }
  });

  it("still refuses to clear the hazard", () => {
    const s = leapState(GAP_RULES);
    // Park the hazard on an empty cell that a gap jump would otherwise clear.
    const occ = occupancy(s);
    const singles = leaps(s).filter((x) => x.path.length === 1);
    const gapMove = singles.find((m) => {
      const o = clearedCell(s, m);
      return !occ.has(`${o.r},${o.c}`);
    })!;
    const blocked: GameState = { ...s, hazard: clearedCell(s, gapMove) };
    const still = leaps(blocked).some(
      (m) => m.piece === gapMove.piece && eq(m.path[0], gapMove.path[0])
    );
    expect(still).toBe(false);
  });

  it("is wired up as a variant", () => {
    const { rules } = new VariantRegistry().resolve("gap-jump");
    expect(rules.leap.overGaps).toBe(true);
    // And is not smuggled into the standard game.
    expect(new VariantRegistry().resolve("standard-4p").rules.leap.overGaps).toBe(false);
  });

  it("is described in the generated rules sheet only when on", () => {
    const theme = new Theme(PLAIN_THEME);
    const text = (rules: typeof OFFICIAL_RULES) =>
      rulesSheet(createGame(1, BOARD_4P, rules), theme)
        .flatMap((x) => x.paras)
        .join(" ");
    expect(text(GAP_RULES).includes("Gap Jump")).toBe(true);
    expect(text(OFFICIAL_RULES).includes("Gap Jump")).toBe(false);
    expect(text(OFFICIAL_RULES).includes("must hold a piece")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Chaining over gaps is unbounded, so it is not allowed. This guards the fix:
// without it the opening position offers 12,500 moves and the simulator runs
// out of memory by mid-game.
// ---------------------------------------------------------------------------

describe("Gap Jump chaining", () => {
  function midGame(rules: typeof OFFICIAL_RULES, turns: number): GameState {
    let s = createGame(3, BOARD_4P, rules);
    for (let t = 0; t < turns && s.phase !== "finished"; t++) {
      s = applyMove(s, { kind: "roll" });
      const opts = legalMoves(s).filter((m) => m.kind !== "roll" && m.kind !== "pass");
      s = applyMove(s, opts.length ? opts[Math.floor(opts.length / 2)] : { kind: "pass" });
    }
    return s;
  }

  it("keeps the move list in the same order of magnitude as the standard game", () => {
    for (const turns of [0, 10, 25, 40]) {
      const plain = legalMoves(midGame(OFFICIAL_RULES, turns)).length;
      const gap = legalMoves(midGame(GAP_RULES, turns)).length;
      // Generous, but it catches a combinatorial blow-up rather than growth.
      expect(gap).toBeLessThanOrEqual(Math.max(plain, 50) * 20);
    }
  });

  it("ends the chain at the hop that cleared a gap", () => {
    const s = leapState(GAP_RULES);
    const occupied = new Set(
      s.pieces.filter((p) => p.at && p.state !== "captured").map((p) => `${p.at!.r},${p.at!.c}`)
    );

    for (const m of leaps(s)) {
      const from = s.pieces.find((p) => p.id === m.piece)!.at!;
      const cells = [from, ...m.path];
      for (let i = 0; i + 1 < cells.length; i++) {
        const over = { r: (cells[i].r + cells[i + 1].r) / 2, c: (cells[i].c + cells[i + 1].c) / 2 };
        const clearedAPiece = occupied.has(`${over.r},${over.c}`);
        const isLastHop = i + 2 === cells.length;
        // A gap hop may only ever be the final hop of a chain.
        if (!clearedAPiece) expect(isLastHop).toBe(true);
      }
    }
  });
});
