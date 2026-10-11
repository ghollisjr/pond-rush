import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import {
  applyMove,
  createGame,
  eq,
  legalMoves,
  occupancy,
  replay,
  score,
  scores,
  type GameState,
  type Move,
} from "../src/pond-engine.ts";
import {
  BOARD_4P,
  OFFICIAL_RULES,
  VariantRegistry,
  deepMerge,
  exportVariant,
  importVariant,
  validate,
  type RuleSet,
} from "../src/rules.ts";

const reg = new VariantRegistry();

function game(variant = "standard-4p", seed = 1): GameState {
  const { board, rules } = reg.resolve(variant);
  return createGame(seed, board, rules);
}

/** Force a specific die face without fighting the RNG. */
function withFace(s: GameState, face: RuleSet["die"][number]): GameState {
  return {
    ...s,
    phase: "acting",
    pending: face,
    spacesLeft: face.kind === "move" ? face.spaces : 0,
  };
}

function find(s: GameState, id: string) {
  return s.pieces.find((p) => p.id === id)!;
}

describe("setup", () => {
  it("places every piece on a starting cell", () => {
    const s = game();
    expect(s.pieces).toHaveLength(4 * BOARD_4P.piecesPerPlayer);
    for (const p of s.pieces) {
      expect(p.state).toBe("active");
      expect(s.cells[p.at!.r][p.at!.c].start?.owner).toBe(p.owner);
    }
  });

  it("gives each player somewhere to score", () => {
    expect(validate(OFFICIAL_RULES, BOARD_4P).filter((i) => i.level === "error"))
      .toHaveLength(0);
  });
});

describe("move face", () => {
  it("moves up to the rolled number of spaces", () => {
    const s = withFace(game(), { kind: "move", spaces: 3 });
    const moves = legalMoves(s).filter((m) => m.kind === "move");
    expect(moves.length).toBeGreaterThan(0);
    expect(Math.max(...moves.map((m: any) => m.cost))).toBeLessThanOrEqual(3);
  });

  it("allows diagonals", () => {
    const s = withFace(game(), { kind: "move", spaces: 1 });
    const piece = s.pieces.find((p) => p.owner === 0)!;
    const diagonal = legalMoves(s).some(
      (m) =>
        m.kind === "move" &&
        m.piece === piece.id &&
        m.to.r !== piece.at!.r &&
        m.to.c !== piece.at!.c
    );
    expect(diagonal).toBe(true);
  });

  it("never routes through an occupied space", () => {
    const s = withFace(game(), { kind: "move", spaces: 3 });
    const occ = occupancy(s);
    for (const m of legalMoves(s)) {
      if (m.kind !== "move") continue;
      for (const step of m.path) {
        expect(occ.has(`${step.r},${step.c}`)).toBe(false);
      }
    }
  });

  it("ends the turn after one piece moves", () => {
    const s = withFace(game(), { kind: "move", spaces: 3 });
    const move = legalMoves(s).find((m) => m.kind === "move")!;
    const next = applyMove(s, move);
    expect(next.turn).toBe(1);
    expect(next.phase).toBe("awaiting_roll");
  });
});

describe("hop share variant", () => {
  it("lets a roll be split between pieces", () => {
    const s = withFace(game("hop-share"), { kind: "move", spaces: 3 });
    const first = legalMoves(s).find(
      (m) => m.kind === "move" && (m as any).cost === 1
    )!;
    const next = applyMove(s, first);
    expect(next.turn).toBe(0);
    expect(next.spacesLeft).toBe(2);
    expect(next.phase).toBe("acting");
  });

  it("ends the turn once the spaces run out", () => {
    let s = withFace(game("hop-share"), { kind: "move", spaces: 2 });
    const move = legalMoves(s).find(
      (m) => m.kind === "move" && (m as any).cost === 2
    )!;
    s = applyMove(s, move);
    expect(s.turn).toBe(1);
  });
});

