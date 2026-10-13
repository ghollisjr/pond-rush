// ============================================================================
// room.ts
//
// What a server knows about a game in progress. Pure: no HTTP, no storage, no
// clock — those belong to whatever is hosting it, and keeping them out is what
// makes the rules of a shared game testable under plain node.
//
// The server's whole job is to be the one copy of the move log that everybody
// agrees on, and to refuse anything `applyMove` would refuse. It stores a
// seed, a variant id, and a list of move indices — the same encoding a link
// uses, because it is the same problem.
//
// Two properties do the heavy lifting:
//
//   Clients never roll. Faces come from `rollAt(seed, rollCount)`, so a client
//   cannot manufacture a good roll; it can only ask to take one of the moves
//   the current state already allows.
//
//   A move is an index. The only thing a client sends is "the nth legal
//   option", so a malicious client cannot describe an illegal move — it can
//   only name one that does not exist, which is rejected by counting.
//
// Reconnect is not a special case: a client asks for everything after move N
// and replays it. That is the same mechanism as Undo.
// ============================================================================

import {
  applyMove,
  createGame,
  legalMoves,
  type GameState,
  type PlayerId,
} from "./pond-engine.ts";
import { VariantRegistry, type BoardSpec, type RuleSet } from "./rules.ts";

export interface Player {
  /** Secret the client proves itself with. Never sent to anyone else. */
  token: string;
  /** Seat at the table. The engine's PlayerId. */
  seat: PlayerId;
  name: string;
}

export interface Room {
  id: string;
  variantId: string;
  seed: number;
  /** The agreed move log, as indices into `legalMoves`. */
  moves: number[];
  players: Player[];
  /** Set by the host, not by this module — it has no clock. */
  createdAt: number;
  updatedAt: number;
}

/** What a client is told. Deliberately excludes every player's token. */
export interface RoomView {
  id: string;
  variantId: string;
  seed: number;
  moves: number[];
  players: { seat: PlayerId; name: string }[];
  /** Whose turn it is, or null once the game is over. */
  turn: PlayerId | null;
  finished: boolean;
  /** Seats with nobody in them yet. */
  openSeats: PlayerId[];
}

export class RoomError extends Error {
  /** HTTP-ish, so the host layer does not have to guess. */
  readonly status: number;

  // Written out rather than declared as a constructor parameter property:
  // `--experimental-strip-types` erases types without rewriting code, and a
  // parameter property is code. Everything here must survive type-stripping.
  constructor(message: string, status: number) {
    super(message);
    this.name = "RoomError";
    this.status = status;
  }
}

const registry = new VariantRegistry();

function config(variantId: string): { board: BoardSpec; rules: RuleSet } {
  try {
    const { board, rules } = registry.resolve(variantId);
    return { board, rules };
  } catch {
    throw new RoomError(`Unknown variant "${variantId}".`, 400);
  }
}

/** Rebuild the live state from the log. The server keeps no state but this. */
export function stateOf(room: Room): GameState {
  const { board, rules } = config(room.variantId);
  let s = createGame(room.seed, board, rules);
  for (const i of room.moves) {
    const options = legalMoves(s);
    const move = options[i];
    // Only reachable if the stored log was corrupted, since every move was
    // validated on the way in.
    if (!move) throw new RoomError("This room's move log is corrupt.", 500);
    s = applyMove(s, move);
  }
  return s;
}

export function seatCount(room: Room): number {
  return config(room.variantId).board.playerCount;
}

export function viewOf(room: Room): RoomView {
  const state = stateOf(room);
  const taken = new Set(room.players.map((p) => p.seat));
  const seats = Array.from({ length: seatCount(room) }, (_x, i) => i);
  return {
    id: room.id,
    variantId: room.variantId,
    seed: room.seed,
    moves: room.moves,
    players: room.players
      .map((p) => ({ seat: p.seat, name: p.name }))
      .sort((a, b) => a.seat - b.seat),
    turn: state.phase === "finished" ? null : state.turn,
    finished: state.phase === "finished",
    openSeats: seats.filter((s) => !taken.has(s)),
  };
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

export interface NewRoom {
  id: string;
  variantId: string;
  seed: number;
  now: number;
}

export function createRoom(spec: NewRoom): Room {
  config(spec.variantId); // reject an unknown variant at creation, not later
  if (!Number.isInteger(spec.seed)) {
    throw new RoomError("Seed must be a whole number.", 400);
  }
  return {
    id: spec.id,
    variantId: spec.variantId,
    seed: spec.seed,
    moves: [],
    players: [],
    createdAt: spec.now,
    updatedAt: spec.now,
  };
}

/**
 * Sit down at a free seat. Returns the room and the new player, whose token
 * the caller must hand to exactly one client and nobody else.
 */
export function join(
  room: Room,
  name: string,
  token: string,
  seat?: PlayerId
): { room: Room; player: Player } {
  const open = viewOf(room).openSeats;
  if (open.length === 0) throw new RoomError("This game is full.", 409);

  const chosen = seat ?? open[0];
  if (!open.includes(chosen)) {
    throw new RoomError(`Seat ${chosen + 1} is taken.`, 409);
  }

  // Two players sharing a token would both resolve to whichever sat down
  // first, so the second could move on the first's turn. Real tokens are 24
  // random bytes and will never collide; a bug in whatever generates them
  // should surface here rather than as a mysterious turn order.
  if (room.players.some((p) => p.token === token)) {
    throw new RoomError("Token collision while joining.", 500);
  }

  const trimmed = name.trim().slice(0, 24) || `Player ${chosen + 1}`;
  const player: Player = { token, seat: chosen, name: trimmed };
  return { room: { ...room, players: [...room.players, player] }, player };
}

/**
 * Play one move, named by its index in the current `legalMoves`.
 *
 * `expectedMoveCount` is the client saying which position it believes it is
 * looking at. Without it, two clients acting on a stale board could both
 * submit a move that is legal *there* and have the second land somewhere it
 * was never meant to. Compare-and-swap, not trust.
 */
export function play(
  room: Room,
  token: string,
  moveIndex: number,
  expectedMoveCount: number,
  now: number
): Room {
  const player = room.players.find((p) => p.token === token);
  if (!player) throw new RoomError("You are not in this game.", 403);

  if (expectedMoveCount !== room.moves.length) {
    throw new RoomError(
      `The game moved on — you are ${room.moves.length - expectedMoveCount} ` +
        `move(s) behind. Fetch and try again.`,
      409
    );
  }

  const state = stateOf(room);
  if (state.phase === "finished") throw new RoomError("This game is over.", 409);
  if (state.turn !== player.seat) {
    throw new RoomError("It is not your turn.", 409);
  }

  const options = legalMoves(state);
  if (!Number.isInteger(moveIndex) || moveIndex < 0 || moveIndex >= options.length) {
    throw new RoomError(
      `Move ${moveIndex} does not exist here (${options.length} available).`,
      400
    );
  }

  // Validated by construction: the move came out of legalMoves. applyMove
  // re-checks anyway, because the server trusting itself is how servers break.
  const next = applyMove(state, options[moveIndex]);
  void next;

  return { ...room, moves: [...room.moves, moveIndex], updatedAt: now };
}

/** Moves the client has not seen. The whole of catching up. */
export function movesSince(room: Room, since: number): number[] {
  const from = Math.max(0, Math.min(since, room.moves.length));
  return room.moves.slice(from);
}
