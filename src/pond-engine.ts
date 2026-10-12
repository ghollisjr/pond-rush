// ============================================================================
// pond-engine.ts
//
// Pure rules engine. No rendering, no theme strings, no DOM, no network.
// Nothing in here knows what a frog is.
//
// Turn structure follows the printed die: you roll, and the face determines
// the action you take.
//
//   move face   — move one piece up to N empty spaces, any direction
//                 including diagonals, never through an occupied space
//   leap face   — jump one piece over a neighbouring piece into an empty
//                 space, chaining as far as you like; or decline and move
//                 one piece a single space
//   hazard face — place the hazard on any occupied cell, removing that piece
//
// Scoring cells sit on the board. A piece that reaches one is home: safe,
// immovable, and worth that cell's points. The game ends the moment any one
// player has no pieces left in play, and the highest score wins.
//
// All behaviour is driven by the RuleSet, so variants need no changes here.
// ============================================================================

import {
  type BoardSpec,
  type CellDef,
  type Coord,
  type DieFace,
  type RuleSet,
  gridRows,
  resolveToken,
} from "./rules.ts";

export type { BoardSpec, Coord, RuleSet };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlayerId = number;
export type PieceId = string;

export interface Vec {
  dr: number;
  dc: number;
}

export type PieceState = "active" | "home" | "captured";

export interface Piece {
  id: PieceId;
  owner: PlayerId;
  at: Coord | null;
  state: PieceState;
  /** Points banked, set when the piece settles on a scoring cell. */
  points: number;
}

export type Phase = "awaiting_roll" | "acting" | "finished";

export interface GameState {
  board: BoardSpec;
  rules: RuleSet;
  /** Flattened board, indexed [r][c]. Derived once at creation. */
  cells: CellDef[][];

  pieces: Piece[];
  hazard: Coord | null;

  turn: PlayerId;
  phase: Phase;
  pending: DieFace | null;
  /** Spaces left to spend this turn (move faces only). */
  spacesLeft: number;

  rescuesUsed: Record<PlayerId, number>;

  seed: number;
  rollCount: number;

  winners: PlayerId[];
  history: Move[];
}

export type Move =
  | { kind: "roll" }
  | { kind: "move"; piece: PieceId; to: Coord; path: Coord[]; cost: number }
  | { kind: "leap"; piece: PieceId; path: Coord[] }
  | { kind: "step"; piece: PieceId; to: Coord }
  | { kind: "hazard"; to: Coord }
  | { kind: "rescue"; piece: PieceId; to: Coord }
  | { kind: "pass" };

// ---------------------------------------------------------------------------
// Deterministic RNG — the server rolls, clients verify
// ---------------------------------------------------------------------------

