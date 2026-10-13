// ============================================================================
// ui/hotseat.ts
//
// The interaction state machine for local play: which piece is picked up,
// which cells that makes clickable, and what a click on a given cell means.
//
// Pure, and deliberately DOM-free — it takes a GameState and a Selection and
// returns a new Selection plus, when a click completes something, the Move to
// apply. It never calls applyMove itself and never mutates anything, so the
// same module drives a hot-seat board today and a networked client later,
// where the Move is sent to the server instead of applied locally.
//
// Every candidate move comes from `legalMoves`. This layer never decides what
// is legal; it only narrows the engine's list down to what the player has
// pointed at.
// ============================================================================

import {
  eq,
  homeCells,
  legalMoves,
  startCells,
  type Coord,
  type GameState,
  type Move,
  type PieceId,
  type PlayerId,
} from "../pond-engine.ts";

export interface Selection {
  /** Piece being moved, or the captured piece being brought back. */
  piece: PieceId | null;
  /** Leap chain built so far. Empty except mid-chain. */
  path: Coord[];
  /** Rescue is offered instead of the rolled action, so it's a mode. */
  rescuing: boolean;
}

export const NO_SELECTION: Selection = { piece: null, path: [], rescuing: false };

export interface Interaction {
  selection: Selection;
  /** Set when the click completed a move. The caller applies or sends it. */
  move: Move | null;
}

const stay = (selection: Selection): Interaction => ({ selection, move: null });

function prefixes(path: Coord[], prefix: Coord[]): boolean {
  return prefix.every((c, i) => path[i] && eq(path[i], c));
}

/** The piece standing on a cell, if any. */
function pieceAt(state: GameState, at: Coord) {
  return state.pieces.find((p) => p.at && p.state !== "captured" && eq(p.at, at));
}

// ---------------------------------------------------------------------------
// What the player may click
// ---------------------------------------------------------------------------

/** Pieces the current player could pick up right now. */
export function selectablePieces(state: GameState): PieceId[] {
  const ids = new Set<PieceId>();
  for (const m of legalMoves(state)) {
    if (m.kind === "move" || m.kind === "leap" || m.kind === "step") {
      ids.add(m.piece);
    }
  }
  return [...ids];
}

/** Captured pieces the current player could bring back. */
export function rescuablePieces(state: GameState): PieceId[] {
  const ids = new Set<PieceId>();
  for (const m of legalMoves(state)) if (m.kind === "rescue") ids.add(m.piece);
  return [...ids];
}

/**
 * Cells to light up. Purely a function of state and selection, which is what
 * lets the renderer stay ignorant of the rules — it just paints coordinates.
 */
export function highlightsFor(state: GameState, sel: Selection): Coord[] {
  if (state.phase !== "acting") return [];
  const moves = legalMoves(state);
  const out: Coord[] = [];

  if (sel.rescuing) {
    for (const m of moves) {
      if (m.kind === "rescue" && (!sel.piece || m.piece === sel.piece)) out.push(m.to);
    }
    return dedupe(out);
  }

  // The hazard face asks for a cell, not a piece — everything legal lights up
  // as soon as the face is rolled.
  const hazardCells = moves.filter((m) => m.kind === "hazard");
  if (hazardCells.length) return dedupe(hazardCells.map((m) => m.to));

  if (!sel.piece) return [];

  for (const m of moves) {
    if (m.kind === "move" && m.piece === sel.piece && !sel.path.length) out.push(m.to);
    if (m.kind === "step" && m.piece === sel.piece && !sel.path.length) out.push(m.to);
    if (
      m.kind === "leap" &&
      m.piece === sel.piece &&
      m.path.length === sel.path.length + 1 &&
      prefixes(m.path, sel.path)
    ) {
      out.push(m.path[m.path.length - 1]);
    }
  }
  return dedupe(out);
}

/**
 * Where the selected piece is standing right now. Mid-chain that is the last
 * landing, which only the selection knows — the engine state still has the
 * piece on its pre-leap cell until the chain is committed. The caller hands
 * this to the renderer so the board shows the chain where it actually is.
 */
export function pendingAt(sel: Selection): Coord | null {
  if (sel.rescuing || !sel.piece || !sel.path.length) return null;
  return sel.path[sel.path.length - 1];
}

/**
 * Quarter turns clockwise that put a player's home at the far side of the
 * board, so they see the table from their own seat — their pieces nearest
 * them, crossing away.
 *
 * Derived from the board rather than hardcoded per seat, so it is still right
 * for a variant that rearranges where people sit.
 */
export function viewpointFor(state: GameState, player: PlayerId): 0 | 1 | 2 | 3 {
  const from = centre(startCells(state, player));
  const to = centre(homeCells(state, player));
  if (!from || !to) return 0;

  const dr = to.r - from.r;
  const dc = to.c - from.c;
  // Whichever axis the crossing mostly runs along decides the turn.
  if (Math.abs(dr) >= Math.abs(dc)) return dr <= 0 ? 0 : 2;
  return dc < 0 ? 1 : 3;
}

