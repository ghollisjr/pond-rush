// ============================================================================
// rules.ts
//
// Everything about HOW the game plays, separated from the engine that plays it.
//
// Two tiers of variant, deliberately:
//
//   Tier 1 — data variants. A JSON patch over a base ruleset. Fully
//            serializable, so users can build them in a UI, save them, and
//            send them to each other as a string. Covers anything expressible
//            as "different numbers / different flags / different board".
//
//   Tier 2 — code variants. Registered modules with custom hooks, for
//            mechanics the schema can't express. Referenced by id, not
//            shareable as pure data.
//
// Start by trying to express a new variant in tier 1. All three published
// variants fit there, including the one that reshapes the board.
// ============================================================================

export const SCHEMA_VERSION = 2;

export interface Coord {
  r: number;
  c: number;
}

// ---------------------------------------------------------------------------
// Board
//
// The board is a token grid. Each cell may be unplayable, may be a scoring
// cell belonging to a player (or shared), and may be a starting cell. A single
// cell can be more than one of those, so tokens compose with "+".
//
// Tokens in the default legend:
//   .        open water
//   #        not part of the board
//   S0..S3   starting cell for player n
//   H0s      home shore  for player n  (1 point)
//   H0r      home rocks  for player n  (2 points)
//   H0b      home bench  for player n  (3 points)
//   Xs Xr Xb shared home cells, scoring for whoever rests there
// ---------------------------------------------------------------------------

export interface CellDef {
  playable: boolean;
  /** Scoring cell. `owner` is a player index, or "any" when shared. */
  home?: { owner: number | "any"; points: number };
  start?: { owner: number };
  /** Abstract key handed to the theme. Never a filename. */
  tileKey: string;
}

export interface BoardSpec {
  playerCount: number;
  piecesPerPlayer: number;
  /** Rows of whitespace-separated tokens. */
  grid: string[];
  /** Token -> cell. Tokens may be composed with "+" (e.g. "H2s+S0"). */
  legend: Record<string, CellDef>;
}

export const DEFAULT_LEGEND: Record<string, CellDef> = {
  ".": { playable: true, tileKey: "tile.water" },
  "#": { playable: false, tileKey: "tile.void" },
  ...buildPlayerTokens(),
  Xs: { playable: true, home: { owner: "any", points: 1 }, tileKey: "tile.home.shore" },
  Xr: { playable: true, home: { owner: "any", points: 2 }, tileKey: "tile.home.rocks" },
  Xb: { playable: true, home: { owner: "any", points: 3 }, tileKey: "tile.home.bench" },
};

function buildPlayerTokens(): Record<string, CellDef> {
  const out: Record<string, CellDef> = {};
  for (let p = 0; p < 4; p++) {
    out[`S${p}`] = {
      playable: true,
      start: { owner: p },
      tileKey: "tile.start",
    };
    out[`H${p}s`] = {
      playable: true,
      home: { owner: p, points: 1 },
      tileKey: "tile.home.shore",
    };
    out[`H${p}r`] = {
      playable: true,
      home: { owner: p, points: 2 },
      tileKey: "tile.home.rocks",
    };
    out[`H${p}b`] = {
      playable: true,
      home: { owner: p, points: 3 },
      tileKey: "tile.home.bench",
    };
  }
  return out;
}

/** Resolves one grid token, merging the parts of a composed token. */
export function resolveToken(
  token: string,
  legend: Record<string, CellDef>
): CellDef {
  const parts = token.split("+");
  let out: CellDef = { playable: false, tileKey: "tile.void" };
  for (const part of parts) {
    const def = legend[part];
    if (!def) throw new Error(`Unknown board token "${part}"`);
    out = {
      playable: out.playable || def.playable,
      home: def.home ?? out.home,
      start: def.start ?? out.start,
      // Home art wins over start art when a cell is both.
      tileKey: def.home ? def.tileKey : out.home ? out.tileKey : def.tileKey,
    };
  }
  return out;
}

export function gridRows(board: BoardSpec): string[][] {
  return board.grid.map((row) => row.trim().split(/\s+/));
}

// ---------------------------------------------------------------------------
// Boards
//
// [PROVISIONAL] The rules text confirms the structure — each player crosses
// the pond to a home shore with rocks and a bench, worth 1/2/3 points — but
// not the exact dimensions. Only these constants need editing if the real
// board differs; nothing else depends on their shape.
//
// One invariant worth preserving in any board you draw: scoring cells are
// terminal, so they must sit on the outside edge. If a player's only route
// out of their start runs through someone else's home row, that player can be
// walled in permanently once the row fills up. `validate()` checks for this.
// ---------------------------------------------------------------------------