function mulberry32(a: number): number {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function rollAt(seed: number, index: number, faces: number): number {
  return Math.floor(mulberry32(seed + index * 0x9e3779b9) * faces);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const DIRS8: Vec[] = [
  { dr: -1, dc: 0 },
  { dr: 1, dc: 0 },
  { dr: 0, dc: -1 },
  { dr: 0, dc: 1 },
  { dr: -1, dc: -1 },
  { dr: -1, dc: 1 },
  { dr: 1, dc: -1 },
  { dr: 1, dc: 1 },
];

const DIRS4 = DIRS8.slice(0, 4);

export function eq(a: Coord, b: Coord): boolean {
  return a.r === b.r && a.c === b.c;
}

function key(c: Coord): string {
  return `${c.r},${c.c}`;
}

function add(c: Coord, v: Vec, n = 1): Coord {
  return { r: c.r + v.dr * n, c: c.c + v.dc * n };
}

export function cellAt(state: GameState, c: Coord): CellDef | null {
  return state.cells[c.r]?.[c.c] ?? null;
}

export function onBoard(state: GameState, c: Coord): boolean {
  return !!cellAt(state, c)?.playable;
}

/** Is this cell a scoring cell for the given player? */
function homeFor(state: GameState, c: Coord, player: PlayerId): number | null {
  const home = cellAt(state, c)?.home;
  if (!home) return null;
  if (home.owner === "any" || home.owner === player) return home.points;
  return null;
}

export function occupancy(state: GameState): Map<string, Piece> {
  const m = new Map<string, Piece>();
  for (const p of state.pieces) {
    // Home pieces still sit on the board and still block the cell.
    if (p.at && p.state !== "captured") m.set(key(p.at), p);
  }
  return m;
}

function isFree(state: GameState, occ: Map<string, Piece>, c: Coord): boolean {
  if (!onBoard(state, c)) return false;
  if (occ.has(key(c))) return false;
  if (state.rules.hazard.blocksCell && state.hazard && eq(state.hazard, c)) {
    return false;
  }
  return true;
}

/** The direction a player travels, from their start cells toward their goal. */
function travelVec(state: GameState, player: PlayerId): Vec {
  const from = centroid(startCells(state, player));
  const to = centroid(homeCells(state, player));
  if (!from || !to) return { dr: 0, dc: 0 };
  const dr = to.r - from.r;
  const dc = to.c - from.c;
  const mag = Math.hypot(dr, dc) || 1;
  return { dr: dr / mag, dc: dc / mag };
}

function centroid(cells: Coord[]): Coord | null {
  if (cells.length === 0) return null;
  const r = cells.reduce((a, c) => a + c.r, 0) / cells.length;
  const c = cells.reduce((a, x) => a + x.c, 0) / cells.length;
  return { r, c };
}

function dirsFor(state: GameState, player: PlayerId, diagonals: boolean): Vec[] {
  const base = diagonals ? DIRS8 : DIRS4;
  const restrict = state.rules.movement.restrict;
  if (restrict === "none") return base;

  const fwd = travelVec(state, player);
  return base.filter((d) => {
    const dot = d.dr * fwd.dr + d.dc * fwd.dc;
    return restrict === "forward_only" ? dot > 0.01 : dot > -0.01;
  });
}

// ---------------------------------------------------------------------------
// Board queries
// ---------------------------------------------------------------------------

function buildCells(board: BoardSpec): CellDef[][] {
  return gridRows(board).map((row) =>
    row.map((token) => resolveToken(token, board.legend))
  );
}

export function startCells(state: GameState, player: PlayerId): Coord[] {
  const out: Coord[] = [];
  state.cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell.start?.owner === player) out.push({ r, c });
    })
  );
  return out;
}

export function homeCells(state: GameState, player: PlayerId): Coord[] {
  const out: Coord[] = [];
  state.cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell.home && (cell.home.owner === "any" || cell.home.owner === player)) {
        out.push({ r, c });
      }
    })
  );
  return out;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function createGame(
  seed: number,
  board: BoardSpec,
  rules: RuleSet
): GameState {
  const cells = buildCells(board);

  const state: GameState = {
    board,
    rules,
    cells,
    pieces: [],
    hazard: null,
    turn: 0,
    phase: "awaiting_roll",
    pending: null,
    spacesLeft: 0,
    rescuesUsed: {},
    seed,
    rollCount: 0,
    winners: [],
    history: [],
  };

  for (let player = 0; player < board.playerCount; player++) {
    state.rescuesUsed[player] = 0;
    const slots = startCells(state, player).slice(0, board.piecesPerPlayer);
    slots.forEach((cell, i) => {
      state.pieces.push({
        id: `p${player}-${i}`,
        owner: player,
        at: { ...cell },
        state: "active",
        points: 0,
      });
    });
  }

  return state;
}

// ---------------------------------------------------------------------------
// Legal moves
// ---------------------------------------------------------------------------

export function legalMoves(state: GameState): Move[] {
  if (state.phase === "finished") return [];
  if (state.phase === "awaiting_roll") return [{ kind: "roll" }];

  const face = state.pending!;
  let out: Move[];
  if (face.kind === "move") out = moveFaceMoves(state);
  else if (face.kind === "leap") out = leapFaceMoves(state);
  else out = hazardMoves(state);

  // Stork Escape is offered after the roll: take the action as normal, or
  // skip it to bring a piece back.
  out.push(...rescueMoves(state));

  out.push({ kind: "pass" });
  return out;
}

