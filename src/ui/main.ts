// ============================================================================
// ui/main.ts
//
// Local hot-seat play: the browser entry point that joins the three pure
// layers together. It owns exactly three things the pure layers can't — the
// current GameState, the current Selection, and the DOM.
//
// Everything interesting lives elsewhere:
//   rules.ts / pond-engine.ts   what is legal, what a move does
//   ui/hotseat.ts               what a click means
//   renderer.ts                 where things are drawn
//
// So this file has no rules in it. If a question here needs answering by
// reading the rulebook, it belongs in one of the other three.
// ============================================================================

import {
  applyMove,
  createGame,
  legalMoves,
  moveIndex,
  replay,
  scores,
  view,
  type GameState,
  type Move,
} from "../pond-engine.ts";
import { BUILT_IN_VARIANTS, VariantRegistry } from "../rules.ts";
import {
  decodeGame,
  encodeGame,
  loadSaved,
  replayIndices,
  saveGame,
} from "../session.ts";
import { coordFromElement, layout, type Scene } from "../renderer.ts";
import { paint } from "../renderer.ts";
import {
  Theme,
  loadThemeFromFiles,
  loadThemeFromUrl,
  validateTheme,
} from "../theme.ts";
import { PLAIN_THEME } from "./default-theme.ts";
import { serverUrl } from "./config.ts";
import {
  OnlineClient,
  OnlineError,
  recallSeat,
  rememberSeat,
  type RoomView,
  type Seat,
} from "./online.ts";
import { explainNow, rulesSheet, tutorial, type HelpSection } from "./help.ts";
import {
  NO_SELECTION,
  beginRescue,
  click as interpretClick,
  confirmableMove,
  highlightsFor,
  pendingAt,
  rescuablePieces,
  selectablePieces,
  selfTargets,
  viewpointFor,
  turnStatus,
  type Selection,
} from "./hotseat.ts";

const registry = new VariantRegistry();
const online = new OnlineClient(serverUrl());

/**
 * Set only while playing a networked game. When it is null the page behaves
 * exactly as it always has — the whole online layer is additive, so a server
 * that is down costs you multiplayer and nothing else.
 */
interface OnlineGame {
  roomId: string;
  seat: Seat;
  room: RoomView;
  /** Polling handle, so leaving a game stops the traffic. */
  timer: number | null;
}
let net: OnlineGame | null = null;

/**
 * How far the board is laid back on first load. Flat reads as a diagram;
 * this reads as a board on a table, which is what the game is. The slider
 * goes to 0 for anyone who wants the top-down view back.
 */
const DEFAULT_TILT = 45;

interface Session {
  variantId: string;
  seed: number;
  state: GameState;
  selection: Selection;
  theme: Theme;
  /** Degrees the board is laid back. 0 is the flat top-down view. */
  tilt: number;
  /**
   * The move log as indices into `legalMoves`, kept in step with
   * `state.history`. Appended as moves are made rather than re-derived, which
   * would mean replaying the whole game on every turn.
   */
  moves: number[];
}

let session: Session = newSession("standard-4p", 1, new Theme(PLAIN_THEME));
let scene: Scene;

