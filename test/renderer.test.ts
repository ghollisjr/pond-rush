import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import {
  HIGHLIGHT_KEY,
  coordAt,
  layout,
  paletteKeyFor,
  rotationFor,
  type Sprite,
} from "../src/renderer.ts";
import { Theme, type LoadedTheme } from "../src/theme.ts";
import { createGame, view } from "../src/pond-engine.ts";
import { BOARD_4P, OFFICIAL_RULES } from "../src/rules.ts";

// A stand-in pack. Deliberately incomplete: half the keys have no art, which
// is the case the palette fallback exists for.
function makeTheme(over: Partial<LoadedTheme> = {}): Theme {
  return new Theme({
    id: "t",
    name: "T",
    tileSize: 64,
    root: "/packs/t",
    sprites: {
      "tile.water": "board/water.png",
      "piece.player0": "pieces/p0.png",
      "hazard.primary": "pieces/hz.png",
    },
    strings: {},
    palette: { water: "#00f", player0: "#c00", highlight: "#ffd400" },
    ...over,
  });
}

function pieces(sprites: Sprite[]) {
  return sprites.filter((s) => s.kind === "piece");
}

describe("layout", () => {
  const game = createGame(7, BOARD_4P, OFFICIAL_RULES);

  it("converts grid coordinates to pixels via the theme tile size", () => {
    const scene = layout(view(game), makeTheme());
    expect(scene.tileSize).toBe(64);
    for (const s of scene.sprites) {
      expect(s.x).toBe(s.at.c * 64);
      expect(s.y).toBe(s.at.r * 64);
      expect(s.w).toBe(64);
    }
  });

  it("rescales everything when the pack uses a different tile size", () => {
    const v = view(game);
    const small = layout(v, makeTheme({ tileSize: 48 }));
    const big = layout(v, makeTheme({ tileSize: 96 }));
    expect(big.width).toBe(small.width * 2);
    expect(big.height).toBe(small.height * 2);
    expect(big.sprites).toHaveLength(small.sprites.length);
  });

  it("resolves art against the pack root and falls back to the palette", () => {
    const scene = layout(view(game), makeTheme());
    const water = scene.sprites.find((s) => s.key === "tile.water")!;
    expect(water.src).toBe("/packs/t/board/water.png");

    // No art for the start tiles in this pack — a colour block stands in.
    const start = scene.sprites.find((s) => s.key === "tile.start")!;
    expect(start.src).toBe(null);
    expect(typeof start.colour).toBe("string");
  });

  it("draws pieces above tiles and the hazard above pieces", () => {
    // The hazard is only on the board once it has been placed, so this one
    // uses a hand-built view that holds all four kinds at once.
    const v = view(game);
    const scene = layout(
      { ...v, hazard: { at: { r: 4, c: 4 }, spriteKey: "hazard.primary" } },
      makeTheme(),
      { highlights: [{ r: 4, c: 3 }] }
    );
    const z = (k: string) => scene.sprites.find((s) => s.kind === k)!.z;
    expect(z("tile") < z("piece")).toBe(true);
    expect(z("piece") < z("hazard")).toBe(true);
    // A highlight goes above the piece on the cell: on a hazard face every
    // legal cell is occupied, so one drawn underneath is one nobody sees.
    expect(z("piece") < z("highlight")).toBe(true);
    expect(z("highlight") < z("hazard")).toBe(true);
    // Sorted painter's order, so a plain append draws correctly.
    const zs = scene.sprites.map((s) => s.z);
    expect(zs.every((v, i) => i === 0 || zs[i - 1] <= v)).toBe(true);
  });

  it("emits a highlight per supplied coordinate and nothing more", () => {
    const v = view(game);
    const bare = layout(v, makeTheme());
    const lit = layout(v, makeTheme(), {
      highlights: [{ r: 1, c: 1 }, { r: 2, c: 2 }],
    });
    expect(lit.sprites.length - bare.sprites.length).toBe(2);
    const hi = lit.sprites.filter((s) => s.kind === "highlight");
    expect(hi).toHaveLength(2);
    expect(hi[0].key).toBe(HIGHLIGHT_KEY);
    expect(hi[0].x).toBe(64);
  });

  it("marks only the selected piece", () => {
    const v = view(game);
    const id = v.pieces[0].id;
    const scene = layout(v, makeTheme(), { selected: id });
    const chosen = pieces(scene.sprites).filter((s) => s.selected);
    expect(chosen).toHaveLength(1);
    expect(chosen[0].id).toBe(id);
  });

  it("marks the pieces the player may pick up", () => {
    const v = view(game);
    const ids = [v.pieces[0].id, v.pieces[1].id];
    const scene = layout(v, makeTheme(), { movable: ids });
    const marked = pieces(scene.sprites).filter((s) => s.movable);
    expect(marked).toHaveLength(2);
    expect(marked.map((s) => s.id).sort()).toEqual([...ids].sort());
    // Nothing is marked when nothing was passed.
    expect(pieces(layout(v, makeTheme()).sprites).some((s) => s.movable)).toBe(false);
  });

  it("draws a piece at the pending cell the caller supplies", () => {
    // Mid-leap the engine still has the piece on its pre-leap cell; the chain
    // so far lives in the UI's selection. The caller hands the landing over as
    // a plain coordinate, the same way it hands over highlights.
    const v = view(game);
    const id = v.pieces[0].id;
    const at = { r: 4, c: 4 };
    const scene = layout(v, makeTheme(), { pending: { piece: id, at }, selected: id });

    const moved = pieces(scene.sprites).find((s) => s.id === id)!;
    expect(moved.at).toEqual(at);
    expect(moved.x).toBe(4 * 64);
    expect(moved.y).toBe(4 * 64);
    expect(moved.selected).toBe(true);

    // Nothing else shifts: the pieces being leapt over stay where they are.
    const others = pieces(scene.sprites).filter((s) => s.id !== id);
    const before = pieces(layout(v, makeTheme()).sprites).filter((s) => s.id !== id);
    expect(others.map((s) => s.at)).toEqual(before.map((s) => s.at));
  });

  it("carries the highlight colour so paint never looks up a key", () => {
    const scene = layout(view(game), makeTheme());
    expect(scene.highlightColour).toBe("#ffd400");
  });

  it("leaves pieces upright unless the pack opts into rotation", () => {
    const v = view(game);
    expect(pieces(layout(v, makeTheme()).sprites).every((s) => s.rotation === 0)).toBe(true);
    const spun = pieces(layout(v, makeTheme({ rotatePieces: true })).sprites);
    expect(spun.some((s) => s.rotation !== 0)).toBe(true);
  });

  it("is pure — two layouts of the same state are identical", () => {
    const v = view(game);
    expect(layout(v, makeTheme()).sprites).toEqual(layout(v, makeTheme()).sprites);
  });
});

