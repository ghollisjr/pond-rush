import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { layout, paint } from "../src/renderer.ts";
import { Theme, type LoadedTheme } from "../src/theme.ts";
import { applyMove, createGame, legalMoves, view, type Move } from "../src/pond-engine.ts";
import { BOARD_4P, OFFICIAL_RULES } from "../src/rules.ts";

// A DOM small enough to fit in the file that uses it. paint() only needs
// createElement, appendChild, remove, children, style and dataset, so this
// covers the real behaviour under test — which elements survive a redraw —
// without pulling a test-DOM dependency into a zero-dependency suite.
class FakeEl {
  style: Record<string, string> = {};
  dataset: Record<string, string | undefined> = {};
  children: FakeEl[] = [];
  parent: FakeEl | null = null;

  appendChild(child: FakeEl): void {
    child.parent = this;
    this.children.push(child);
  }
  remove(): void {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((c) => c !== this);
    }
    this.parent = null;
  }
}

function withFakeDom<T>(fn: (container: FakeEl) => T): T {
  const prior = (globalThis as any).document;
  (globalThis as any).document = { createElement: () => new FakeEl() };
  try {
    return fn(new FakeEl());
  } finally {
    (globalThis as any).document = prior;
  }
}

const theme = new Theme({
  id: "t",
  name: "T",
  tileSize: 32,
  root: "/p",
  sprites: { "tile.water": "w.png" },
  strings: {},
  palette: { water: "#00f", player0: "#c00" },
} as LoadedTheme);

const paintInto = (c: FakeEl, scene: ReturnType<typeof layout>) =>
  paint(c as unknown as HTMLElement, scene);

