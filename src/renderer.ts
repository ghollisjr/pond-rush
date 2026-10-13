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

export type SpriteKind = "tile" | "shadow" | "highlight" | "piece" | "hazard";

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
  /** A legal cell that is probably a mistake. Marked, never hidden. */
  warn?: boolean;
}

export interface Scene {
  width: number;
  height: number;
  tileSize: number;
  /** Pulled out of the palette once, so paint() never looks a key up. */
  highlightColour: string;
  /** Scale this pack's art with hard pixel edges rather than smoothing. */
  pixelArt: boolean;
  /** Colour for a lit cell the player probably does not want. */
  warnColour: string;
  /**
   * Degrees to lay the board back from the viewer. 0 is the flat top-down
   * board. Purely presentational — the engine knows nothing about it, and
   * every coordinate in this scene is still the flat grid position.
   */
  tilt: number;
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
  /** Lay the board back by this many degrees. 0, the default, is flat. */
  tilt?: number;
  /**
   * Quarter turns clockwise to spin the board before drawing, so a player
   * can be shown the table from their own side. Purely presentational: the
   * grid coordinate on every sprite stays the real one, so clicks, the
   * engine and the server all keep talking about the same cells.
   */
  quarterTurns?: 0 | 1 | 2 | 3;
  /**
   * Cells that are legal but inadvisable — lit like any other, in a colour
   * that says so. The caller decides what counts; the renderer only paints.
   */
  warnings?: Coord[];
}

// Z-bands. Pieces sit above their tile; highlights sit above pieces, because
// every legal cell on a hazard face is by definition an occupied one — a lit
// cell drawn under an opaque piece is a lit cell nobody can see. Highlights
// are translucent, so the piece underneath still reads through the tint. The
// hazard stays on top, so a piece about to be taken is never hidden under it.
/**
 * Viewer distance for the tilted board, in pixels. Lower is a wider angle and
 * a stronger sense of depth; too low and the near row balloons. 1200 was far
 * enough that the board read as merely squashed rather than receding.
 */
const PERSPECTIVE = 800;

const Z_TILE = 0;
const Z_SHADOW = 1;
const Z_PIECE = 2;
const Z_HIGHLIGHT = 3;
const Z_HAZARD = 4;

/** Overlay keys the renderer itself asks for, on top of the engine's keys. */
export const HIGHLIGHT_KEY = "overlay.highlight";
/** Contact shadow under a standing piece. Drawn, not themed. */
export const SHADOW_KEY = "overlay.shadow";

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

  // Spinning the board is a change of where a cell is drawn, never of which
  // cell it is. Sprites keep their true `at`, so the hit test, the engine and
  // the server are all still talking about the same square — and the art is
  // not rotated either, so pieces and the numbers on the scoring tiles stay
  // the right way up.
  const turns = (((opts.quarterTurns ?? 0) % 4) + 4) % 4;
  const rows = view.height;
  const cols = view.width;
  const place2d = (at: Coord): { x: number; y: number } => {
    switch (turns) {
      case 1:
        return { x: (rows - 1 - at.r) * ts, y: at.c * ts };
      case 2:
        return { x: (cols - 1 - at.c) * ts, y: (rows - 1 - at.r) * ts };
      case 3:
        return { x: at.r * ts, y: (cols - 1 - at.c) * ts };
      default:
        return { x: at.c * ts, y: at.r * ts };
    }
  };

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
      ...place2d(at),
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

  const warned = new Set((opts.warnings ?? []).map((c) => `${c.r},${c.c}`));
  for (const h of opts.highlights ?? []) {
    place("highlight", HIGHLIGHT_KEY, h, Z_HIGHLIGHT, {
      warn: warned.has(`${h.r},${h.c}`),
    });
  }

  // A standing piece with nothing beneath it reads as a card floating over the
  // water. The contact shadow is what puts it *on* a cell — it is the single
  // biggest depth cue here, more than the perspective itself.
  if (opts.tilt) {
    for (const p of view.pieces) {
      const at = opts.pending && opts.pending.piece === p.id ? opts.pending.at : p.at;
      place("shadow", SHADOW_KEY, at, Z_SHADOW);
    }
    if (view.hazard) place("shadow", SHADOW_KEY, view.hazard.at, Z_SHADOW);
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

  // An odd number of turns puts the board on its side.
  const odd = turns % 2 === 1;
  return {
    width: (odd ? view.height : view.width) * ts,
    height: (odd ? view.width : view.height) * ts,
    tileSize: ts,
    highlightColour: theme.colour(paletteKeyFor(HIGHLIGHT_KEY)),
    pixelArt: theme.pixelArt,
    warnColour: theme.colour("warning", "#e0564a"),
    tilt: opts.tilt ?? 0,
    sprites,
  };
}

