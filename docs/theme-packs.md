# Making a theme pack

A theme pack is a folder. It holds a `theme.json` and whatever art, text and
colours you want the board to use. The engine never knows what any of it means
— it emits abstract keys like `piece.player0`, and your pack decides whether
that is a frog, a robot, or a blue square.

Packs are loaded from your own disk through the **Theme folder** picker on the
page. Nothing is uploaded. Assets become `blob:` URLs in your browser and never
reach a server, so two people in the same match can run completely different
packs and neither the server nor the other player needs to know.

`web/theme/` in this repo is a complete, working pack. Copy it and edit.

## Quick start

```
my-pack/
  theme.json
  board/water.svg
  board/start.svg
  board/shore.svg
  board/rocks.svg
  board/bench.svg
  pieces/hazard.svg
  pieces/p0.svg  p1.svg  p2.svg  p3.svg
```

```json
{
  "id": "my-pack",
  "name": "My Pack",
  "author": "you",
  "tileSize": 64,
  "sprites": {
    "tile.water": "board/water.svg",
    "tile.start": "board/start.svg",
    "tile.home.shore": "board/shore.svg",
    "tile.home.rocks": "board/rocks.svg",
    "tile.home.bench": "board/bench.svg",
    "hazard.primary": "pieces/hazard.svg",
    "piece.player0": "pieces/p0.svg",
    "piece.player1": "pieces/p1.svg",
    "piece.player2": "pieces/p2.svg",
    "piece.player3": "pieces/p3.svg"
  },
  "strings": {
    "piece.singular": "frog",
    "piece.plural": "frogs",
    "hazard.primary": "heron",
    "action.move": "Hop",
    "action.leap": "Leapfrog",
    "action.hazard": "Heron",
    "zone.home": "home"
  },
  "palette": {
    "water": "#1d5a78",
    "highlight": "#ffd400",
    "player0": "#e05252",
    "player1": "#4fb36e",
    "player2": "#5b92de",
    "player3": "#e8b63a"
  }
}
```

Open the page, click **Theme folder**, pick `my-pack/`. Any problems are listed
next to the picker.

Paths in the manifest are relative to the pack folder. Absolute URLs
(`https:`, `data:`, `/…`) are passed through untouched.

## Manifest fields

| Field          | Required | Meaning                                                      |
| -------------- | -------- | ------------------------------------------------------------ |
| `id`           | yes      | Short identifier, unique among your packs.                    |
| `name`         | yes      | Display name.                                                 |
| `author`       | no       | Credit.                                                       |
| `tileSize`     | yes      | Board cell size in CSS pixels. Must be at least 8.            |
| `sprites`      | yes      | Abstract key → image path.                                    |
| `strings`      | yes      | Abstract key → display text.                                  |
| `palette`      | no       | Abstract key → CSS colour, used where art is missing.         |
| `sounds`       | no       | Accepted and rewritten, but nothing plays them yet.           |
| `pixelArt`     | no       | `true` keeps hard pixel edges when scaling. Default `false`.  |
| `rotatePieces` | no       | `true` turns a piece to face its direction of travel. Default `false`. |

`tileSize` is the only size that matters. Positions are grid coordinates
everywhere in the code, and the renderer multiplies by this number, so a pack
with chunky 96px tiles and one with flat 48px tiles both just work. Your images
are stretched to `tileSize`, whatever their natural dimensions.

Set `pixelArt: true` only for chunky raster art. On vector art it forces a
rasterise-then-scale that turns it to mush.

Set `rotatePieces: true` only if your pieces are drawn top-down. Art drawn in
profile looks wrong turned on its side, which is why the default is off.

## Required sprite keys

A pack that omits one of these still loads and still plays — the key falls
through to the built-in fallback, and the gap is reported next to the picker.

| Key               | What it is                                  |
| ----------------- | ------------------------------------------- |
| `tile.water`      | Open water, the bulk of the board.          |
| `tile.start`      | A starting cell.                            |
| `tile.home.shore` | Scoring cell, 1 point.                      |
| `tile.home.rocks` | Scoring cell, 2 points.                     |
| `tile.home.bench` | Scoring cell, 3 points.                     |
| `hazard.primary`  | The hazard that removes pieces.             |
| `piece.player0`   | Player 1's pieces.                          |
| `piece.player1`   | Player 2's pieces.                          |
| `piece.player2`   | Player 3's pieces.                          |
| `piece.player3`   | Player 4's pieces.                          |

### Optional sprite keys