function myPieces(state: GameState): Piece[] {
  return state.pieces.filter(
    (p) => p.owner === state.turn && p.state === "active" && p.at
  );
}

/**
 * Move one piece up to `spacesLeft` empty cells. Paths can't pass through
 * anything, so a BFS over destinations is enough; the path is kept only so
 * the renderer can animate the hop sequence.
 */
function moveFaceMoves(state: GameState): Move[] {
  const occ = occupancy(state);
  const out: Move[] = [];
  const budget = state.spacesLeft;
  if (budget <= 0) return out;

  for (const piece of myPieces(state)) {
    const dirs = dirsFor(state, piece.owner, state.rules.movement.diagonals);
    const seen = new Set<string>([key(piece.at!)]);
    let frontier: Coord[][] = [[piece.at!]];

    for (let step = 1; step <= budget && frontier.length; step++) {
      const next: Coord[][] = [];
      for (const path of frontier) {
        const head = path[path.length - 1];
        for (const d of dirs) {
          const target = add(head, d);
          if (!isFree(state, occ, target)) continue;
          if (seen.has(key(target))) continue;

          seen.add(key(target));
          const nextPath = [...path, target];
          out.push({
            kind: "move",
            piece: piece.id,
            to: target,
            path: nextPath.slice(1),
            cost: step,
          });

          // A piece that reaches its own scoring cell settles there, so the
          // path can't continue through it.
          if (homeFor(state, target, piece.owner) === null) next.push(nextPath);
        }
      }
      frontier = next;
    }
  }
  return out;
}

function leapFaceMoves(state: GameState): Move[] {
  const occ = occupancy(state);
  const out: Move[] = [];

  for (const piece of myPieces(state)) {
    collectLeaps(state, occ, piece, piece.at!, [], new Set([key(piece.at!)]), out);
  }

  // "If none of your pieces can jump, or you choose not to jump, you may
  // instead move one piece one space." Always available, not a fallback.
  if (state.rules.leap.declineToStep) {
    for (const piece of myPieces(state)) {
      for (const d of dirsFor(state, piece.owner, state.rules.movement.diagonals)) {
        const target = add(piece.at!, d);
        if (isFree(state, occ, target)) {
          out.push({ kind: "step", piece: piece.id, to: target });
        }
      }
    }
  }

  return out;
}

function collectLeaps(
  state: GameState,
  occ: Map<string, Piece>,
  piece: Piece,
  from: Coord,
  path: Coord[],
  visited: Set<string>,
  out: Move[]
): void {
  for (const d of dirsFor(state, piece.owner, state.rules.leap.diagonals)) {
    const over = add(from, d);
    const land = add(from, d, 2);

    const hopped = occ.get(key(over));
    if (!hopped) {
      // Gap Jump: the cell being cleared may hold nothing. A leap spans
      // exactly two cells, so the gap is always one space across — which is
      // the whole of the rule. Off-board cells count as gaps too, so a board
      // drawn with a hole in it can be crossed rather than walling players in.
      if (!state.rules.leap.overGaps) continue;
    } else if (state.rules.leap.overOwnOnly && hopped.owner !== piece.owner) {
      continue;
    }
    if (state.hazard && eq(state.hazard, over) && !state.rules.leap.canLeapHazard) {
      continue;
    }
    if (!isFree(state, occ, land)) continue;
    if (visited.has(key(land))) continue;

    const nextPath = [...path, land];
    // Every prefix is legal on its own, so nobody gets force-marched.
    out.push({ kind: "leap", piece: piece.id, path: nextPath });

    // Settling on a scoring cell ends the chain.
    if (homeFor(state, land, piece.owner) !== null) continue;

    if (state.rules.leap.chaining) {
      visited.add(key(land));
      collectLeaps(state, occ, piece, land, nextPath, visited, out);
      visited.delete(key(land));
    }
  }
}

