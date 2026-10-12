// ============================================================================
// session.ts
//
// Carrying a game between people and between visits, with no server.
//
// A game is entirely described by (variant, seed, moves) — the engine is pure
// and clients never roll, so replaying that triple rebuilds the exact state.
// And because `legalMoves` is a deterministic function of the state, a move
// can be written as its *index* in that list rather than its contents. A
// 112-move game is 255 characters that way, against 4677 as JSON, which is
// the difference between a link you can send and one you cannot.
//
// That is the whole trick. It gives asynchronous play-by-link on static
// hosting: take your turn, send the link, they take theirs.
//
// What it does not give is enforcement. Anyone can edit a link, and nothing
// here authenticates anybody — the game is as honest as the people playing
// it. For friends passing turns that is the right trade; the server in the
// roadmap is what replaces it when it is not. Note that the encoding is
// already the server's wire format, so that work is not thrown away.
//
// Pure and DOM-free. Storage is passed in rather than reached for, so the
// save/resume logic is testable under plain node.
// ============================================================================

import {
  applyMove,
  createGame,
  legalMoves,
  moveIndex,
  type GameState,
  type Move,
} from "./pond-engine.ts";
import type { BoardSpec, RuleSet } from "./rules.ts";

/** Everything needed to rebuild a game. */
export interface GameRef {
  variantId: string;
  seed: number;
  /** Each move as its index into `legalMoves` at the time it was played. */
  moves: number[];
}

/** The `v1.` prefix is so a future format change can be told apart. */
const FORMAT = "v1";

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Rebuild a state from indices. Throws on an index that is not a legal move,
 * which is the encoding validating itself: a corrupted link cannot produce a
 * wrong-but-plausible game, only a rejected one.
 */
export function replayIndices(
  ref: GameRef,
  board: BoardSpec,
  rules: RuleSet
): GameState {
  let s = createGame(ref.seed, board, rules);
  ref.moves.forEach((i, n) => {
    const options = legalMoves(s);
    const move = options[i];
    if (!move) {
      throw new Error(
        `Move ${n + 1} of the link is not playable (index ${i} of ${options.length}).`
      );
    }
    s = applyMove(s, move);
  });
  return s;
}

/** Turn a played game's move log back into indices, by replaying it. */
export function toIndices(
  seed: number,
  log: Move[],
  board: BoardSpec,
  rules: RuleSet
): number[] {
  let s = createGame(seed, board, rules);
  const out: number[] = [];
  for (const move of log) {
    const i = moveIndex(s, move);
    if (i < 0) throw new Error(`Move log contains an illegal move: ${move.kind}`);
    out.push(i);
    s = applyMove(s, move);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Encoding
//
// Indices are small but not bounded — a Gap Jump leap face can offer a few
// hundred — so they are varint-encoded rather than assumed to fit a byte, and
// the bytes are base64url'd so the result survives being a URL fragment.
// ---------------------------------------------------------------------------

function toVarints(ns: number[]): number[] {
  const bytes: number[] = [];
  for (const n of ns) {
    if (!Number.isInteger(n) || n < 0) throw new Error(`Bad move index: ${n}`);
    let v = n;
    while (v >= 0x80) {
      bytes.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(v);
  }
  return bytes;
}

function fromVarints(bytes: number[]): number[] {
  const out: number[] = [];
  let v = 0;
  let shift = 0;
  for (const b of bytes) {
    v |= (b & 0x7f) << shift;
    if (b & 0x80) {
      shift += 7;
    } else {
      out.push(v);
      v = 0;
      shift = 0;
    }
  }
  if (shift !== 0) throw new Error("Truncated move list.");
  return out;
}

function base64url(bytes: number[]): string {
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unbase64url(s: string): number[] {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return [...bin].map((c) => c.charCodeAt(0));
}

/** `v1.<variant>.<seed>.<moves>` — safe in a URL fragment as-is. */
export function encodeGame(ref: GameRef): string {
  if (ref.variantId.includes(".")) {
    throw new Error(`Variant id cannot contain a dot: ${ref.variantId}`);
  }
  return [FORMAT, ref.variantId, ref.seed, base64url(toVarints(ref.moves))].join(".");
}

export function decodeGame(text: string): GameRef {
  const parts = text.trim().split(".");
  if (parts.length !== 4) throw new Error("That does not look like a game link.");
  const [format, variantId, seed, moves] = parts;
  if (format !== FORMAT) throw new Error(`Unknown link format "${format}".`);
  if (!variantId) throw new Error("Link names no variant.");
  const n = Number(seed);
  if (!Number.isInteger(n)) throw new Error(`Link has a bad seed "${seed}".`);
  return { variantId, seed: n, moves: moves ? fromVarints(unbase64url(moves)) : [] };
}

// ---------------------------------------------------------------------------
// Saved games
//
// Storage is passed in, so this is testable without a browser and so a caller
// can decide where games live.
// ---------------------------------------------------------------------------

export interface SavedGame extends GameRef {
  /** Stable id so a game can be updated in place rather than duplicated. */
  id: string;
  /** Epoch millis. Supplied by the caller — this module has no clock. */
  updatedAt: number;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORE_KEY = "pond-rush/games";
const MAX_SAVED = 20;

export function loadSaved(store: KeyValueStore): SavedGame[] {
  try {
    const raw = store.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedGame[]) : [];
  } catch {
    // A corrupted store must not take the page down with it.
    return [];
  }
}

/** Upsert by id, newest first, oldest beyond the cap dropped. */
export function saveGame(
  store: KeyValueStore,
  game: SavedGame
): SavedGame[] {
  const rest = loadSaved(store).filter((g) => g.id !== game.id);
  const next = [game, ...rest]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SAVED);
  try {
    store.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    // Private browsing, or a full quota. Losing the save is survivable;
    // throwing in the middle of a move is not.
  }
  return next;
}