function centre(cells: Coord[]): Coord | null {
  if (!cells.length) return null;
  const r = cells.reduce((t, c) => t + c.r, 0) / cells.length;
  const c = cells.reduce((t, x) => t + x.c, 0) / cells.length;
  return { r, c };
}

/**
 * Of the cells lit for a hazard placement, the ones holding your own pieces.
 *
 * Taking your own is legal — the rules say "any space occupied by a piece" —
 * and it is never forced, so it is nearly always a mistake rather than a
 * choice. The board marks them differently instead of hiding them, because
 * removing a legal move is a rules change and this layer does not make those.
 */
export function selfTargets(state: GameState): Coord[] {
  if (state.phase !== "acting") return [];
  const mine = new Set(
    state.pieces
      .filter((p) => p.owner === state.turn && p.at && p.state !== "captured")
      .map((p) => `${p.at!.r},${p.at!.c}`)
  );
  return legalMoves(state)
    .filter((m) => m.kind === "hazard" && mine.has(`${m.to.r},${m.to.c}`))
    .map((m) => (m as Extract<Move, { kind: "hazard" }>).to);
}

/**
 * A leap chain can be stopped at any landing cell, so once one is under way
 * the player needs a way to say "that's far enough".
 */
export function confirmableMove(sel: Selection): Move | null {
  if (!sel.piece || !sel.path.length) return null;
  return { kind: "leap", piece: sel.piece, path: sel.path };
}

// ---------------------------------------------------------------------------
// Clicks
// ---------------------------------------------------------------------------

/** Interpret a click on a board cell. */
export function click(state: GameState, sel: Selection, at: Coord): Interaction {
  if (state.phase !== "acting") return stay(sel);
  const moves = legalMoves(state);

  if (sel.rescuing) {
    const m = moves.find(
      (x) => x.kind === "rescue" && x.to && eq(x.to, at) && (!sel.piece || x.piece === sel.piece)
    );
    return m ? { selection: NO_SELECTION, move: m } : stay(sel);
  }

  const hazard = moves.find((m) => m.kind === "hazard" && eq(m.to, at));
  if (hazard) return { selection: NO_SELECTION, move: hazard };

  // Picking up a piece. Only offered before a chain starts: mid-chain the
  // cells under other pieces are the things being leapt over, not new picks.
  if (!sel.path.length) {
    const here = pieceAt(state, at);
    if (here && here.owner === state.turn) {
      const canAct = moves.some(
        (m) =>
          (m.kind === "move" || m.kind === "leap" || m.kind === "step") &&
          m.piece === here.id
      );
      if (!canAct) return stay(sel);
      // Clicking the piece already held puts it back down.
      if (sel.piece === here.id) return stay(NO_SELECTION);
      return stay({ piece: here.id, path: [], rescuing: false });
    }
  }

  if (!sel.piece) return stay(sel);

  // A plain move, or the decline-to-leap single step. Both end the choice.
  if (!sel.path.length) {
    const simple = moves.find(
      (m) =>
        (m.kind === "move" || m.kind === "step") &&
        m.piece === sel.piece &&
        eq(m.to, at)
    );
    if (simple) return { selection: NO_SELECTION, move: simple };
  }

  // Extending a leap chain.
  const hop = moves.find(
    (m) =>
      m.kind === "leap" &&
      m.piece === sel.piece &&
      m.path.length === sel.path.length + 1 &&
      prefixes(m.path, sel.path) &&
      eq(m.path[m.path.length - 1], at)
  );
  if (hop && hop.kind === "leap") {
    const extended: Selection = { ...sel, path: hop.path };
    // Nowhere further to jump, so there is nothing to confirm — just go.
    if (highlightsFor(state, extended).length === 0) {
      return { selection: NO_SELECTION, move: hop };
    }
    return stay(extended);
  }

  return stay(sel);
}

/** Pick up a captured piece from the sidebar, entering rescue mode. */
export function beginRescue(piece: PieceId): Selection {
  return { piece, path: [], rescuing: true };
}

// ---------------------------------------------------------------------------
// Status, for the HUD. Abstract keys only — the theme supplies the words.
// ---------------------------------------------------------------------------

export interface TurnStatus {
  player: number;
  phase: GameState["phase"];
  /** Theme string key for the rolled face, or null before the roll. */
  faceKey: string | null;
  spacesLeft: number;
  canRoll: boolean;
  canPass: boolean;
  winners: number[];
}

export function turnStatus(state: GameState): TurnStatus {
  const moves = legalMoves(state);
  const face = state.pending;
  return {
    player: state.turn,
    phase: state.phase,
    faceKey: face ? `action.${face.kind}` : null,
    spacesLeft: state.spacesLeft,
    canRoll: moves.some((m) => m.kind === "roll"),
    canPass: moves.some((m) => m.kind === "pass"),
    winners: state.winners,
  };
}

function dedupe(cs: Coord[]): Coord[] {
  const seen = new Set<string>();
  return cs.filter((c) => {
    const k = `${c.r},${c.c}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