/**
 * Standard four-player pond. A 5x5 stretch of water, each player starting in
 * the water on their own side and crossing to the scoring cells opposite.
 *
 *   row 0  player 0's home     shore rocks bench rocks shore
 *   row 1  player 2 starts
 *   row 7  player 0 starts
 *   row 8  player 2's home
 *   col 0  player 3's home     col 1  player 1 starts
 *   col 7  player 3 starts     col 8  player 1's home
 */
export const BOARD_4P: BoardSpec = {
  playerCount: 4,
  piecesPerPlayer: 5,
  legend: DEFAULT_LEGEND,
  grid: [
    "#    #   H0s H0r H0b H0r H0s #   #  ",
    "#    .   S2  S2  S2  S2  S2  .   #  ",
    "H3s  S1  .   .   .   .   .   S3  H1s",
    "H3r  S1  .   .   .   .   .   S3  H1r",
    "H3b  S1  .   .   .   .   .   S3  H1b",
    "H3r  S1  .   .   .   .   .   S3  H1r",
    "H3s  S1  .   .   .   .   .   S3  H1s",
    "#    .   S0  S0  S0  S0  S0  .   #  ",
    "#    #   H2s H2r H2b H2r H2s #   #  ",
  ],
};

/** Two players facing each other across the same pond. */
export const BOARD_2P: BoardSpec = {
  playerCount: 2,
  piecesPerPlayer: 5,
  legend: DEFAULT_LEGEND,
  grid: [
    "#  H0s H0r H0b H0r H0s #",
    "#  S1  S1  S1  S1  S1  #",
    ".  .   .   .   .   .   .",
    "#  S0  S0  S0  S0  S0  #",
    "#  H1s H1r H1b H1r H1s #",
  ],
};

/**
 * Triple Trouble. All three families start on the same side, and the home
 * shore, rocks and bench are shared by everyone — so the high-scoring cells
 * are contested rather than private. [PROVISIONAL] dimensions.
 */