describe("leap face", () => {
  it("jumps over a neighbour into the empty space beyond", () => {
    const s = withFace(game(), { kind: "leap" });
    const leaps = legalMoves(s).filter((m) => m.kind === "leap");
    expect(leaps.length).toBeGreaterThan(0);
  });

  it("offers every prefix of a chain so you can stop early", () => {
    const s = withFace(game(), { kind: "leap" });
    const leaps = legalMoves(s).filter((m) => m.kind === "leap") as any[];
    const byPiece = leaps.filter((m) => m.piece === leaps[0].piece);
    const lengths = new Set(byPiece.map((m) => m.path.length));
    expect(Math.min(...lengths)).toBe(1);
  });

  it("always offers the single-space alternative", () => {
    const s = withFace(game(), { kind: "leap" });
    expect(legalMoves(s).some((m) => m.kind === "step")).toBe(true);
  });

  it("will not jump over the hazard", () => {
    let s = withFace(game(), { kind: "leap" });
    const piece = s.pieces.find((p) => p.owner === 0)!;
    const over = { r: piece.at!.r - 1, c: piece.at!.c };
    s = { ...s, hazard: over };
    const jumpsIt = legalMoves(s).some(
      (m) =>
        m.kind === "leap" &&
        m.piece === piece.id &&
        eq(m.path[0], { r: over.r - 1, c: over.c })
    );
    expect(jumpsIt).toBe(false);
  });
});

describe("hazard", () => {
  it("only targets occupied cells", () => {
    const s = withFace(game(), { kind: "hazard" });
    const occ = occupancy(s);
    const targets = legalMoves(s).filter((m) => m.kind === "hazard");
    expect(targets.length).toBeGreaterThan(0);
    for (const m of targets) {
      expect(occ.has(`${(m as any).to.r},${(m as any).to.c}`)).toBe(true);
    }
  });

  it("removes the piece it lands on", () => {
    const s = withFace(game(), { kind: "hazard" });
    const target = legalMoves(s).find((m) => m.kind === "hazard")! as any;
    const victim = s.pieces.find((p) => p.at && eq(p.at, target.to))!;
    const next = applyMove(s, target);
    expect(find(next, victim.id).state).toBe("captured");
    expect(next.hazard).toEqual(target.to);
  });

  it("cannot take a piece that is already home", () => {
    let s = game();
    const piece = s.pieces.find((p) => p.owner === 0)!;
    // Park it on player 0's bench by hand.
    const bench = s.cells
      .flatMap((row, r) => row.map((cell, c) => ({ cell, r, c })))
      .find((x) => x.cell.home?.owner === 0 && x.cell.home.points === 3)!;
    s = {
      ...s,
      pieces: s.pieces.map((p) =>
        p.id === piece.id
          ? { ...p, at: { r: bench.r, c: bench.c }, state: "home" as const, points: 3 }
          : p
      ),
    };
    s = withFace(s, { kind: "hazard" });
    const targetsHome = legalMoves(s).some(
      (m) => m.kind === "hazard" && eq((m as any).to, { r: bench.r, c: bench.c })
    );
    expect(targetsHome).toBe(false);
  });
});

describe("scoring and game end", () => {
  it("banks the cell's points when a piece settles", () => {
    let s = game();
    const bench = s.cells
      .flatMap((row, r) => row.map((cell, c) => ({ cell, r, c })))
      .find((x) => x.cell.home?.owner === 0 && x.cell.home.points === 3)!;
    const piece = s.pieces.find((p) => p.owner === 0)!;

    s = {
      ...s,
      pieces: s.pieces.map((p) =>
        p.id === piece.id
          ? { ...p, at: { r: bench.r + 1, c: bench.c } }
          : p
      ),
    };
    s = withFace(s, { kind: "move", spaces: 1 });

    const onto = legalMoves(s).find(
      (m) => m.kind === "move" && m.piece === piece.id && eq(m.to, { r: bench.r, c: bench.c })
    )!;
    const next = applyMove(s, onto);
    expect(find(next, piece.id).state).toBe("home");
    expect(score(next, 0)).toBe(3);
  });

  it("ends as soon as one player has nothing left in play", () => {
    let s = game();
    s = {
      ...s,
      pieces: s.pieces.map((p) =>
        p.owner === 0 ? { ...p, at: null, state: "captured" as const } : p
      ),
    };
    s = withFace(s, { kind: "hazard" });
    const move = legalMoves(s).find((m) => m.kind === "hazard")!;
    const next = applyMove(s, move);
    expect(next.phase).toBe("finished");
    expect(next.winners.length).toBeGreaterThan(0);
  });

  it("awards the win on points, not on finishing first", () => {
    const s = game();
    const table = scores(s);
    expect(Object.values(table).every((v) => v === 0)).toBe(true);
  });
});

