import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { explainNow, rulesSheet, tutorial } from "../src/ui/help.ts";
import { NO_SELECTION, beginRescue, click, selectablePieces } from "../src/ui/hotseat.ts";
import { applyMove, createGame, type GameState } from "../src/pond-engine.ts";
import { BOARD_4P, OFFICIAL_RULES, VariantRegistry } from "../src/rules.ts";
import { Theme, type LoadedTheme } from "../src/theme.ts";
import { PLAIN_THEME } from "../src/ui/default-theme.ts";

const plain = new Theme(PLAIN_THEME);

/** A pack with its own vocabulary, to prove nothing is hard-coded. */
const flavoured = new Theme(
  {
    id: "f",
    name: "F",
    tileSize: 64,
    root: "",
    sprites: {},
    strings: {
      "piece.singular": "newt",
      "piece.plural": "newts",
      "hazard.primary": "badger",
      "action.move": "Scurry",
      "action.leap": "Vault",
      "action.hazard": "Badger",
      "zone.home": "burrow",
      "zone.bench": "log",
    },
    palette: {},
  } as LoadedTheme,
  PLAIN_THEME
);

function rollUntil(kind: "move" | "leap" | "hazard"): GameState {
  for (let seed = 1; seed < 400; seed++) {
    let s = createGame(seed, BOARD_4P, OFFICIAL_RULES);
    for (let t = 0; t < 12; t++) {
      s = applyMove(s, { kind: "roll" });
      if (s.pending?.kind === kind) return s;
      s = applyMove(s, { kind: "pass" });
    }
  }
  throw new Error(`never rolled ${kind}`);
}

const allText = (o: { headline: string; detail: string; options: { label: string; text: string }[] }) =>
  [o.headline, o.detail, ...o.options.flatMap((x) => [x.label, x.text])].join(" ");

describe("explainNow", () => {
  it("tells a new player to roll before anything else", () => {
    const s = createGame(1, BOARD_4P, OFFICIAL_RULES);
    const now = explainNow(s, NO_SELECTION, plain);
    expect(now.headline).toBe("Player 1's turn");
    expect(now.options).toHaveLength(1);
    expect(now.options[0].label).toBe("Roll");
  });

  it("names the rolled action and how far it reaches", () => {
    const s = rollUntil("move");
    const now = explainNow(s, NO_SELECTION, plain);
    expect(now.headline.includes(String(s.spacesLeft))).toBe(true);
    expect(allText(now).includes("Pick a piece")).toBe(true);
  });

  it("explains the hazard face without asking for a piece first", () => {
    const s = rollUntil("hazard");
    const now = explainNow(s, NO_SELECTION, plain);
    expect(now.options.some((o) => o.label.includes("hazard"))).toBe(true);
    // It is the one face where you never pick a piece of your own.
    expect(now.options.some((o) => o.label === "Pick a piece")).toBe(false);
  });

  it("switches advice once a piece is held", () => {
    const s = rollUntil("move");
    const id = selectablePieces(s)[0];
    const sel = click(s, NO_SELECTION, s.pieces.find((p) => p.id === id)!.at!).selection;
    const now = explainNow(s, sel, plain);
    expect(now.options.some((o) => o.label === "Pick a lit cell")).toBe(true);
    expect(now.options.some((o) => o.label.includes("again"))).toBe(true);
  });

  it("offers stopping only once a chain is under way", () => {
    const s = rollUntil("leap");
    const bare = explainNow(s, NO_SELECTION, plain);
    expect(bare.options.some((o) => o.label === "Stop here")).toBe(false);

    const sel = { piece: selectablePieces(s)[0], path: [{ r: 5, c: 0 }], rescuing: false };
    const mid = explainNow(s, sel, plain);
    expect(mid.options.some((o) => o.label === "Stop here")).toBe(true);
    expect(mid.options.some((o) => o.label === "Keep jumping")).toBe(true);
  });

  it("mentions Undo only when there is something to undo", () => {
    const fresh = createGame(1, BOARD_4P, OFFICIAL_RULES);
    expect(explainNow(fresh, NO_SELECTION, plain).options.some((o) => o.label === "Undo")).toBe(false);
    const rolled = applyMove(fresh, { kind: "roll" });
    expect(explainNow(rolled, NO_SELECTION, plain).options.some((o) => o.label === "Undo")).toBe(true);
  });

  it("explains rescue only when the ruleset enables it", () => {
    const s = rollUntil("move");
    expect(explainNow(s, NO_SELECTION, plain).options.some((o) => o.label === "Bring one back")).toBe(false);

    const rules = { ...OFFICIAL_RULES, rescue: { enabled: true, maxPerGame: null } };
    const rolled = applyMove(createGame(5, BOARD_4P, rules), { kind: "roll" });
    const victim = rolled.pieces.find((p) => p.owner === rolled.turn)!;
    const withDead: GameState = {
      ...rolled,
      pieces: rolled.pieces.map((p) =>
        p.id === victim.id ? { ...p, state: "captured" as const, at: null } : p
      ),
    };
    expect(explainNow(withDead, NO_SELECTION, plain).options.some((o) => o.label === "Bring one back")).toBe(true);
    const rescuing = explainNow(withDead, beginRescue(victim.id), plain);
    expect(rescuing.options[0].label.includes("Place")).toBe(true);
  });

  it("announces the winner when the game is over", () => {
    const s: GameState = {
      ...createGame(1, BOARD_4P, OFFICIAL_RULES),
      phase: "finished",
      winners: [2],
    };
    expect(explainNow(s, NO_SELECTION, plain).headline).toBe("Player 3 wins");
    const tied: GameState = { ...s, winners: [0, 1] };
    expect(explainNow(tied, NO_SELECTION, plain).headline.includes("tie")).toBe(true);
  });

  it("uses the theme's words, never its own", () => {
    const s = rollUntil("leap");
    const text = allText(explainNow(s, NO_SELECTION, flavoured));
    expect(text.includes("newt")).toBe(true);
    expect(text.includes("Vault")).toBe(true);
    // The fallback's generic nouns must not leak through when a pack covers them.
    expect(text.includes("piece")).toBe(false);
  });
});