export const BOARD_3P: BoardSpec = {
  playerCount: 3,
  piecesPerPlayer: 5,
  legend: DEFAULT_LEGEND,
  grid: [
    "#   Xr  Xr  Xb  Xb  Xb  Xr  Xr  #  ",
    "Xs  Xs  Xs  Xs  Xs  Xs  Xs  Xs  Xs ",
    ".   .   .   .   .   .   .   .   .  ",
    ".   .   .   .   .   .   .   .   .  ",
    ".   .   .   .   .   .   .   .   .  ",
    ".   .   .   .   .   .   .   .   .  ",
    ".   .   .   .   .   .   .   .   .  ",
    "S0  S0  S0  S1  S1  S1  S2  S2  S2 ",
    "S0  S0  S0  S1  S1  S1  S2  S2  S2 ",
  ],
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type DieFace =
  | { kind: "move"; spaces: number }
  | { kind: "leap" }
  | { kind: "hazard" };

export interface RuleSet {
  die: DieFace[];

  movement: {
    /** Eight-way movement. The printed rules allow diagonals. */
    diagonals: boolean;
    /** Restricting travel direction is a variant, not the standard game. */
    restrict: "none" | "no_backward" | "forward_only";
    /** Hop Share: split a roll's spaces between several pieces. */
    shareMoves: boolean;
  };

  leap: {
    diagonals: boolean;
    /** Keep jumping with the same piece until you can't or choose to stop. */
    chaining: boolean;
    overOwnOnly: boolean;
    /** You may always decline to jump and move one piece a single space. */
    declineToStep: boolean;
    canLeapHazard: boolean;
    /**
     * [PROVISIONAL] Jump over an empty space as well as over a piece — the
     * cell being cleared need hold nothing at all. See the Gap Jump variant.
     */
    overGaps: boolean;
  };

  hazard: {
    enabled: boolean;
    placement: "any_occupied" | "any_cell" | "within_range";
    range: number;
    /** capture removes permanently; reset returns the piece to its start. */
    effect: "capture" | "reset";
    blocksCell: boolean;
    /** Pieces already home can't be taken. */
    homeIsSafe: boolean;
  };

  /** Stork Escape: skip your rolled action to return one eaten piece. */
  rescue: {
    enabled: boolean;
    maxPerGame: number | null;
  };

  victory: {
    /** The printed game ends the moment any one player has no pieces left. */
    endWhen: "any_player_settled" | "all_players_settled";
    tiebreak: "shared" | "first_player";
  };

  /** Tier 2 hook module ids, resolved against the code-variant registry. */
  modules: string[];
}

export const OFFICIAL_RULES: RuleSet = {
  die: [
    { kind: "move", spaces: 1 },
    { kind: "move", spaces: 2 },
    { kind: "move", spaces: 3 },
    { kind: "leap" },
    { kind: "leap" },
    { kind: "hazard" },
  ],
  movement: { diagonals: true, restrict: "none", shareMoves: false },
  leap: {
    diagonals: true,
    chaining: true,
    overOwnOnly: false,
    declineToStep: true,
    canLeapHazard: false,
    overGaps: false,
  },
  hazard: {
    enabled: true,
    placement: "any_occupied",
    range: 0,
    effect: "capture",
    blocksCell: true,
    homeIsSafe: true,
  },
  rescue: { enabled: false, maxPerGame: null },
  victory: { endWhen: "any_player_settled", tiebreak: "shared" },
  modules: [],
};

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export interface VariantDef {
  id: string;
  name: string;
  description: string;
  /** Base variant id, or null for a root. Patches layer down the chain. */
  extends: string | null;
  rules?: DeepPartial<RuleSet>;
  /** Board replacement. Grids don't merge sensibly, so this swaps wholesale. */
  board?: BoardSpec;
  meta?: {
    schemaVersion: number;
    author?: string;
    createdAt: string;
    updatedAt: string;
  };
}

export const BUILT_IN_VARIANTS: VariantDef[] = [
  {
    id: "standard-4p",
    name: "Standard (4 players)",
    description: "The printed rules. Four families crossing a shared pond.",
    extends: null,
  },
  {
    id: "standard-2p",
    name: "Standard (2 players)",
    description: "Two families facing each other across the pond.",
    extends: "standard-4p",
    board: BOARD_2P,
  },
  {
    id: "triple-trouble",
    name: "Triple Trouble",
    description:
      "Three players. Everyone starts on the same side and the home shore, " +
      "rocks and bench are shared — so the high-scoring cells are contested.",
    extends: "standard-4p",
    board: BOARD_3P,
  },
  {
    id: "hop-share",
    name: "Hop Share",
    description:
      "Split a roll between several pieces. Roll a three and you can move " +
      "one piece one space and another two, or three pieces one space each.",
    extends: "standard-4p",
    rules: { movement: { shareMoves: true } },
  },
  {
    id: "stork-escape",
    name: "Stork Escape",
    description:
      "Skip your rolled action to bring one eaten piece back to your " +
      "starting bench. Recommended — without it a run of bad luck can take " +
      "a player out of the game with nothing they can do about it.",
    extends: "standard-4p",
    rules: { rescue: { enabled: true } },
  },
  {
    id: "gap-jump",
    name: "Gap Jump",
    description:
      "The leap may clear an empty space as well as a piece, so you can jump " +
      "a one-space gap with nothing in it. Makes a leap face always useful " +
      "and turns open water into a road.",
    extends: "standard-4p",
    rules: { leap: { overGaps: true } },
  },
  {
    id: "house",
    name: "House Rules",
    description: "Hop Share and Stork Escape together.",
    extends: "stork-escape",
    rules: { movement: { shareMoves: true } },
  },
];

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] =
      isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v as any) : v;
  }
  return out as T;
}

export class VariantRegistry {
  private variants = new Map<string, VariantDef>();

  constructor(seed: VariantDef[] = BUILT_IN_VARIANTS) {
    seed.forEach((v) => this.variants.set(v.id, v));
  }

  add(v: VariantDef): void {
    this.variants.set(v.id, v);
  }
  remove(id: string): void {
    this.variants.delete(id);
  }
  get(id: string): VariantDef | undefined {
    return this.variants.get(id);
  }
  list(): VariantDef[] {
    return [...this.variants.values()];
  }

  /** Walks the extends chain and folds every patch into a concrete config. */
  resolve(id: string): { rules: RuleSet; board: BoardSpec; def: VariantDef } {
    const chain: VariantDef[] = [];
    const seen = new Set<string>();

    let cursor: string | null = id;
    while (cursor) {
      if (seen.has(cursor)) throw new Error(`Circular variant chain at "${cursor}"`);
      seen.add(cursor);
      const v = this.variants.get(cursor);
      if (!v) throw new Error(`Unknown variant "${cursor}"`);
      chain.unshift(v);
      cursor = v.extends;
    }

    let rules = OFFICIAL_RULES;
    let board = BOARD_4P;
    for (const v of chain) {
      rules = deepMerge(rules, v.rules);
      if (v.board) board = v.board;
    }
    return { rules, board, def: chain[chain.length - 1] };
  }
}