describe("paint", () => {
  const game = createGame(4, BOARD_4P, OFFICIAL_RULES);

  it("creates one element per sprite and sizes the container", () => {
    withFakeDom((c) => {
      const scene = layout(view(game), theme);
      paintInto(c, scene);
      expect(c.children).toHaveLength(scene.sprites.length);
      expect(c.style.width).toBe(`${scene.width}px`);
      expect(c.style.position).toBe("relative");
    });
  });

  it("positions by grid coordinate times tile size", () => {
    withFakeDom((c) => {
      const scene = layout(view(game), theme);
      paintInto(c, scene);
      for (const el of c.children) {
        expect(el.style.left).toBe(`${Number(el.dataset.c) * 32}px`);
        expect(el.style.top).toBe(`${Number(el.dataset.r) * 32}px`);
      }
    });
  });

  it("uses art when the pack has it and a colour block when it doesn't", () => {
    withFakeDom((c) => {
      paintInto(c, layout(view(game), theme));
      const water = c.children.find((el) => el.style.backgroundImage)!;
      expect(water.style.backgroundImage).toBe('url("/p/w.png")');

      const block = c.children.find((el) => !el.style.backgroundImage)!;
      expect(block.style.backgroundImage).toBe("");
      expect(block.style.backgroundColor).not.toBe("");
    });
  });

  it("keeps the palette colour behind art, so a missing file isn't a hole", () => {
    // A pack can name art it doesn't ship, and any URL can 404. If the image
    // replaced the fill, the board would go blank instead of degrading to the
    // art-less fallback.
    withFakeDom((c) => {
      paintInto(c, layout(view(game), theme));
      for (const el of c.children) {
        expect(el.style.backgroundColor).not.toBe("");
      }
      const water = c.children.find((el) => el.style.backgroundImage)!;
      expect(water.style.backgroundColor).toBe("#00f");
    });
  });

  it("draws a highlight over the piece standing on that cell", () => {
    // Every legal cell on a hazard face is an occupied one, so a highlight
    // painted under an opaque piece is a highlight nobody can see.
    withFakeDom((c) => {
      const v = view(game);
      const occupied = v.pieces[0].at;
      paintInto(c, layout(v, theme, { highlights: [occupied] }));

      const hi = c.children.find((el) => el.dataset.kind === "highlight")!;
      const piece = c.children.find((el) => el.dataset.piece === v.pieces[0].id)!;
      expect(Number(hi.style.zIndex) > Number(piece.style.zIndex)).toBe(true);
      // Translucent, so the piece still reads through the tint.
      expect(hi.style.opacity).toBe("0.55");
    });
  });

  it("reuses a moved piece's element rather than recreating it", () => {
    withFakeDom((c) => {
      let s = applyMove(game, { kind: "roll" });
      paintInto(c, layout(view(s), theme));

      const mover = legalMoves(s).find(
        (m): m is Extract<Move, { kind: "move" | "step" }> =>
          m.kind === "move" || m.kind === "step"
      );
      if (!mover) return;

      const before = c.children.find((el) => el.dataset.piece === mover.piece)!;
      s = applyMove(s, mover);
      paintInto(c, layout(view(s), theme));

      const after = c.children.find((el) => el.dataset.piece === mover.piece)!;
      expect(after).toBe(before); // same node — no refetch, no flicker
      expect(after.style.left).toBe(`${mover.to.c * 32}px`);
    });
  });

  it("removes elements for sprites that are gone", () => {
    withFakeDom((c) => {
      const v = view(game);
      paintInto(c, layout(v, theme, { highlights: [{ r: 1, c: 1 }, { r: 2, c: 2 }] }));
      const lit = c.children.length;

      paintInto(c, layout(v, theme));
      expect(c.children.length).toBe(lit - 2);
      expect(c.children.some((el) => el.dataset.kind === "highlight")).toBe(false);
    });
  });

  it("keeps a tile's palette block behind its art, but not a piece's", () => {
    withFakeDom((c) => {
      // This pack has art for the water tile and for player 0 only.
      const withArt = new Theme({
        id: "t",
        name: "T",
        tileSize: 32,
        root: "/p",
        sprites: { "tile.water": "w.png", "piece.player0": "p0.png" },
        strings: {},
        palette: { water: "#00f", player0: "#c00" },
      } as LoadedTheme);

      paintInto(c, layout(view(game), withArt));

      // A tile covers board area, so it keeps a block under its art: if the
      // art fails to load the cell is still drawn.
      const tile = c.children.find(
        (el) => el.dataset.kind === "tile" && el.style.backgroundImage
      )!;
      expect(tile.style.backgroundColor).toBe("#00f");

      // A piece sprite is a shape with transparent corners. A block behind it
      // would render as a square, so there must not be one.
      const piece = c.children.find(
        (el) => el.dataset.kind === "piece" && el.style.backgroundImage
      )!;
      expect(piece.style.backgroundColor).toBe("");

      // A piece with no art still falls back to its palette colour.
      const bare = c.children.find(
        (el) => el.dataset.kind === "piece" && !el.style.backgroundImage
      )!;
      expect(bare.style.backgroundColor).not.toBe("");
    });
  });

  it("rings a movable piece and a held one differently", () => {
    withFakeDom((c) => {
      const v = view(game);
      const held = v.pieces[0].id;
      const free = v.pieces[1].id;
      paintInto(c, layout(v, theme, { selected: held, movable: [free] }));

      const heldEl = c.children.find((el) => el.dataset.piece === held)!;
      const freeEl = c.children.find((el) => el.dataset.piece === free)!;
      const plainEl = c.children.find(
        (el) => el.dataset.piece && el.dataset.piece !== held && el.dataset.piece !== free
      )!;

      expect(heldEl.style.outline.includes("solid")).toBe(true);
      expect(freeEl.style.outline.includes("dashed")).toBe(true);
      expect(plainEl.style.outline).toBe("");
      // Never the piece's own colour, or the ring would vanish into it.
      expect(heldEl.style.outline.includes("#c00")).toBe(false);
    });
  });

  it("leaves only tiles clickable, so a piece never swallows a click", () => {
    withFakeDom((c) => {
      paintInto(c, layout(view(game), theme, { highlights: [{ r: 3, c: 3 }] }));
      for (const el of c.children) {
        const expected = el.dataset.kind === "tile" ? "auto" : "none";
        expect(el.style.pointerEvents).toBe(expected);
      }
    });
  });
});