function newSession(variantId: string, seed: number, theme: Theme): Session {
  const { rules, board } = registry.resolve(variantId);
  return {
    variantId,
    seed,
    state: createGame(seed, board, rules),
    selection: NO_SELECTION,
    theme,
    tilt: session?.tilt ?? DEFAULT_TILT,
    moves: [],
  };
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

function commit(move: Move): void {
  // Taken against the pre-move state: an index only means anything relative
  // to the list it indexes.
  const index = moveIndex(session.state, move);

  if (net) {
    void submit(index);
    return;
  }

  session.state = applyMove(session.state, move);
  if (index >= 0) session.moves.push(index);
  session.selection = NO_SELECTION;
  publish();
  render();
}

/**
 * Online, the server decides. The move is sent and the board is rebuilt from
 * what comes back, rather than applied locally and hoped about — the client's
 * copy is a view of the server's game, not a second game that has to agree.
 */
async function submit(index: number): Promise<void> {
  if (!net || index < 0) return;
  try {
    const room = await online.move(
      net.roomId,
      net.seat.token,
      index,
      session.moves.length
    );
    adopt(room);
    notify("");
  } catch (err) {
    const e = err as OnlineError;
    notify(e.message);
    // Behind, or refused. Either way the server's version is the real one.
    if (e.status === 409 || e.status === 0) void poll();
  }
}

/**
 * Ask what has happened. Polling rather than a socket: the game is
 * turn-based, nobody notices two seconds, and every reply carries the whole
 * position — so a tab that slept for an hour recovers by the same path as one
 * that blinked. There is no reconnect logic because there is no connection.
 */
const POLL_MS = 2500;

async function poll(): Promise<void> {
  if (!net) return;
  try {
    const { room } = await online.since(net.roomId, session.moves.length);
    // Rebuild only when something actually changed.
    if (room.moves.length !== session.moves.length ||
        room.players.length !== net.room.players.length) {
      adopt(room);
    } else {
      net.room = room;
      renderOnline();
    }
    markReachable(true);
  } catch (err) {
    markReachable(false, (err as OnlineError).message);
  }
}

function startPolling(): void {
  stopPolling();
  if (!net) return;
  net.timer = setInterval(() => void poll(), POLL_MS) as unknown as number;
}

function stopPolling(): void {
  if (net?.timer != null) clearInterval(net.timer);
  if (net) net.timer = null;
}

/** Replace the local game with the server's, whatever we thought it was. */
function adopt(room: RoomView): void {
  const { rules, board } = registry.resolve(room.variantId);
  session.variantId = room.variantId;
  session.seed = room.seed;
  session.moves = room.moves;
  session.state = replayIndices(
    { variantId: room.variantId, seed: room.seed, moves: room.moves },
    board,
    rules
  );
  session.selection = NO_SELECTION;
  if (net) net.room = room;
  // The controls describe the game on the board, which in a room is the
  // room's, not whatever was picked locally before joining.
  ($("variant") as HTMLSelectElement).value = room.variantId;
  ($("seed") as HTMLInputElement).value = String(room.seed);
  render();
}

/**
 * Undo by replaying the log one move short. Cheap only because the engine is
 * pure and every state is reachable from (seed, moves) — the same property
 * the server will lean on for reconnects.
 */
function undo(): void {
  const log = session.state.history;
  if (!log.length) return;
  const { rules, board } = registry.resolve(session.variantId);
  session.state = replay(session.seed, log.slice(0, -1), board, rules);
  session.moves.pop();
  session.selection = NO_SELECTION;
  publish();
  render();
}

// ---------------------------------------------------------------------------
// Sharing and resuming
//
// There is no server: a game travels as a link and persists in this browser.
// Both are the same three facts — variant, seed, and the moves as indices —
// which is also what a server would store, so none of this is throwaway.
// ---------------------------------------------------------------------------

/**
 * A message about something that just happened. Deliberately not the hint
 * line: `render()` rewrites that from the game state, and the theme pack
 * finishes loading after boot and repaints — which silently swallowed the
 * "that link didn't load" message until this existed.
 */
function notify(message: string): void {
  const el = $("notice");
  el.textContent = message;
  el.hidden = !message;
}

function markReachable(up: boolean, why = ""): void {
  const el = $("online-state");
  el.textContent = up ? "connected" : why || "unreachable";
  el.className = up ? "up" : "down";
}

function renderOnline(): void {
  const inGame = net !== null;
  $("online-actions").hidden = inGame;
  $("online-room").hidden = !inGame;

  if (!net) {
    $("online-players").textContent = "";
    $("you-row").hidden = true;
    return;
  }

  $("room-label").textContent = net.roomId;

  const me = net.room.players.find((p) => p.seat === net!.seat.seat);
  const colour = session.theme.colour(`player${net.seat.seat}`);
  $("you-row").hidden = false;
  const you = $("you");
  you.textContent = `You are Player ${net.seat.seat + 1}${
    me ? ` — ${me.name}` : ""
  }`;
  you.style.borderLeftColor = colour;
  you.style.color = colour;

  const seats = net.room.players
    .map((p) => {
      const you = p.seat === net!.seat.seat;
      const turn = net!.room.turn === p.seat ? " \u2190" : "";
      return `<span class="${you ? "seat-you" : ""}">${escape(p.name)}${
        you ? " (you)" : ""
      }${turn}</span>`;
    })
    .join(" · ");
  const waiting = net.room.openSeats.length
    ? ` · waiting for ${net.room.openSeats.length} more`
    : "";
  $("online-players").innerHTML = seats + waiting;
}

/** True when the board should ignore clicks: someone else is to move. */
function spectating(): boolean {
  return net !== null && session.state.turn !== net.seat.seat;
}

async function hostGame(): Promise<void> {
  try {
    notify("Creating a game…");
    const room = await online.createRoom(session.variantId);
    const { seat } = await online.join(room.id, playerName());
    rememberSeat(localStorage, room.id, seat);
    enterRoom(room.id, seat);
    notify(`Game ${room.id} created — send the invite.`);
  } catch (err) {
    notify((err as OnlineError).message);
  }
}

async function joinGame(code: string): Promise<void> {
  const roomId = code.trim().toUpperCase();
  if (!roomId) return;
  try {
    notify(`Joining ${roomId}…`);
    // A seat already held in this room is reclaimed rather than taking a
    // second one, so a reload does not cost you the game.
    // Sending the held token makes this idempotent: the server hands back the
    // same seat rather than a new one, and a stale token simply gets a fresh
    // seat instead of an error.
    const held = recallSeat(localStorage, roomId);
    const { seat } = await online.join(
      roomId,
      playerName(),
      undefined,
      held?.token
    );
    rememberSeat(localStorage, roomId, seat);
    enterRoom(roomId, seat);
    notify(`Joined ${roomId}.`);
  } catch (err) {
    notify((err as OnlineError).message);
  }
}

function enterRoom(roomId: string, seat: Seat): void {
  net = { roomId, seat, room: emptyRoomView(roomId), timer: null };
  publish();
  void poll().then(startPolling);
  renderOnline();
  render();
}

function leaveRoom(): void {
  stopPolling();
  net = null;
  publish();
  notify("Left the game. The board is yours again.");
  renderOnline();
  render();
}

/** A placeholder until the first poll answers. */
function emptyRoomView(roomId: string): RoomView {
  return {
    id: roomId,
    variantId: session.variantId,
    seed: session.seed,
    moves: [],
    players: [],
    turn: 0,
    finished: false,
    openSeats: [],
  };
}

function playerName(): string {
  const stored = (() => {
    try {
      return localStorage.getItem("pond-rush/name") ?? "";
    } catch {
      return "";
    }
  })();
  const name = stored || `Player ${Math.floor(Math.random() * 900 + 100)}`;
  try {
    localStorage.setItem("pond-rush/name", name);
  } catch {
    // Not worth a message.
  }
  return name;
}

function currentLink(): string {
  return encodeGame({
    variantId: session.variantId,
    seed: session.seed,
    moves: session.moves,
  });
}

/**
 * Keep the address bar describing the game, and save it locally.
 *
 * The URL names the *room* when online and is left clean otherwise. It used
 * to carry the whole local game and rewrite itself on every move, which was
 * wrong twice over: during an online game it still showed a stale local link,
 * so copying the URL handed someone an empty game instead of the room; and
 * rewriting the hash at boot swallowed `#room=` invites before they could be
 * read. Resuming is localStorage's job and always was — a link is something
 * you ask for, with the button.
 */
function publish(): void {
  try {
    const want = net ? `#room=${net.roomId}` : "";
    if (location.hash !== want) {
      history.replaceState(null, "", want || location.pathname + location.search);
    }
  } catch {
    // Some embeddings disallow replaceState. The link buttons still work.
  }
  // A room's moves live on the server; saving them here would resurrect a
  // stale copy as a local game on the next visit.
  if (net) return;
  try {
    saveGame(localStorage, {
      id: `${session.variantId}.${session.seed}`,
      variantId: session.variantId,
      seed: session.seed,
      moves: session.moves,
      updatedAt: Date.now(),
    });
  } catch {
    // Private browsing. Playing on is more important than remembering.
  }
}

/** Build a session from a link, or return null if there is no usable one. */
function sessionFromLink(code: string, theme: Theme): Session | null {
  const ref = decodeGame(code);
  const { rules, board } = registry.resolve(ref.variantId);
  return {
    variantId: ref.variantId,
    seed: ref.seed,
    state: replayIndices(ref, board, rules),
    selection: NO_SELECTION,
    theme,
    tilt: DEFAULT_TILT,
    moves: ref.moves,
  };
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

function render(): void {
  const { state, theme, selection } = session;
  // Mid-chain the engine still has the piece on its pre-leap cell — the
  // landings so far live in the selection — so the renderer is told where the
  // chain has actually reached. Without it the lit continuations are measured
  // from a cell with nothing drawn on it.
  const chainAt = pendingAt(selection);
  scene = layout(view(state), theme, {
    highlights: highlightsFor(state, selection),
    selected: selection.rescuing ? null : selection.piece,
    pending: chainAt && selection.piece ? { piece: selection.piece, at: chainAt } : null,
    // Only worth marking before a piece is held; once one is, the lit cells
    // are the thing to look at.
    movable: selection.piece ? [] : selectablePieces(state),
    tilt: session.tilt,
    warnings: selfTargets(state),
    // Online, you are shown the table from your own side: your pieces
    // nearest you, crossing away. Hot seat stays put, because a board that
    // spun every turn would be worse than one that never does.
    quarterTurns: net ? viewpointFor(state, net.seat.seat) : 0,
  });
  paint($("board"), scene);
  renderHud();
  renderHelp();
}

// ---------------------------------------------------------------------------
// Help
//
// The panel is a view of the same state the board is, so it is rebuilt on
// every render rather than patched on events — there is no second source of
// truth to drift. All the wording comes from help.ts; this just places it.
// ---------------------------------------------------------------------------

type HelpTab = "now" | "rules" | "tutorial";
let helpTab: HelpTab = "now";

const escape = (t: string): string =>
  t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

function sectionsHtml(sections: HelpSection[]): string {
  return sections
    .map(
      (s) =>
        `<h3>${escape(s.title)}</h3>` +
        s.paras.map((p) => `<p>${escape(p)}</p>`).join("")
    )
    .join("");
}

function renderHelp(): void {
  const { state, selection, theme } = session;

  const now = explainNow(
    state,
    selection,
    theme,
    net
      ? {
          seat: net.seat.seat,
          nameFor: (s) =>
            net!.room.players.find((p) => p.seat === s)?.name ??
            `Player ${s + 1}`,
        }
      : undefined
  );
  $("help-headline").textContent = now.headline;
  $("help-detail").textContent = now.detail;
  $("help-options").innerHTML = now.options
    .map(
      (o) => `<li><b>${escape(o.label)}</b><span>${escape(o.text)}</span></li>`
    )
    .join("");

  // The reference is generated from the live ruleset, so switching variant
  // rewrites it. Built on show rather than cached for that reason.
  if (helpTab === "rules") {
    $("pane-rules").innerHTML = sectionsHtml(rulesSheet(state, theme));
  } else if (helpTab === "tutorial") {
    $("pane-tutorial").innerHTML = sectionsHtml(tutorial(theme));
  }

  for (const tab of ["now", "rules", "tutorial"] as HelpTab[]) {
    $(`pane-${tab}`).hidden = helpTab !== tab;
    $(`tab-${tab}`).setAttribute("aria-selected", String(helpTab === tab));
  }
}

function renderHud(): void {
  const { state, theme, selection } = session;
  const st = turnStatus(state);
  const table = scores(state);

  if (st.phase === "finished") {
    const who = st.winners.map((p) => `Player ${p + 1}`).join(" & ");
    $("turn").textContent = st.winners.length > 1 ? `Draw: ${who}` : `${who} wins`;
  } else if (net && st.player === net.seat.seat) {
    // "Player 2" is ambiguous when you are Player 2 — it reads as a label
    // for someone else.
    $("turn").textContent = `Your turn`;
  } else {
    const who = net?.room.players.find((p) => p.seat === st.player);
    $("turn").textContent = who ? `${who.name}'s turn` : `Player ${st.player + 1}`;
  }
  $("turn").style.color = theme.colour(`player${st.player}`);

  const face = st.faceKey ? theme.text(st.faceKey, st.faceKey) : "";
  const spaces = st.spacesLeft > 0 ? ` — ${st.spacesLeft} left` : "";
  $("face").textContent = st.phase === "acting" ? `${face}${spaces}` : "";

  $("scores").innerHTML = Object.entries(table)
    .map(
      ([p, v]) =>
        `<span class="score" style="border-color:${theme.colour(`player${p}`)}">` +
        `P${Number(p) + 1} <b>${v}</b></span>`
    )
    .join("");

  const theirTurn = spectating();
  ($("roll") as HTMLButtonElement).disabled = !st.canRoll || theirTurn;
  ($("pass") as HTMLButtonElement).disabled = !st.canPass || theirTurn;
  // Undo rewrites history, which cannot be done to a game other people are
  // in. Share the link instead if you want a do-over.
  ($("undo") as HTMLButtonElement).disabled =
    state.history.length === 0 || net !== null;
  ($("new") as HTMLButtonElement).disabled = net !== null;
  // One link concept at a time. In a room the invite is the link that means
  // anything; a game link alongside it is just an invitation to send the
  // wrong one.
  $("share").hidden = net !== null;
  ($("variant") as HTMLSelectElement).disabled = net !== null;
  ($("seed") as HTMLInputElement).disabled = net !== null;

  const confirm = confirmableMove(selection);
  const confirmBtn = $("confirm") as HTMLButtonElement;
  confirmBtn.hidden = !confirm;
  confirmBtn.textContent = confirm ? `Stop here (${selection.path.length})` : "";

  // Rescue is offered alongside the rolled action, so it gets its own row
  // rather than competing with the board for clicks.
  const rescuable = rescuablePieces(state);
  const box = $("rescue");
  box.hidden = rescuable.length === 0;
  box.innerHTML = rescuable.length
    ? `<span>Bring back a ${theme.text("piece.singular", "piece")}:</span>` +
      rescuable
        .map((id) => `<button data-rescue="${id}">${id}</button>`)
        .join("")
    : "";

  $("hint").textContent = hintFor();
}

function hintFor(): string {
  const { state, selection, theme } = session;
  if (spectating()) {
    const who = net!.room.players.find((p) => p.seat === state.turn);
    return `Waiting for ${who ? who.name : `Player ${state.turn + 1}`}…`;
  }
  if (state.phase === "finished") return "Game over.";
  if (state.phase === "awaiting_roll") return "Roll to start your turn.";
  if (selection.rescuing) return "Pick a starting cell.";
  if (state.pending?.kind === "hazard") {
    return `Place the ${theme.text("hazard.primary", "hazard")}.`;
  }
  if (selection.path.length) return "Keep jumping, or stop here.";
  if (selection.piece) return "Pick a destination.";
  return legalMoves(state).some((m) => m.kind !== "pass")
    ? "Pick one of your pieces."
    : "Nothing to do — pass.";
}

function showThemeProblems(problems: string[]): void {
  const box = $("theme-problems");
  box.hidden = problems.length === 0;
  box.textContent = problems.length
    ? `${problems.length} problem${problems.length > 1 ? "s" : ""} with that pack — ` +
      `the fallback covers them: ${problems.join(" ")}`
    : "";
  if (problems.length) console.warn("Theme issues:", problems);
}

function onBoardClick(ev: MouseEvent): void {
  // Online, the board is read-only until it is your turn. The server would
  // refuse anyway; refusing here keeps a half-made selection from appearing
  // and then silently evaporating.
  if (spectating()) {
    notify("Not your turn yet.");
    return;
  }
  const at = coordFromElement(ev.target as HTMLElement | null);
  if (!at) return;

  const result = interpretClick(session.state, session.selection, at);
  if (result.move) commit(result.move);
  else {
    session.selection = result.selection;
    render();
  }
}

function wire(): void {
  const picker = $("variant") as HTMLSelectElement;
  picker.innerHTML = BUILT_IN_VARIANTS.map(
    (v) => `<option value="${v.id}">${v.name}</option>`
  ).join("");

  picker.value = session.variantId;
  ($("seed") as HTMLInputElement).value = String(session.seed);

  const start = () => {
    const seed = Number(($("seed") as HTMLInputElement).value) || 1;
    session = newSession(picker.value, seed, session.theme);
    notify("");
    publish();
    render();
  };

  $("new").addEventListener("click", start);
  picker.addEventListener("change", start);

  $("board").addEventListener("click", onBoardClick);
  $("roll").addEventListener("click", () => commit({ kind: "roll" }));
  $("pass").addEventListener("click", () => commit({ kind: "pass" }));
  $("undo").addEventListener("click", undo);
  $("confirm").addEventListener("click", () => {
    const m = confirmableMove(session.selection);
    if (m) commit(m);
  });

  for (const tab of ["now", "rules", "tutorial"] as HelpTab[]) {
    $(`tab-${tab}`).addEventListener("click", () => {
      helpTab = tab;
      renderHelp();
    });
  }

  const tilt = $("tilt") as HTMLInputElement;
  tilt.value = String(session.tilt);
  $("tilt-read").textContent = session.tilt ? `${session.tilt}°` : "flat";
  tilt.addEventListener("input", () => {
    session.tilt = Number(tilt.value);
    $("tilt-read").textContent = session.tilt ? `${session.tilt}°` : "flat";
    render();
  });

  $("host").addEventListener("click", () => void hostGame());
  $("join").addEventListener("click", () =>
    void joinGame(($("room-code") as HTMLInputElement).value)
  );
  ($("room-code") as HTMLInputElement).addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key === "Enter") {
      void joinGame(($("room-code") as HTMLInputElement).value);
    }
  });
  $("leave").addEventListener("click", leaveRoom);

  $("copy-room").addEventListener("click", async () => {
    if (!net) return;
    const url = `${location.origin}${location.pathname}#room=${net.roomId}`;
    try {
      await navigator.clipboard.writeText(url);
      notify("Invite copied — send it to the other players.");
    } catch {
      ($("share-url") as HTMLInputElement).value = url;
      $("share-url").hidden = false;
      notify("Copy this invite and send it to the other players.");
    }
  });

  $("share").addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}#g=${currentLink()}`;
    try {
      await navigator.clipboard.writeText(url);
      notify("Link copied. It carries this game — send it to the next player.");
    } catch {
      // Clipboard access is refused in plenty of contexts. Showing the link
      // is worse than copying it, but much better than silently failing.
      ($("share-url") as HTMLInputElement).value = url;
      $("share-url").hidden = false;
      ($("share-url") as HTMLInputElement).select();
      notify("Copy this link and send it to the next player.");
    }
  });

  $("help-toggle").addEventListener("click", () => {
    const panel = $("help");
    panel.hidden = !panel.hidden;
    $("help-toggle").setAttribute("aria-expanded", String(!panel.hidden));
  });

  $("rescue").addEventListener("click", (ev) => {
    const id = (ev.target as HTMLElement).dataset.rescue;
    if (!id) return;
    session.selection = beginRescue(id);
    render();
  });

  // Themes are picked from the player's own disk and never leave it.
  $("theme").addEventListener("change", async (ev) => {
    const files = (ev.target as HTMLInputElement).files;
    if (!files?.length) return;
    try {
      const loaded = await loadThemeFromFiles(files);
      session.theme = new Theme(loaded, PLAIN_THEME);
      // A pack is somebody's work in progress as often as not. Say what is
      // missing next to the picker — the pack still plays, because every gap
      // falls through to the fallback, but silence would leave the person who
      // made it guessing why their art never showed up.
      showThemeProblems(validateTheme(loaded));
      render();
    } catch (err) {
      showThemeProblems([]);
      notify(`Theme didn't load: ${(err as Error).message}`);
    }
  });
}