describe("rulesSheet", () => {
  const s = createGame(1, BOARD_4P, OFFICIAL_RULES);

  it("counts the die this game is actually using", () => {
    const text = rulesSheet(s, plain).flatMap((x) => x.paras).join(" ");
    expect(text.includes("6 faces")).toBe(true);
    expect(text.includes("3 that move")).toBe(true);
  });

  it("lists the scoring cells worth the most first", () => {
    const goal = rulesSheet(s, plain)[0].paras.join(" ");
    expect(goal.includes("bench 3")).toBe(true);
    expect(goal.indexOf("bench 3") < goal.indexOf("shore 1")).toBe(true);
  });

  it("describes the variant in play, not the standard game", () => {
    const reg = new VariantRegistry();
    const share = reg.resolve("hop-share");
    const shared = createGame(1, share.board, share.rules);
    expect(rulesSheet(shared, plain).flatMap((x) => x.paras).join(" ").includes("Hop Share is on")).toBe(true);
    expect(rulesSheet(s, plain).flatMap((x) => x.paras).join(" ").includes("Hop Share is on")).toBe(false);

    const stork = reg.resolve("stork-escape");
    const storked = createGame(1, stork.board, stork.rules);
    expect(rulesSheet(storked, plain).some((x) => x.title === "Stork Escape")).toBe(true);
    expect(rulesSheet(s, plain).some((x) => x.title === "Stork Escape")).toBe(false);
  });

  it("renames itself under a flavoured pack", () => {
    expect(rulesSheet(s, flavoured).some((x) => x.title === "badger")).toBe(true);
    expect(rulesSheet(s, flavoured).some((x) => x.title === "hazard")).toBe(false);
  });
});

describe("tutorial", () => {
  it("walks the actual click sequence in order", () => {
    const steps = tutorial(plain);
    expect(steps.length).toBeGreaterThan(4);
    expect(steps[0].title.includes("Roll")).toBe(true);
    const all = steps.flatMap((x) => x.paras).join(" ");
    expect(all.includes("dashed")).toBe(true);
    expect(all.includes("Stop here")).toBe(true);
  });
});

describe("explainNow in a shared game", () => {
  // Roll then pass to reach the next player's turn: before the roll, `pass`
  // is not a legal move, and a describe body that throws silently fails to
  // register the whole block while the run still reports "fail 0".
  const start = createGame(2, BOARD_4P, OFFICIAL_RULES);
  const s = applyMove(applyMove(start, { kind: "roll" }), { kind: "pass" });
  const who = (seat: number) => ({
    seat,
    nameFor: (n: number) => ["Alice", "Bob", "Cara", "Dev"][n],
  });

  it("addresses the player whose turn it is as 'you'", () => {
    // Seat numbers are right when one person plays everybody, and wrong the
    // moment they do not: "Player 2's turn" reads as somebody else when you
    // are Player 2.
    expect(explainNow(s, NO_SELECTION, plain, who(s.turn)).headline).toBe("Your turn");
  });

  it("names the other player rather than numbering them", () => {
    const other = (s.turn + 1) % 4;
    expect(explainNow(s, NO_SELECTION, plain, who(other)).headline)
      .toBe(`${["Alice", "Bob", "Cara", "Dev"][s.turn]}'s turn`);
  });

  it("offers nothing to do while waiting for someone else", () => {
    const other = (s.turn + 1) % 4;
    const panel = explainNow(s, NO_SELECTION, plain, who(other));
    expect(panel.options).toHaveLength(0);
    expect(panel.detail.includes("updates on its own")).toBe(true);
  });

  it("still speaks in seat numbers with no perspective, for hot seat", () => {
    expect(explainNow(s, NO_SELECTION, plain).headline).toBe(`Player ${s.turn + 1}'s turn`);
    expect(explainNow(s, NO_SELECTION, plain).options).toHaveLength(1);
  });
})
