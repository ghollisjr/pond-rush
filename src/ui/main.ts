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
  replay,
  scores,
  view,
  type GameState,
  type Move,
} from "../pond-engine.ts";
import { BUILT_IN_VARIANTS, VariantRegistry } from "../rules.ts";
import { coordFromElement, layout, type Scene } from "../renderer.ts";
import { paint } from "../renderer.ts";
import {
  Theme,
  loadThemeFromFiles,
  loadThemeFromUrl,
  validateTheme,
} from "../theme.ts";
import { PLAIN_THEME } from "./default-theme.ts";
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
  turnStatus,
  type Selection,
} from "./hotseat.ts";

const registry = new VariantRegistry();

interface Session {
  variantId: string;
  seed: number;
  state: GameState;
  selection: Selection;
  theme: Theme;
  /** Degrees the board is laid back. 0 is the flat top-down view. */
  tilt: number;
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
    tilt: session?.tilt ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

function commit(move: Move): void {
  session.state = applyMove(session.state, move);
  session.selection = NO_SELECTION;
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
  session.selection = NO_SELECTION;
  render();
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
  });
  // A rotated plane keeps its original layout box, so the near edge spreads
  // wider and the far edge lifts higher than the box accounts for. Reserve the
  // room here rather than in the renderer, which has no business knowing how
  // the page around it is laid out.
  $("board-stage").style.padding = session.tilt
    ? `${Math.round(session.tilt * 1.7)}px ${Math.round(session.tilt * 2.2)}px`
    : "0";

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

  const now = explainNow(state, selection, theme);
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
  } else {
    $("turn").textContent = `Player ${st.player + 1}`;
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

  ($("roll") as HTMLButtonElement).disabled = !st.canRoll;
  ($("pass") as HTMLButtonElement).disabled = !st.canPass;
  ($("undo") as HTMLButtonElement).disabled = state.history.length === 0;

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

  const start = () => {
    const seed = Number(($("seed") as HTMLInputElement).value) || 1;
    session = newSession(picker.value, seed, session.theme);
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
  tilt.addEventListener("input", () => {
    session.tilt = Number(tilt.value);
    $("tilt-read").textContent = session.tilt ? `${session.tilt}°` : "flat";
    render();
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
      $("hint").textContent = `Theme didn't load: ${(err as Error).message}`;
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

wire();
render();
void loadDefaultPack();
