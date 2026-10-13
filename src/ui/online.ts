// ============================================================================
// ui/online.ts
//
// The browser's half of the network conversation. A thin typed wrapper over
// the four endpoints in server-api.ts, and nothing else — no DOM, no game
// state, no polling loop. `fetch` is injected, so this is testable under node
// without a server.
//
// Note what is *not* here: any notion of whether a move is legal. The client
// asks the shared engine for `legalMoves`, sends the index of the one it
// wants, and the server asks the same engine the same question. The client's
// answer is a convenience for drawing the board; the server's is the truth.
// ============================================================================

import type { PlayerId } from "../pond-engine.ts";

/** Mirrors RoomView on the server. Tokens are deliberately absent. */
export interface RoomView {
  id: string;
  variantId: string;
  seed: number;
  moves: number[];
  players: { seat: PlayerId; name: string }[];
  turn: PlayerId | null;
  finished: boolean;
  openSeats: PlayerId[];
}

export interface Seat {
  /** This player's secret. Never shown, never sent anywhere but the server. */
  token: string;
  seat: PlayerId;
}

export class OnlineError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OnlineError";
    this.status = status;
  }
}

export type Fetcher = typeof fetch;

export class OnlineClient {
  private base: string;
  private fetcher: Fetcher;

  constructor(baseUrl: string, fetcher?: Fetcher) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.fetcher = fetcher ?? ((input, init) => globalThis.fetch(input, init));
  }

  get origin(): string {
    return this.base;
  }

  private async call<T>(
    path: string,
    init?: { method?: string; body?: unknown }
  ): Promise<T> {
    let res: Response;
    // Lifted out of `this` before calling. `this.fetcher(...)` would pass the
    // client as the receiver, and the browser's fetch refuses that outright
    // with "Illegal invocation" — while node, where these tests run, does not
    // mind at all. Every call here was broken in a browser and green in CI.
    const send = this.fetcher;
    try {
      res = await send(`${this.base}${path}`, {
        method: init?.method ?? "GET",
        headers: init?.body ? { "content-type": "application/json" } : undefined,
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });
    } catch (err) {
      // No response at all: offline, server asleep, DNS, CORS refusal.
      throw new OnlineError(
        `Can't reach the server. ${(err as Error).message}`,
        0
      );
    }

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // A non-JSON body from a proxy or an error page.
    }

    if (!res.ok) {
      const message =
        (parsed as { error?: string } | null)?.error ??
        `Server said ${res.status}.`;
      throw new OnlineError(message, res.status);
    }
    return parsed as T;
  }

  async health(): Promise<boolean> {
    try {
      const out = await this.call<{ ok: boolean }>("/api/health");
      return out?.ok === true;
    } catch {
      return false;
    }
  }

  async createRoom(variantId: string): Promise<RoomView> {
    // No seed is sent on purpose: the server picks it, so nobody can shop
    // for a seed whose rolls they like.
    const out = await this.call<{ room: RoomView }>("/api/rooms", {
      method: "POST",
      body: { variantId },
    });
    return out.room;
  }

  /**
   * Take a seat. Pass `token` if this client already holds one for the room
   * and the same seat comes back, rather than a second one — which is what
   * keeps a reload or a stray second tab from eating the table.
   */
  async join(
    roomId: string,
    name: string,
    seat?: PlayerId,
    token?: string
  ): Promise<{ seat: Seat; room: RoomView }> {
    const out = await this.call<{ token: string; seat: PlayerId; room: RoomView }>(
      `/api/rooms/${encodeURIComponent(roomId)}/join`,
      { method: "POST", body: { name, seat, token } }
    );
    return { seat: { token: out.token, seat: out.seat }, room: out.room };
  }

  /** The room, plus the moves this client has not applied yet. */
  async since(
    roomId: string,
    moveCount: number
  ): Promise<{ room: RoomView; moves: number[] }> {
    return this.call<{ room: RoomView; moves: number[] }>(
      `/api/rooms/${encodeURIComponent(roomId)}?since=${moveCount}`
    );
  }

  /**
   * Play a move. `expect` is this client's belief about how many moves have
   * been made; the server refuses if that is stale, which is what stops two
   * people acting on the same board and one of them landing somewhere they
   * never looked at.
   */
  async move(
    roomId: string,
    token: string,
    index: number,
    expect: number
  ): Promise<RoomView> {
    const out = await this.call<{ room: RoomView }>(
      `/api/rooms/${encodeURIComponent(roomId)}/move`,
      { method: "POST", body: { token, index, expect } }
    );
    return out.room;
  }
}

// ---------------------------------------------------------------------------
// Remembering a seat
//
// A token is the only proof of who you are. Lose it and you cannot move,
// which on a reload would mean losing your game — so it is kept, per room.
// ---------------------------------------------------------------------------

const SEATS_KEY = "pond-rush/seats";

export interface SeatStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function rememberSeat(store: SeatStore, roomId: string, seat: Seat): void {
  try {
    const all = loadSeats(store);
    all[roomId] = seat;
    store.setItem(SEATS_KEY, JSON.stringify(all));
  } catch {
    // Private browsing. The seat lasts as long as the tab, which is enough
    // to finish a game, and far better than refusing to play.
  }
}

export function recallSeat(store: SeatStore, roomId: string): Seat | null {
  return loadSeats(store)[roomId] ?? null;
}

function loadSeats(store: SeatStore): Record<string, Seat> {
  try {
    const raw = store.getItem(SEATS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