function hazardMoves(state: GameState): Move[] {
  const h = state.rules.hazard;
  if (!h.enabled) return [];

  const out: Move[] = [];
  const occ = occupancy(state);

  state.cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (!cell.playable) return;
      const to = { r, c };
      if (state.hazard && eq(state.hazard, to)) return;

      const victim = occ.get(key(to));
      if (h.placement === "any_occupied" && !victim) return;
      // "You may not eat a piece that is already home."
      if (victim && h.homeIsSafe && victim.state === "home") return;

      if (h.placement === "within_range" && state.hazard) {
        const dist =
          Math.abs(state.hazard.r - r) + Math.abs(state.hazard.c - c);
        if (dist > h.range) return;
      }
      out.push({ kind: "hazard", to });
    })
  );

  return out;
}

/** Stork Escape: skip the rolled action to return one captured piece. */
function rescueMoves(state: GameState): Move[] {
  const r = state.rules.rescue;
  if (!r.enabled) return [];
  if (r.maxPerGame !== null && state.rescuesUsed[state.turn] >= r.maxPerGame) {
    return [];
  }

  const dead = state.pieces.filter(
    (p) => p.owner === state.turn && p.state === "captured"
  );
  if (dead.length === 0) return [];

  const occ = occupancy(state);
  const free = startCells(state, state.turn).filter((c) => isFree(state, occ, c));
  if (free.length === 0) return [];

  return dead.flatMap((piece) =>
    free.map((to) => ({ kind: "rescue" as const, piece: piece.id, to }))
  );
}

// ---------------------------------------------------------------------------
// Applying moves
// ---------------------------------------------------------------------------

export function isLegal(state: GameState, move: Move): boolean {
  return legalMoves(state).some((m) => sameMove(m, move));
}

function pathEq(a: Coord[], b: Coord[]): boolean {
  return a.length === b.length && a.every((c, i) => eq(c, b[i]));
}

function sameMove(a: Move, b: Move): boolean {
  if (a.kind !== b.kind) return false;
  const x = b as any;
  switch (a.kind) {
    case "move":
      return a.piece === x.piece && eq(a.to, x.to);
    case "leap":
      return a.piece === x.piece && pathEq(a.path, x.path);
    case "step":
      return a.piece === x.piece && eq(a.to, x.to);
    case "hazard":
      return eq(a.to, x.to);
    case "rescue":
      return a.piece === x.piece && eq(a.to, x.to);
    default:
      return true;
  }
}

function clone(state: GameState): GameState {
  return {
    ...state,
    pieces: state.pieces.map((p) => ({ ...p, at: p.at ? { ...p.at } : null })),
    hazard: state.hazard ? { ...state.hazard } : null,
    rescuesUsed: { ...state.rescuesUsed },
    history: [...state.history],
  };
}

/** Throws on an illegal move. The server calls this; clients never decide. */
export function applyMove(state: GameState, move: Move): GameState {
  if (!isLegal(state, move)) {
    throw new Error(`Illegal move: ${JSON.stringify(move)}`);
  }

  const s = clone(state);
  s.history.push(move);
  const find = (id: PieceId) => s.pieces.find((p) => p.id === id)!;

  switch (move.kind) {
    case "roll": {
      const face = s.rules.die[rollAt(s.seed, s.rollCount, s.rules.die.length)];
      s.rollCount++;
      s.pending = face;
      s.spacesLeft = face.kind === "move" ? face.spaces : 0;
      s.phase = "acting";
      return s;
    }

    case "move": {
      const p = find(move.piece);
      p.at = { ...move.to };
      settleIfHome(s, p);
      s.spacesLeft -= move.cost;

      // Without Hop Share you move a single piece and your turn is done.
      if (!s.rules.movement.shareMoves) return endTurn(s);
      if (s.spacesLeft <= 0) return endTurn(s);
      // Nothing left to spend it on.
      if (moveFaceMoves(s).length === 0) return endTurn(s);
      return s;
    }

    case "leap":
    case "step": {
      const p = find(move.piece);
      p.at =
        move.kind === "leap"
          ? { ...move.path[move.path.length - 1] }
          : { ...move.to };
      settleIfHome(s, p);
      return endTurn(s);
    }

    case "hazard": {
      s.hazard = { ...move.to };
      const victim = s.pieces.find(
        (p) => p.state === "active" && p.at && eq(p.at, move.to)
      );
      if (victim) {
        if (s.rules.hazard.effect === "capture") {
          victim.at = null;
          victim.state = "captured";
        } else {
          victim.at = null;
          const occ = occupancy(s);
          const free = startCells(s, victim.owner).find((c) => isFree(s, occ, c));
          if (free) victim.at = { ...free };
          else victim.state = "captured";
        }
      }
      return endTurn(s);
    }

    case "rescue": {
      const p = find(move.piece);
      p.state = "active";
      p.at = { ...move.to };
      s.rescuesUsed[s.turn] = (s.rescuesUsed[s.turn] ?? 0) + 1;
      return endTurn(s);
    }

    case "pass":
      return endTurn(s);
  }
}

