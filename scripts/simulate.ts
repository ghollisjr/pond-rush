// ============================================================================
// Balance harness. Plays many games per variant with two crude agents and
// reports whether anyone actually scores.
//
//   node --experimental-strip-types scripts/simulate.ts
//
// Use it when tuning a board. The number to watch is avgPiecesHome: if it sits
// near zero, the crossing is too long for the hazard's lethality and nobody
// ever banks a point. Both agents are deliberately simple — they exist to
// smoke out unplayable configurations, not to play well.
// ============================================================================

import {
  applyMove,
  createGame,
  homeCells,
  legalMoves,
  replay,
  scores,
  type GameState,
  type Move,
} from "../src/pond-engine.ts";
import { VariantRegistry, validate } from "../src/rules.ts";

const reg = new VariantRegistry();
const VARIANTS = ["standard-4p", "standard-2p", "triple-trouble", "hop-share", "stork-escape", "gap-jump", "house"];
const GAMES = Number(process.argv[2] ?? 200);

function chebyshev(a: { r: number; c: number }, b: { r: number; c: number }): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.c - b.c));
}

/** Picks uniformly at random among real actions. */
function randomAgent(s: GameState): Move {
  if (s.phase === "awaiting_roll") return { kind: "roll" };
  const opts = legalMoves(s).filter((m) => m.kind !== "pass" && m.kind !== "roll");
  if (opts.length === 0) return { kind: "pass" };
  return opts[Math.floor(Math.random() * opts.length)];
}

/** Heads for the nearest scoring cell; eats whatever is convenient. */
function greedyAgent(s: GameState): Move {
  if (s.phase === "awaiting_roll") return { kind: "roll" };
  const opts = legalMoves(s).filter((m) => m.kind !== "pass" && m.kind !== "roll");
  if (opts.length === 0) return { kind: "pass" };

  const goals = homeCells(s, s.turn);
  const piece = (id: string) => s.pieces.find((p) => p.id === id);

  const value = (m: Move): number => {
    if (m.kind === "hazard") return 1;
    if (m.kind === "rescue") return 0.5;
    const p = piece((m as { piece: string }).piece);
    if (!p?.at) return -99;
    const to = m.kind === "leap" ? m.path[m.path.length - 1] : (m as { to: { r: number; c: number } }).to;
    const gain =
      Math.min(...goals.map((g) => chebyshev(p.at!, g))) -
      Math.min(...goals.map((g) => chebyshev(to, g)));
    const settles = s.cells[to.r]?.[to.c]?.home;
    return (settles ? 50 + settles.points * 5 : 0) + gain * 2;
  };

  let best = opts[0];
  let bestValue = value(best);
  for (const m of opts.slice(1)) {
    const v = value(m);
    // Random tie-breaking, or the agent fixates on one target and skews results.
    if (v > bestValue || (v === bestValue && Math.random() < 0.5)) {
      best = m;
      bestValue = v;
    }
  }
  return best;
}

console.log("Validation\n----------");
for (const id of VARIANTS) {
  const { board, rules } = reg.resolve(id);
  const issues = validate(rules, board);
  const errors = issues.filter((i) => i.level === "error");
  console.log(`${id.padEnd(16)} errors=${errors.length} warnings=${issues.length - errors.length}`);
  for (const e of errors) console.log(`   ERROR  ${e.field}: ${e.message}`);
}

for (const [label, agent] of [["random", randomAgent], ["greedy", greedyAgent]] as const) {
  console.log(`\n${label} agents (${GAMES} games each)\n----------`);
  for (const id of VARIANTS) {
    const { board, rules } = reg.resolve(id);
    let turns = 0, home = 0, top = 0, finished = 0, broken = 0;

    for (let seed = 1; seed <= GAMES; seed++) {
      let s = createGame(seed, board, rules);
      const log: Move[] = [];
      let t = 0;
      while (s.phase !== "finished" && t < 6000) {
        const move = agent(s);
        log.push(move);
        s = applyMove(s, move);
        t++;
      }
      if (s.phase !== "finished") { broken++; continue; }

      // Determinism: the same seed and move log must rebuild the same game.
      const again = replay(seed, log, board, rules);
      if (JSON.stringify(again.pieces) !== JSON.stringify(s.pieces)) { broken++; continue; }

      finished++;
      turns += t;
      home += s.pieces.filter((p) => p.state === "home").length;
      top += Math.max(...Object.values(scores(s)));
    }

    const avg = (n: number) => (finished ? (n / finished).toFixed(1) : "—");
    console.log(
      `${id.padEnd(16)} finished=${finished} broken=${broken} ` +
        `avgTurns=${avg(turns)} avgPiecesHome=${avg(home)} avgTopScore=${avg(top)}`
    );
  }
}
