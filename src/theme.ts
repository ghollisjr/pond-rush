// ============================================================================
// theme.ts
//
// Themes are resource packs. The engine emits abstract keys ("piece.player0",
// "tile.home.bench"); a theme maps those keys to art, strings, sounds and
// colours. Nothing in the engine ever names a theme-specific thing.
//
// Themes load client-side only. A theme never goes near the server, so two
// players in the same match can run different packs and neither the server
// nor the other client needs to know.
// ============================================================================

export interface ThemeManifest {
  id: string;
  name: string;
  author?: string;
  /** Rendered size of one board cell, in CSS pixels. */
  tileSize: number;
  /**
   * Chunky raster art: the renderer keeps hard pixel edges when scaling it to
   * tileSize. Off by default, because it turns vector art to mush.
   */
  pixelArt?: boolean;
  /**
   * Whether the renderer may rotate a piece to face its direction of travel.
   * Off by default: art drawn in profile looks wrong turned on its side, so a
   * pack opts in only if its pieces are drawn top-down.
   */
  rotatePieces?: boolean;
  /** Abstract key -> asset path, relative to the theme root. */
  sprites: Record<string, string>;
  /** Abstract key -> display text. */
  strings: Record<string, string>;
  sounds?: Record<string, string>;
  palette?: Record<string, string>;
}

export interface LoadedTheme extends ThemeManifest {
  /** Where assets resolve against. A blob: URL for user-supplied packs. */
  root: string;
}

/**
 * Keys the renderer may ask for. Listed so a theme editor can show what still
 * needs art, and so missing-asset warnings are useful rather than cryptic.
 */
export const REQUIRED_SPRITE_KEYS = [
  "tile.water",
  "tile.start",
  "tile.home.shore",
  "tile.home.rocks",
  "tile.home.bench",
  "hazard.primary",
  "piece.player0",
  "piece.player1",
  "piece.player2",
  "piece.player3",
] as const;

export const REQUIRED_STRING_KEYS = [
  "piece.singular",
  "piece.plural",
  "hazard.primary",
  "action.move",
  "action.leap",
  "action.hazard",
  "zone.home",
] as const;

export function validateTheme(t: ThemeManifest): string[] {
  const problems: string[] = [];
  if (!t.id) problems.push("Theme has no id.");
  if (!t.name) problems.push("Theme has no name.");
  if (!t.tileSize || t.tileSize < 8) problems.push("tileSize looks wrong.");
  for (const k of REQUIRED_SPRITE_KEYS) {
    if (!t.sprites?.[k]) problems.push(`Missing sprite for "${k}".`);
  }
  for (const k of REQUIRED_STRING_KEYS) {
    if (!t.strings?.[k]) problems.push(`Missing string for "${k}".`);
  }
  return problems;
}

/**
 * Lookup with fallback. A theme that's missing a key degrades to the built-in
 * default rather than crashing the board.
 */
export class Theme {
  private theme: LoadedTheme;
  private fallback: LoadedTheme | null;

  constructor(theme: LoadedTheme, fallback: LoadedTheme | null = null) {
    this.theme = theme;
    this.fallback = fallback;
  }

  get id(): string {
    return this.theme.id;
  }
  get tileSize(): number {
    return this.theme.tileSize || this.fallback?.tileSize || 64;
  }
  get pixelArt(): boolean {
    return this.theme.pixelArt ?? this.fallback?.pixelArt ?? false;
  }
  get rotatePieces(): boolean {
    return this.theme.rotatePieces ?? this.fallback?.rotatePieces ?? false;
  }

  sprite(key: string): string | null {
    const own = this.theme.sprites?.[key];
    if (own) return join(this.theme.root, own);
    const fb = this.fallback?.sprites?.[key];
    return fb ? join(this.fallback!.root, fb) : null;
  }

  text(key: string, fallbackText = ""): string {
    return this.theme.strings?.[key] ?? this.fallback?.strings?.[key] ?? fallbackText;
  }

  sound(key: string): string | null {
    const own = this.theme.sounds?.[key];
    if (own) return join(this.theme.root, own);
    const fb = this.fallback?.sounds?.[key];
    return fb ? join(this.fallback!.root, fb) : null;
  }

  colour(key: string, fallbackColour = "#888"): string {
    return this.theme.palette?.[key] ?? this.fallback?.palette?.[key] ?? fallbackColour;
  }
}

function join(root: string, path: string): string {
  if (/^(https?:|blob:|data:|\/)/.test(path)) return path;
  return `${root.replace(/\/$/, "")}/${path}`;
}

/** Load a theme served from a URL (the built-in pack). */
export async function loadThemeFromUrl(root: string): Promise<LoadedTheme> {
  const res = await fetch(`${root.replace(/\/$/, "")}/theme.json`);
  if (!res.ok) throw new Error(`Couldn't load theme from ${root}`);
  const manifest = (await res.json()) as ThemeManifest;
  const problems = validateTheme(manifest);
  if (problems.length) console.warn("Theme issues:", problems);
  return { ...manifest, root };
}

/**
 * Load a theme from a folder the user picked on their own machine. Assets
 * become blob: URLs, so nothing is uploaded anywhere.
 */
export async function loadThemeFromFiles(files: FileList | File[]): Promise<LoadedTheme> {
  const list = Array.from(files);
  const manifestFile = list.find((f) => f.name === "theme.json");
  if (!manifestFile) throw new Error("No theme.json in that folder.");

  const manifest = JSON.parse(await manifestFile.text()) as ThemeManifest;

  // Rewrite every asset path to a blob URL for the matching file.
  const byName = new Map<string, File>();
  for (const f of list) {
    const rel = (f as any).webkitRelativePath || f.name;
    byName.set(rel.split("/").slice(1).join("/") || f.name, f);
  }

  // A path the picked folder has no file for is dropped rather than kept:
  // keeping it would hand the renderer a URL that resolves against the page,
  // 404s, and paints nothing. Dropped, the key simply has no art, so the
  // fallback pack and then the palette take over — and validateTheme reports
  // it as a missing sprite, which is what the person who picked it needs to
  // be told.
  const rewrite = (map: Record<string, string> | undefined) => {
    if (!map) return map;
    const out: Record<string, string> = {};
    for (const [k, path] of Object.entries(map)) {
      const file = byName.get(path);
      if (file) out[k] = URL.createObjectURL(file);
    }
    return out;
  };

  return {
    ...manifest,
    sprites: rewrite(manifest.sprites) ?? {},
    sounds: rewrite(manifest.sounds),
    root: "",
  };
}