// ---------------------------------------------------------------------------
// Validation — run before anyone plays a custom ruleset
// ---------------------------------------------------------------------------

export interface Issue {
  level: "error" | "warning";
  field: string;
  message: string;
}

export function validate(rules: RuleSet, board: BoardSpec): Issue[] {
  const issues: Issue[] = [];
  const err = (field: string, message: string) =>
    issues.push({ level: "error", field, message });
  const warn = (field: string, message: string) =>
    issues.push({ level: "warning", field, message });

  // --- board ---
  let rows: string[][];
  try {
    rows = gridRows(board);
  } catch {
    err("board.grid", "Grid could not be read.");
    return issues;
  }

  if (rows.length === 0) {
    err("board.grid", "Board has no rows.");
    return issues;
  }
  const width = rows[0].length;
  if (rows.some((r) => r.length !== width)) {
    err("board.grid", "All rows must have the same number of tokens.");
  }

  const starts = new Map<number, number>();
  const homes = new Map<number | "any", number>();
  for (const row of rows) {
    for (const token of row) {
      let cell: CellDef;
      try {
        cell = resolveToken(token, board.legend);
      } catch (e) {
        err("board.legend", (e as Error).message);
        continue;
      }
      if (cell.start) {
        starts.set(cell.start.owner, (starts.get(cell.start.owner) ?? 0) + 1);
      }
      if (cell.home) {
        homes.set(cell.home.owner, (homes.get(cell.home.owner) ?? 0) + 1);
      }
    }
  }

  if (board.playerCount < 2) err("board.playerCount", "Need at least 2 players.");
  if (board.piecesPerPlayer < 1) {
    err("board.piecesPerPlayer", "Each player needs at least one piece.");
  }

  for (let p = 0; p < board.playerCount; p++) {
    const s = starts.get(p) ?? 0;
    if (s < board.piecesPerPlayer) {
      err(
        "board.grid",
        `Player ${p + 1} has ${s} starting cells but ${board.piecesPerPlayer} pieces.`
      );
    }
    const h = (homes.get(p) ?? 0) + (homes.get("any") ?? 0);
    if (h === 0) {
      err("board.grid", `Player ${p + 1} has nowhere to score.`);
    } else if (h < board.piecesPerPlayer) {
      warn(
        "board.grid",
        `Player ${p + 1} has ${h} scoring cells for ${board.piecesPerPlayer} pieces — some can never be banked.`
      );
    }
  }

  // --- reachability ---
  // Scoring cells are terminal: a piece that reaches one settles and never
  // moves again. So a route that only exists through someone else's scoring
  // cells isn't a route — it closes as those cells fill. Check that each
  // player can reach their own scoring cells without relying on one.
  for (let p = 0; p < board.playerCount; p++) {
    if (!canReachHome(rows, board.legend, p)) {
      err(
        "board.grid",
        `Player ${p + 1} can't reach their scoring cells except through cells ` +
          `that fill up permanently. They can be walled in.`
      );
    }
  }

  // --- die ---
  if (rules.die.length === 0) err("die", "The die needs at least one face.");
  rules.die.forEach((f, i) => {
    if (f.kind === "move" && f.spaces < 1) {
      err(`die[${i}]`, "A move face must be worth at least one space.");
    }
  });

  const canAdvance =
    rules.die.some((f) => f.kind === "move") ||
    (rules.die.some((f) => f.kind === "leap") && rules.leap.declineToStep);
  if (!canAdvance) {
    err("die", "No face lets a piece advance — the game could never end.");
  }

  if (rules.movement.restrict === "forward_only" && !rules.movement.diagonals) {
    warn(
      "movement",
      "Forward-only without diagonals means a blocked piece is stuck for good."
    );
  }

  // --- hazard ---
  if (rules.hazard.enabled && rules.hazard.placement === "within_range" && rules.hazard.range < 1) {
    err("hazard.range", "Ranged placement needs a range of at least 1.");
  }
  if (rules.hazard.enabled && rules.hazard.effect === "capture" && !rules.rescue.enabled) {
    warn(
      "rescue.enabled",
      "Captures are permanent with no way back, so a player can be knocked " +
        "out by other people's dice rolls. Consider enabling Stork Escape."
    );
  }
  const hazardFaces = rules.die.filter((f) => f.kind === "hazard").length;
  if (rules.die.length && hazardFaces / rules.die.length > 0.34) {
    warn("die", "More than a third of rolls move the hazard. Expect carnage.");
  }

  return issues;
}

export function isPlayable(rules: RuleSet, board: BoardSpec): boolean {
  return !validate(rules, board).some((i) => i.level === "error");
}