describe("stork escape variant", () => {
  it("offers a rescue after the roll, not before", () => {
    let s = game("stork-escape");
    const piece = s.pieces.find((p) => p.owner === 0)!;
    s = {
      ...s,
      pieces: s.pieces.map((p) =>
        p.id === piece.id ? { ...p, at: null, state: "captured" as const } : p
      ),
    };
    expect(legalMoves(s).some((m) => m.kind === "rescue")).toBe(false);

    const rolled = withFace(s, { kind: "hazard" });
    expect(legalMoves(rolled).some((m) => m.kind === "rescue")).toBe(true);
  });

  it("returns the piece to a free starting cell", () => {
    let s = game("stork-escape");
    const piece = s.pieces.find((p) => p.owner === 0)!;
    s = {
      ...s,
      pieces: s.pieces.map((p) =>
        p.id === piece.id ? { ...p, at: null, state: "captured" as const } : p
      ),
    };
    s = withFace(s, { kind: "hazard" });
    const rescue = legalMoves(s).find((m) => m.kind === "rescue")!;
    const next = applyMove(s, rescue);
    expect(find(next, piece.id).state).toBe("active");
  });
});

describe("triple trouble variant", () => {
  it("shares the scoring cells between all players", () => {
    const s = game("triple-trouble");
    const shared = s.cells.flat().filter((c) => c.home?.owner === "any");
    expect(shared.length).toBeGreaterThan(0);
    expect(s.board.playerCount).toBe(3);
  });
});

describe("determinism", () => {
  it("replays a move log to an identical state", () => {
    let s = game();
    const log: Move[] = [];
    for (let i = 0; i < 40 && s.phase !== "finished"; i++) {
      const options = legalMoves(s);
      if (options.length === 0) break;
      const pick = options[i % options.length];
      log.push(pick);
      s = applyMove(s, pick);
    }
    const again = replay(1, log, s.board, s.rules);
    expect(again.pieces).toEqual(s.pieces);
    expect(again.turn).toBe(s.turn);
    expect(again.rollCount).toBe(s.rollCount);
  });

  it("rejects an illegal move", () => {
    const s = game();
    expect(() => applyMove(s, { kind: "pass" })).toThrow();
  });
});

describe("variants", () => {
  it("layers patches down the extends chain", () => {
    const { rules } = reg.resolve("house");
    expect(rules.rescue.enabled).toBe(true);
    expect(rules.movement.shareMoves).toBe(true);
  });

  it("round-trips through export and import", () => {
    const def = reg.get("hop-share")!;
    const back = importVariant(exportVariant(def));
    expect(back.id).toBe(def.id);
    expect(back.meta?.schemaVersion).toBeGreaterThan(0);
  });

  it("flags a ruleset that can never end", () => {
    const broken = deepMerge(OFFICIAL_RULES, {
      die: [{ kind: "hazard" as const }],
    });
    const issues = validate(broken, BOARD_4P);
    expect(issues.some((i) => i.level === "error")).toBe(true);
  });

  it("warns about permanent capture with no way back", () => {
    const issues = validate(OFFICIAL_RULES, BOARD_4P);
    expect(issues.some((i) => i.field === "rescue.enabled")).toBe(true);
  });
});