/**
 * Grid coordinate of the cell an event landed on, read off the element the
 * browser hit-tested.
 *
 * This is the hit test to use. `coordAt` below inverts the layout maths, which
 * is only valid while the board is an unrotated rectangle — the moment there
 * is a perspective transform, pixel arithmetic stops describing the screen.
 * The browser already hit-tests transformed elements correctly, and `paint`
 * stamps the cell on every element, so asking the element is both simpler and
 * projection-independent.
 */
export function coordFromElement(el: HTMLElement | null): Coord | null {
  for (let node = el; node; node = node.parentElement) {
    const { r, c } = node.dataset ?? {};
    if (r !== undefined && c !== undefined) {
      return { r: Number(r), c: Number(c) };
    }
  }
  return null;
}

/**
 * Pixel offset within the board element -> grid coordinate. The inverse of
 * the multiplication in `layout`; kept next to it so the two can't drift.
 * Returns null outside the board. Only valid for an untilted board — see
 * `coordFromElement`.
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

  // Lay the whole board back as one plane. Children keep their flat grid
  // positions; only the plane they sit on is rotated, which is why nothing
  // above this layer has to know the board is tilted.
  container.style.transformStyle = scene.tilt ? "preserve-3d" : "";
  container.style.transformOrigin = "center center";
  // Laying the board back widens its near edge well beyond its layout box.
  // Shrinking the plane as it tilts keeps the drawn board inside roughly the
  // footprint the page reserved, so it never crowds the panels beside it.
  // Scale is part of the transform, so it costs no reflow.
  const shrink = scene.tilt ? 1 - scene.tilt / 300 : 1;
  container.style.transform = scene.tilt
    ? `perspective(${PERSPECTIVE}px) rotateX(${scene.tilt}deg) scale(${shrink.toFixed(3)})`
    : "";

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

    // Tiles and highlights lie flat on the plane; pieces and the hazard
    // hinge up from the back edge of their cell so they face the viewer
    // instead of reading as decals painted on the water.
    const standsUp = scene.tilt !== 0 && (s.kind === "piece" || s.kind === "hazard");
    const isShadow = s.kind === "shadow";
    const parts: string[] = [];
    if (standsUp) parts.push(`rotateX(${-scene.tilt}deg)`);
    if (s.rotation) parts.push(`rotate(${s.rotation}deg)`);
    st.transform = parts.join(" ");
    st.transformOrigin = standsUp ? "center bottom" : "";
    st.boxSizing = "border-box";
    st.pointerEvents = s.kind === "tile" ? "auto" : "none";

    if (isShadow) {
      // An ellipse lying on the plane, hugging the bottom of the cell where
      // the piece hinges from. Blurred, because a hard edge reads as a hole.
      st.backgroundImage = "";
      st.backgroundColor = "rgba(0,0,0,0.42)";
      st.borderRadius = "50%";
      st.filter = "blur(4px)";
      st.width = `${s.w * 0.62}px`;
      st.height = `${s.h * 0.26}px`;
      st.left = `${s.x + s.w * 0.19}px`;
      st.top = `${s.y + s.h * 0.64}px`;
      st.outline = "";
      st.opacity = "1";
      continue;
    }

    // Tiles always get their palette block, with art layered over it: they
    // cover the whole board, so a tile whose art fails to load would leave a
    // hole. Pieces and the hazard get the block only when they have no art —
    // their sprites are shapes with transparent corners, and a colour square
    // behind one would show as a square, not a piece.
    st.backgroundColor =
      s.warn ? scene.warnColour : s.kind === "tile" || !s.src ? s.colour : "";
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

    // A warning needs to carry at a glance, so it sits a little heavier.
    st.opacity = s.kind === "highlight" ? (s.warn ? "0.68" : "0.55") : "1";

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