/**
 * The pack served alongside the page. It is only the default: everything
 * still falls through to PLAIN_THEME, so a missing or broken pack costs the
 * board its art and nothing else. Loaded after the first paint so the game is
 * on screen and playable whether or not the fetch succeeds.
 */
const DEFAULT_PACK_URL = "theme";

async function loadDefaultPack(): Promise<void> {
  try {
    const loaded = await loadThemeFromUrl(DEFAULT_PACK_URL);
    session.theme = new Theme(loaded, PLAIN_THEME);
    render();
  } catch {
    // Served without the pack, or offline. The palette fallback is already
    // on screen, so there is nothing to recover and nothing to report.
  }
}

/**
 * Decide which game to open with. A link someone sent beats whatever was
 * last played here, and anything unreadable falls back to a new game with a
 * message rather than a blank page.
 */
/**
 * The hash as the page was opened, captured once. `publish()` rewrites it to
 * the current game within a tick of boot, so anything reading `location.hash`
 * later sees that instead — which silently swallowed every `#room=` invite.
 */
const openedWith = typeof location === "undefined" ? "" : location.hash;

function boot(): string | null {
  const fromUrl = /^#g=(.+)$/.exec(openedWith)?.[1];
  if (fromUrl) {
    try {
      const restored = sessionFromLink(decodeURIComponent(fromUrl), session.theme);
      if (restored) {
        session = restored;
        return null;
      }
    } catch (err) {
      return `That link didn't load: ${(err as Error).message}`;
    }
  }

  try {
    const [latest] = loadSaved(localStorage);
    if (latest) {
      const { rules, board } = registry.resolve(latest.variantId);
      session = {
        variantId: latest.variantId,
        seed: latest.seed,
        state: replayIndices(latest, board, rules),
        selection: NO_SELECTION,
        theme: session.theme,
        tilt: DEFAULT_TILT,
        moves: latest.moves,
      };
      return latest.moves.length ? "Resumed your last game." : null;
    }
  } catch {
    // A saved game from an older format, or a variant that no longer exists.
    // Starting fresh is the right answer and needs no explanation.
  }
  return null;
}

const bootMessage = boot();
wire();
render();
renderOnline();

// Check the server once at start so the panel is honest about whether
// online play is available, and pick up an invite link if there is one.
void (async () => {
  const up = await online.health();
  markReachable(up, up ? "" : "server unreachable — local play only");
  const invite = /^#room=([A-Za-z0-9_-]{1,32})$/.exec(openedWith)?.[1];
  if (invite && !up) {
    notify(`Can't reach the server, so invite ${invite} can't be opened.`);
  } else if (invite) {
    void joinGame(invite);
  }
})();
// So the address bar and the Copy link button agree from the first paint,
// not only after the first move.
publish();
if (bootMessage) notify(bootMessage);
void loadDefaultPack();