/**
 * Flood fill from a player's starting cells across playable, non-terminal
 * cells, and check at least one of their scoring cells is adjacent to the
 * region reached. Eight-way, matching the widest movement the rules allow.
 */
function canReachHome(
  rows: string[][],
  legend: Record<string, CellDef>,
  player: number
): boolean {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const cells: (CellDef | null)[][] = rows.map((row) =>
    row.map((token) => {
      try {
        return resolveToken(token, legend);
      } catch {
        return null;
      }
    })
  );

  const isMine = (cell: CellDef | null) =>
    !!cell?.home && (cell.home.owner === "any" || cell.home.owner === player);
  /** Traversable: playable, and not a scoring cell for anyone. */
  const open = (cell: CellDef | null) => !!cell?.playable && !cell.home;

  const queue: Coord[] = [];
  const seen = new Set<string>();
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (cells[r][c]?.start?.owner === player) {
        queue.push({ r, c });
        seen.add(`${r},${c}`);
      }
    }
  }
  if (queue.length === 0) return false;

  const dirs = [-1, 0, 1];
  while (queue.length) {
    const { r, c } = queue.shift()!;
    for (const dr of dirs) {
      for (const dc of dirs) {
        if (!dr && !dc) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= height || nc >= width) continue;
        const cell = cells[nr][nc];
        if (isMine(cell)) return true;
        if (!open(cell)) continue;
        const k = `${nr},${nc}`;
        if (seen.has(k)) continue;
        seen.add(k);
        queue.push({ r: nr, c: nc });
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sharing — a variant travels as a single JSON string
// ---------------------------------------------------------------------------

export function exportVariant(v: VariantDef): string {
  return JSON.stringify(
    {
      ...v,
      meta: {
        schemaVersion: SCHEMA_VERSION,
        createdAt: v.meta?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        author: v.meta?.author,
      },
    },
    null,
    2
  );
}

export function importVariant(json: string): VariantDef {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("That doesn't look like a variant file.");
  }
  if (!parsed?.id || !parsed?.name) {
    throw new Error("Variant is missing an id or a name.");
  }
  const version = parsed.meta?.schemaVersion ?? 0;
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `This variant was made with a newer version of the game (v${version}).`
    );
  }
  return migrate(parsed, version);
}

/** Add a case per schema bump so old saved variants keep working. */
function migrate(v: any, from: number): VariantDef {
  let out = v;
  if (from < 2) {
    // v1 boards were {size, layout, blockedCells}; v1 movement had
    // allowForward/allowLateral/allowBackward instead of restrict.
    if (out.board && "size" in out.board) delete out.board;
    if (out.rules?.movement) {
      const m = out.rules.movement;
      out.rules.movement = {
        diagonals: true,
        restrict: m.allowBackward === false ? "no_backward" : "none",
        shareMoves: false,
      };
    }
  }
  return { ...out, meta: { ...out.meta, schemaVersion: SCHEMA_VERSION } };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface VariantStore {
  list(): Promise<VariantDef[]>;
  save(v: VariantDef): Promise<void>;
  delete(id: string): Promise<void>;
}

export class MemoryVariantStore implements VariantStore {
  private data = new Map<string, VariantDef>();
  async list() {
    return [...this.data.values()];
  }
  async save(v: VariantDef) {
    this.data.set(v.id, v);
  }
  async delete(id: string) {
    this.data.delete(id);
  }
}

/** Reference adapter. Swap for your server when variants go multiplayer. */
export class LocalVariantStore implements VariantStore {
  private prefix: string;

  constructor(prefix = "pond.variant.") {
    this.prefix = prefix;
  }

  async list(): Promise<VariantDef[]> {
    const out: VariantDef[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(this.prefix)) continue;
      try {
        out.push(importVariant(localStorage.getItem(k)!));
      } catch {
        // Skip corrupt entries rather than breaking the whole variant list.
      }
    }
    return out;
  }

  async save(v: VariantDef): Promise<void> {
    localStorage.setItem(this.prefix + v.id, exportVariant(v));
  }

  async delete(id: string): Promise<void> {
    localStorage.removeItem(this.prefix + id);
  }
}

/** Fork any variant into an editable user copy. */
export function fork(base: VariantDef, name: string, author?: string): VariantDef {
  const now = new Date().toISOString();
  return {
    id: `user-${crypto.randomUUID()}`,
    name,
    description: `Based on ${base.name}.`,
    extends: base.id,
    rules: {},
    meta: { schemaVersion: SCHEMA_VERSION, author, createdAt: now, updatedAt: now },
  };
}
