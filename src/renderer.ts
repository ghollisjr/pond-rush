// ============================================================================
// renderer.ts
//
// Turns `view(state)` into pixels. Two halves, deliberately separated:
//
//   layout()  pure. BoardView + Theme -> a flat display list of positioned
//             sprites. No DOM, so it runs (and tests) under plain node.
//   paint()   the only part that touches the DOM. Given a scene, it syncs a
//             container's children to match.
//
// The split exists so the interesting half — coordinate maths, z-order,
// asset fallback — is testable without a browser or a test-DOM dependency.
//
// There is no game logic here. The renderer never inspects GameState, never
// calls legalMoves, and never decides what is legal: highlights arrive as
// plain coordinates from the caller. It is a pure function of view() output.
// ============================================================================

import type { BoardView, Coord, PieceId, Vec } from "./pond-engine.ts";
import type { Theme } from "./theme.ts";

export type SpriteKind = "tile" | "highlight" | "piece" | "hazard";

/** One positioned thing to draw. Pixels, because this is the pixel layer. */
export interface Sprite {
  kind: SpriteKind;
  /** Abstract key, as emitted by the engine. Kept for debugging and tests. */
  key: string;
  /** Resolved asset URL, or null when the theme has no art for this key. */
  src: string | null;
  /** Fill used when `src` is null, and as the backdrop behind a sprite. */
  colour: string;
  at: Coord;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees clockwise. Always 0 unless the theme opts into rotation. */
  rotation: number;
  z: number;
  /** Pieces only. */
  id?: PieceId;
  settled?: boolean;
  selected?: boolean;
  /** Piece the player could pick up right now. Drawn as an invitation. */
  movable?: boolean;
}

export interface Scene {
  width: number;
  height: number;
  tileSize: number;
  /** Pulled out of the palette once, so paint() never looks a key up. */
  highlightColour: string;
  /** Scale this pack's art with hard pixel edges rather than smoothing. */
  pixelArt: boolean;
  sprites: Sprite[];
}

export interface LayoutOptions {
  /** Cells to mark as reachable. The caller works these out, not us. */
  highlights?: Coord[];
  /** Piece to draw as picked up. */
  selected?: PieceId | null;
  /** Pieces the player may pick up. Marked so the board reads as clickable. */
  movable?: PieceId[];
  /**
   * A piece standing somewhere its engine state doesn't know about yet: the
   * interim landing of a leap chain, which lives in the UI's selection until
   * the chain is committed. A plain coordinate from the caller, exactly like
   * `highlights` — the renderer still knows no rules.
   */
  pending?: { piece: PieceId; at: Coord } | null;
}

// Z-bands. Pieces sit above their tile; highlights sit above pieces, because
// every legal cell on a hazard face is by definition an occupied one — a lit
// cell drawn under an opaque piece is a lit cell nobody can see. Highlights
// are translucent, so the piece underneath still reads through the tint. The
// hazard stays on top, so a piece about to be taken is never hidden under it.
const Z_TILE = 0;
const Z_PIECE = 1;
const Z_HIGHLIGHT = 2;
const Z_HAZARD = 3;

/** Overlay keys the renderer itself asks for, on top of the engine's keys. */
export const HIGHLIGHT_KEY = "overlay.highlight";

/**
 * Palette lookup for a sprite key: drop the kind prefix, keep the rest.
 * "piece.player0" -> "player0", "tile.water" -> "water". A theme that ships
 * only a palette and no art still renders as readable coloured blocks.
 */
export function paletteKeyFor(spriteKey: string): string {
  return spriteKey.replace(/^(tile|piece|hazard|overlay)\./, "");
}

/**
 * Facing vector -> degrees, with sprites assumed to be drawn pointing "up"
 * the board (towards row 0). Only used when the theme opts in; art drawn in
 * profile looks wrong rotated, so the default is to leave pieces upright.
 */
export function rotationFor(facing: Vec): number {
  if (!facing.dr && !facing.dc) return 0;
  return (Math.atan2(facing.dc, -facing.dr) * 180) / Math.PI;
}

/**
 * Build the display list. Pure: same inputs, same output, no I/O.
 *
 * Grid coordinates are multiplied by the theme's tileSize here and nowhere
 * else, which is what lets a 96px pack and a 48px pack both just work.
 */
