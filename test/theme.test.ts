import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { Theme, loadThemeFromFiles, validateTheme } from "../src/theme.ts";
import { PLAIN_THEME } from "../src/ui/default-theme.ts";

// The blob: URLs a picked pack turns its files into only exist in a browser;
// the stub is enough for the bookkeeping under test — which paths survive.
async function withObjectUrls<T>(fn: () => Promise<T>): Promise<T> {
  const prior = (globalThis as any).URL.createObjectURL;
  (globalThis as any).URL.createObjectURL = (f: File) => `blob:${f.name}`;
  try {
    return await fn();
  } finally {
    (globalThis as any).URL.createObjectURL = prior;
  }
}

const MANIFEST = {
  id: "pack",
  name: "Pack",
  tileSize: 64,
  sprites: {
    "tile.water": "board/water.png",
    "piece.player0": "pieces/p0.png",
  },
  strings: { "piece.singular": "piece" },
  palette: { water: "#123456" },
};

function folder(extra: { path: string; body: string }[] = []): File[] {
  const files = [
    new File([JSON.stringify(MANIFEST)], "theme.json") as File & {
      webkitRelativePath?: string;
    },
  ];
  Object.defineProperty(files[0], "webkitRelativePath", { value: "pack/theme.json" });
  for (const e of extra) {
    const f = new File([e.body], e.path.split("/").pop()!);
    Object.defineProperty(f, "webkitRelativePath", { value: `pack/${e.path}` });
    files.push(f as any);
  }
  return files;
}

describe("loadThemeFromFiles", () => {
  it("keeps only the sprites the picked folder actually ships", async () => {
    const loaded = await withObjectUrls(() =>
      loadThemeFromFiles(folder([{ path: "board/water.png", body: "x" }]))
    );

    // The file that exists becomes a blob: URL...
    expect(loaded.sprites["tile.water"]).toBe("blob:water.png");
    // ...and the one that doesn't is dropped, rather than kept as a path that
    // would resolve against the page and 404 into a blank cell.
    expect("piece.player0" in loaded.sprites).toBe(false);
  });

  it("degrades a manifest-only pack to the fallback rather than to nothing", async () => {
    const loaded = await withObjectUrls(() => loadThemeFromFiles(folder()));
    const theme = new Theme(loaded, PLAIN_THEME);

    // No art anywhere, so every key falls through to the palette block.
    expect(theme.sprite("tile.water")).toBe(null);
    expect(theme.sprite("piece.player0")).toBe(null);
    // The pack's own palette and the fallback's still apply.
    expect(theme.colour("water")).toBe("#123456");
    expect(theme.colour("player0")).toBe(PLAIN_THEME.palette!.player0);
  });

  it("leaves the missing art visible to validateTheme, so it can be reported", async () => {
    const loaded = await withObjectUrls(() => loadThemeFromFiles(folder()));
    const problems = validateTheme(loaded);
    expect(problems.some((p) => p.includes('"tile.water"'))).toBe(true);
    expect(problems.some((p) => p.includes('"piece.player0"'))).toBe(true);
  });
});