/** A piece that lands on one of its scoring cells is home for good. */
function settleIfHome(s: GameState, p: Piece): void {
  if (!p.at) return;
  const points = homeFor(s, p.at, p.owner);
  if (points === null) return;
  p.state = "home";
  p.points = points;
}

function endTurn(s: GameState): GameState {
  const winners = checkVictory(s);
  if (winners) {
    s.winners = winners;
    s.phase = "finished";
    s.pending = null;
    s.spacesLeft = 0;
    return s;
  }
  s.turn = (s.turn + 1) % s.board.playerCount;
  s.phase = "awaiting_roll";
  s.pending = null;
  s.spacesLeft = 0;
  return s;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function score(s: GameState, player: PlayerId): number {
  return s.pieces
    .filter((p) => p.owner === player && p.state === "home")
    .reduce((total, p) => total + p.points, 0);
}

export function scores(s: GameState): Record<PlayerId, number> {
  const out: Record<PlayerId, number> = {};
  for (let p = 0; p < s.board.playerCount; p++) out[p] = score(s, p);
  return out;
}

/** A player is settled when nothing of theirs is left in play. */
function settled(s: GameState, player: PlayerId): boolean {
  return !s.pieces.some((p) => p.owner === player && p.state === "active");
}

function checkVictory(s: GameState): PlayerId[] | null {
  const players = Array.from({ length: s.board.playerCount }, (_x, i) => i);

  const over =
    s.rules.victory.endWhen === "any_player_settled"
      ? players.some((p) => settled(s, p))
      : players.every((p) => settled(s, p));
  if (!over) return null;

  const table = scores(s);
  const best = Math.max(...players.map((p) => table[p]));
  const tied = players.filter((p) => table[p] === best);
  return s.rules.victory.tiebreak === "shared" ? tied : [tied[0]];
}

// ---------------------------------------------------------------------------
// Replay — the whole multiplayer sync story
// ---------------------------------------------------------------------------

export function replay(
  seed: number,
  moves: Move[],
  board: BoardSpec,
  rules: RuleSet
): GameState {
  return moves.reduce(applyMove, createGame(seed, board, rules));
}

// ---------------------------------------------------------------------------
// Render hints — abstract keys only, resolved by the theme manifest
// ---------------------------------------------------------------------------

export interface BoardView {
  width: number;
  height: number;
  tiles: {
    at: Coord;
    tileKey: string;
    owner?: PlayerId | "any";
    points?: number;
  }[];
  pieces: {
    id: PieceId;
    at: Coord;
    spriteKey: string;
    settled: boolean;
    facing: Vec;
  }[];
  hazard: { at: Coord; spriteKey: string } | null;
}

export function view(state: GameState): BoardView {
  const tiles: BoardView["tiles"] = [];
  state.cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (!cell.playable) return;
      tiles.push({
        at: { r, c },
        tileKey: cell.tileKey,
        owner: cell.home?.owner ?? cell.start?.owner,
        points: cell.home?.points,
      });
    })
  );

  return {
    width: state.cells[0]?.length ?? 0,
    height: state.cells.length,
    tiles,
    pieces: state.pieces
      .filter((p) => p.at && p.state !== "captured")
      .map((p) => ({
        id: p.id,
        at: p.at!,
        spriteKey: `piece.player${p.owner}`,
        settled: p.state === "home",
        facing: travelVec(state, p.owner),
      })),
    hazard: state.hazard
      ? { at: state.hazard, spriteKey: "hazard.primary" }
      : null,
  };
}