export function layout(
  view: BoardView,
  theme: Theme,
  opts: LayoutOptions = {}
): Scene {
  const ts = theme.tileSize;
  const sprites: Sprite[] = [];
  const movable = new Set(opts.movable ?? []);

  const place = (
    kind: SpriteKind,
    key: string,
    at: Coord,
    z: number,
    extra: Partial<Sprite> = {}
  ): Sprite => {
    const s: Sprite = {
      kind,
      key,
      src: theme.sprite(key),
      colour: theme.colour(paletteKeyFor(key)),
      at,
      x: at.c * ts,
      y: at.r * ts,
      w: ts,
      h: ts,
      rotation: 0,
      z,
      ...extra,
    };
    sprites.push(s);
    return s;
  };

  for (const t of view.tiles) place("tile", t.tileKey, t.at, Z_TILE);

  for (const h of opts.highlights ?? []) {
    place("highlight", HIGHLIGHT_KEY, h, Z_HIGHLIGHT);
  }

  for (const p of view.pieces) {
    const at = opts.pending && opts.pending.piece === p.id ? opts.pending.at : p.at;
    place("piece", p.spriteKey, at, Z_PIECE, {
      id: p.id,
      settled: p.settled,
      selected: opts.selected === p.id,
      movable: movable.has(p.id),
      rotation: theme.rotatePieces ? rotationFor(p.facing) : 0,
    });
  }

  if (view.hazard) {
    place("hazard", view.hazard.spriteKey, view.hazard.at, Z_HAZARD);
  }

  // Stable painter's order. Sort is by z only — within a band the engine's
  // own ordering is preserved, so a redraw never shuffles equal sprites.
  sprites.sort((a, b) => a.z - b.z);

  return {
    width: view.width * ts,
    height: view.height * ts,
    tileSize: ts,
    highlightColour: theme.colour(paletteKeyFor(HIGHLIGHT_KEY)),
    pixelArt: theme.pixelArt,
    sprites,
  };
}

/**
 * Pixel offset within the board element -> grid coordinate. The inverse of
 * the multiplication in `layout`; kept next to it so the two can't drift.
 * Returns null outside the board.
 */
export function coordAt(
  scene: Scene,
  xPx: number,
  yPx: number
): Coord | null {
  if (xPx < 0 || yPx < 0 || xPx >= scene.width || yPx >= scene.height) {
    return null;
  }
  return {
    r: Math.floor(yPx / scene.tileSize),
    c: Math.floor(xPx / scene.tileSize),
  };
}

// ---------------------------------------------------------------------------
// The DOM half
// ---------------------------------------------------------------------------

/**
 * Sync `container` to `scene`. Elements are keyed and reused between calls,
 * so an <img> that hasn't changed source is never torn down and refetched —
 * which is what stops a blob:-backed user theme flickering on every redraw.
 */
export function paint(container: HTMLElement, scene: Scene): void {
  container.style.position = "relative";
  container.style.width = `${scene.width}px`;
  container.style.height = `${scene.height}px`;

  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children)) {
    const el = child as HTMLElement;
    const k = el.dataset.spriteKey;
    if (k) existing.set(k, el);
    else el.remove();
  }

  const live = new Set<string>();

  for (const s of scene.sprites) {
    const domKey = spriteDomKey(s);
    live.add(domKey);

    let el = existing.get(domKey);
    if (!el) {
      el = document.createElement("div");
      el.dataset.spriteKey = domKey;
      container.appendChild(el);
    }

    el.dataset.r = String(s.at.r);
    el.dataset.c = String(s.at.c);
    el.dataset.kind = s.kind;
    if (s.id) el.dataset.piece = s.id;
    else delete el.dataset.piece;

    const st = el.style;
    st.position = "absolute";
    st.left = `${s.x}px`;
    st.top = `${s.y}px`;
    st.width = `${s.w}px`;
    st.height = `${s.h}px`;
    st.zIndex = String(s.z);
    st.transform = s.rotation ? `rotate(${s.rotation}deg)` : "";
    st.boxSizing = "border-box";
    st.pointerEvents = s.kind === "tile" ? "auto" : "none";

    // Tiles always get their palette block, with art layered over it: they
    // cover the whole board, so a tile whose art fails to load would leave a
    // hole. Pieces and the hazard get the block only when they have no art —
    // their sprites are shapes with transparent corners, and a colour square
    // behind one would show as a square, not a piece.
    st.backgroundColor = s.kind === "tile" || !s.src ? s.colour : "";
    if (s.src) {
      st.backgroundImage = `url("${s.src}")`;
      st.backgroundSize = "100% 100%";
      // Only chunky raster packs want hard edges; vector art needs smoothing.
      st.imageRendering = scene.pixelArt ? "pixelated" : "";
    } else {
      st.backgroundImage = "";
      st.backgroundSize = "";
      st.imageRendering = "";
    }

    st.opacity = s.kind === "highlight" ? "0.55" : "1";

    // The board is the only control surface, so it has to say what can be
    // clicked: a held piece gets a solid ring, one that could be picked up a
    // dashed one. Both in the highlight colour, never the piece's own — an
    // outline the same colour as what it surrounds is no outline at all.
    if (s.selected) st.outline = `3px solid ${scene.highlightColour}`;
    else if (s.movable) st.outline = `2px dashed ${scene.highlightColour}`;
    else st.outline = "";
    st.outlineOffset = s.selected || s.movable ? "-3px" : "";

    st.filter = s.settled ? "saturate(1.4)" : "";
  }

  for (const [k, el] of existing) if (!live.has(k)) el.remove();
}

/**
 * Identity of a sprite across redraws. Pieces keep their identity as they
 * move so the element is reused; everything else is identified by its cell,
 * since tiles and the hazard never need to animate between two of themselves.
 */
function spriteDomKey(s: Sprite): string {
  if (s.kind === "piece") return `piece:${s.id}`;
  return `${s.kind}:${s.at.r},${s.at.c}`;
}