describe("rotationFor", () => {
  it("treats art as drawn facing row 0", () => {
    expect(rotationFor({ dr: -1, dc: 0 })).toBe(0);
    expect(rotationFor({ dr: 0, dc: 1 })).toBe(90);
    expect(rotationFor({ dr: 1, dc: 0 })).toBe(180);
    expect(rotationFor({ dr: 0, dc: 0 })).toBe(0);
  });
});

describe("paletteKeyFor", () => {
  it("strips the kind prefix", () => {
    expect(paletteKeyFor("piece.player3")).toBe("player3");
    expect(paletteKeyFor("tile.home.bench")).toBe("home.bench");
    expect(paletteKeyFor("overlay.highlight")).toBe("highlight");
  });
});

describe("coordAt", () => {
  const scene = layout(view(createGame(1, BOARD_4P, OFFICIAL_RULES)), makeTheme());

  it("inverts the layout maths", () => {
    expect(coordAt(scene, 0, 0)).toEqual({ r: 0, c: 0 });
    expect(coordAt(scene, 63, 63)).toEqual({ r: 0, c: 0 });
    expect(coordAt(scene, 64, 128)).toEqual({ r: 2, c: 1 });
  });

  it("returns null off the board", () => {
    expect(coordAt(scene, -1, 0)).toBe(null);
    expect(coordAt(scene, scene.width, 0)).toBe(null);
    expect(coordAt(scene, 0, scene.height)).toBe(null);
  });
});