| Key                 | What it is                                                |
| ------------------- | --------------------------------------------------------- |
| `overlay.highlight` | Art for a lit cell. Without it, a flat `highlight` colour. |
| `tile.void`         | Off-board cells. Never drawn by the standard boards.       |

Tile keys come from the **board legend**, not from a fixed list. A custom
variant that defines new grid tokens can introduce tile keys no pack has art
for — they fall through like anything else.

## Required string keys

| Key              | Used for                                               |
| ---------------- | ------------------------------------------------------ |
| `piece.singular` | "Pick a **frog**", "Bring back a **frog**".            |
| `piece.plural`   | "Your **frogs** that can act are ringed…".             |
| `hazard.primary` | The hazard's name, in prose.                           |
| `action.move`    | Label for a move face. "Hop".                          |
| `action.leap`    | Label for a leap face. "Leapfrog".                     |
| `action.hazard`  | Label for the hazard face.                             |
| `zone.home`      | The home area, in prose: "not already **home**".       |

### Optional string keys

`zone.shore`, `zone.rocks`, `zone.bench` name the scoring cells in the Rules
panel ("bench 3, rocks 2, shore 1"). Without them the raw key segment is used,
which usually reads fine.

Write `zone.home` so it works mid-sentence. "home" gives *"not already home"*;
"home shore" gives *"not already home shore"*, which reads wrong. This is a
real bug that shipped once.

## Palette keys

Colours are the fallback when a sprite is missing, and they are also used
directly for the HUD. A palette-only pack with no art at all is perfectly
valid — that is exactly what the built-in fallback is.

A palette key is the sprite key with its prefix removed: `tile.water` → `water`,
`piece.player0` → `player0`, `tile.home.bench` → `home.bench`,
`overlay.highlight` → `highlight`.

| Key                            | Used for                                   |
| ------------------------------ | ------------------------------------------ |
| `player0` … `player3`          | Piece fallback **and** the HUD score chips. |
| `highlight`                    | Lit cells, and the rings on selectable pieces. |
| `water`, `start`               | Tile fallbacks.                             |
| `home.shore`, `home.rocks`, `home.bench` | Scoring tile fallbacks.           |
| `primary`                      | Hazard fallback.                            |

Always supply `player0`–`player3` and `highlight` even in a fully-illustrated
pack: the HUD and the selection rings use them as colours, not as art.

## Drawing notes

**Pieces need transparent corners.** A tile always gets its palette colour
painted behind its art, because a tile whose art fails to load would leave a
hole in the board. A piece does not — a coloured square behind a frog renders
as a square. Draw pieces as shapes on transparency.

**Keep pieces readable at one cell.** They sit in a `tileSize` box, often
shoulder to shoulder with four others of the same colour. Strong outlines and
distinct silhouettes matter more than detail.

**The highlight tint sits on top.** Lit cells are drawn over pieces at 55%
opacity, so a piece under a highlight still has to read through a wash of your
`highlight` colour.

**Settled pieces are drawn more saturated.** A piece that has scored stays on
the board; the renderer brightens it rather than swapping the sprite.

## How falling back works

Lookups go: **your pack → the built-in fallback → the palette colour**. A pack
is never required to be complete, and a half-finished pack is still playable.

One rule catches out most people: **a sprite path with no matching file in the
picked folder is dropped at load.** It is not kept and requested from the
server — doing that once made every sprite URL resolve against the page, 404,
and paint a blank board. Dropped, the key simply has no art and falls back
properly, and the missing file is reported to you as a problem.

So if your art is not showing up, the likely cause is a path in `theme.json`
that does not match the file on disk. Check the problem list under the picker.

## Checklist

- [ ] `theme.json` at the top level of the folder you pick.
- [ ] Every path in `sprites` matches a real file, exactly, including case.
- [ ] All ten required sprite keys, or a deliberate choice to fall back.
- [ ] All seven required string keys; `zone.home` reads right mid-sentence.
- [ ] `player0`–`player3` and `highlight` in the palette.
- [ ] Pieces drawn on transparency; tiles opaque edge to edge.
- [ ] `pixelArt` set only for raster art, `rotatePieces` only for top-down art.
- [ ] Loaded it and seen an empty problem list under the picker.

## Licensing

Ship art you have the right to ship. The default pack in `web/theme/` is
original work and is the only pack in this repository, deliberately: packs that
reproduce someone else's look stay on the machine of whoever made them, which
is why the loader is local-folder-only and nothing is ever uploaded.
