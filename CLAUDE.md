# Context for Claude Code

Read this before changing anything. It records decisions that aren't obvious
from the code and would be easy to undo by accident.

## What this is

A board game where pieces cross a pond to a scoring shore while a hazard eats
them. It's a reimplementation of a published game's mechanics so a group of
friends can play online. Two hard requirements shaped the design: rules must be
customisable and saveable by users, and the art must be swappable so a private
skin can be dropped in without touching the codebase.

## Invariants — don't break these

**The engine contains no theme vocabulary.** No "frog", no "stork", no "lily
pad", in identifiers, strings, or comments. The engine deals in pieces,
hazards, and tiles. `view(state)` emits abstract keys like `piece.player0` and
`tile.home.bench`; themes resolve them. If you find yourself writing a
theme-specific word in `src/pond-engine.ts` or `src/rules.ts`, the abstraction
has sprung a leak.

**The engine stays pure.** `applyMove` returns new state and never mutates,
never does I/O, never touches the DOM. Undo, server validation, and replay all
depend on this.

**Clients never roll dice.** Faces come from `rollAt(seed, rollCount)`. The
server holds the seed, validates every move through `applyMove`, and pushes
results. A client that can roll is a client that can cheat.

**Themes stay client-side.** Never upload a theme, never store one server-side,
never put theme assets in the repo beyond the original default. This is both an
architectural choice and a legal one.

`web/theme/` *is* that one default pack — generated SVG programmer art, served
next to the page and loaded at boot by `loadThemeFromUrl`. It is the default,
not a requirement: `PLAIN_THEME` sits behind it, the fetch is fired after the
first paint, and a failure costs the board its art and nothing else. Flavoured
packs still arrive at runtime through the folder picker and never land here.
`src/themes/lilypad/theme.json` is kept deliberately art-less as a fixture for
the manifest-with-no-files case that once blanked the board.

`docs/theme-packs.md` is the authoring guide for packs. Its key tables are
asserted against `REQUIRED_SPRITE_KEYS` and `REQUIRED_STRING_KEYS` in
`test/docs.test.ts`, so adding a required key without documenting it fails the
suite. Keep it that way — a stale guide is worse than none.

**Try tier 1 before tier 2.** A new variant should be a JSON patch in
`BUILT_IN_VARIANTS`. All published variants fit, including the one that
reshapes the whole board. Only add a code module when a rule needs logic the
schema genuinely cannot express, and say so in the commit message.

**Positions are grid coordinates, never pixels.** The renderer multiplies by
`tileSize` from the theme manifest. A theme with chunky 96px tiles and one with
flat 48px tiles must both just work.

## Source rules

`docs/rules-source.md` has the printed rules transcribed, plus what's still
unknown. Anything marked `[PROVISIONAL]` in the code is a guess — if you can
verify one against the real thing, fix it and drop the marker.

## The one open question that matters

**Board dimensions.** The rules confirm the structure (cross the pond, land on
shore/rocks/bench for 1/2/3 points) but not the size. The current boards are
reconstructions. This isn't cosmetic: board size determines whether the game is
playable at all, because the hazard removes pieces permanently and a long
crossing means everyone is eaten before anyone scores.

`scripts/simulate.ts` exists to measure exactly this. The number to watch is
`avgPiecesHome`. Current state:

| Variant        | avgPiecesHome (greedy) | Verdict                       |
| -------------- | ---------------------- | ----------------------------- |
| standard-4p    | ~2.3                   | plays, on the harsh side      |
| standard-2p    | ~4.8                   | good after shortening to 3 rows |
| triple-trouble | ~6.3                   | plays well                    |
| stork-escape   | ~2.7                   | plays                         |

Two-player originally sat at **0.0** — literally nobody ever scored — because
with only ten pieces the hazard is twice as concentrated per piece. Shortening
the crossing from five rows to three fixed it. If you change a board, re-run
the harness. A board that validates can still be unplayable.

## Known non-bugs

- Random agents score near zero on four-player. That's the agents, not the
  engine; the hazard removes pieces permanently and random play doesn't head
  home. Greedy agents score fine.
- `stork-escape` runs very long under random play (~1250 turns) because rescued
  pieces keep the game alive. Expected.
- Home pieces still occupy their cell and still block it. Deliberate — the
  contest for the 3-point cell is the heart of the game.

## Next steps, roughly in order

Done: the renderer and local hot-seat play. `npm run dev` serves the board at
`web/` on esbuild's dev server; `npm run build` writes `web/app.js`.

The browser side is four layers, and the split is the point — only the last one
touches the DOM, so everything above it is tested under plain node:

| Layer                  | Knows about                        |
| ---------------------- | ---------------------------------- |
| `src/renderer.ts` `layout()` | pixels. BoardView + Theme -> display list |
| `src/renderer.ts` `paint()`  | the DOM, and nothing else          |
| `src/ui/hotseat.ts`    | what a click means. Pure, no DOM    |
| `src/ui/help.ts`       | what the situation means. Pure, no DOM |
| `src/ui/main.ts`       | holds the state, wires the buttons  |

`hotseat.ts` never decides legality — it narrows `legalMoves()` down to what
the player pointed at, and hands back a `Move` for the caller to apply. That's
deliberate: the same module drives a networked client, where the Move goes to
the server instead of to `applyMove`.

`help.ts` is the same shape as `hotseat.ts` and sits beside it: state in, text
out, no DOM. The rules sheet is *generated from the live `RuleSet`* rather than
written out, so turning on Hop Share or editing the die changes what the page
says. A hand-written rules page would start lying the first time someone built
a variant. Every noun comes from the theme, so the help reads in the pack's own
vocabulary and no theme word is hard-coded.

`src/ui/default-theme.ts` is the art-less fallback pack. It is the one theme
that stays in the repo, so its vocabulary is abstract on purpose — "piece",
"hazard", "Move". Flavoured packs stay data, loaded at runtime.

Still to do:

1. **Variant editor.** A form bound to the `RuleSet` shape. Use `fork()` to
   clone, `validate()` to check, `exportVariant()` to share. The variant picker
   in the hot-seat page only lists `BUILT_IN_VARIANTS` so far.
2. **Theme loader UI.** Done: the folder picker runs `loadThemeFromFiles()`
   with `PLAIN_THEME` behind it, and `validateTheme()`'s problems are now
   listed next to the picker (and warned to the console). A path the picked
   folder has no file for is dropped at load, so the key falls through to the
   fallback and is reported as missing art rather than 404ing into a blank
   cell. What's left is nicer presentation — grouping, and a way to dismiss.
3. **Server.** Holds seed plus move log per room, validates with `applyMove`,
   broadcasts. Turn-based, so no lag compensation needed. Handle reconnect by
   replaying the log, and decide what happens when a player vanishes mid-game.
   The Undo button already does the replay trick locally — `replay(seed,
   log.slice(0, -1), board, rules)` — which is the same mechanism a reconnect
   will use.

Verified in a real browser on 2026-09-15: six scenarios driven through Chrome,
including a game played to completion, and the seven defects they turned up are
fixed. Worth knowing what that pass caught, because the same shapes will recur:

- Three of the seven were things no headless test could see — a highlight
  painted *under* the opaque piece it was meant to mark, a mid-chain leap whose
  interim landing existed in the Selection but was never handed to the
  renderer, and a HUD line that collapsed when empty and shifted the buttons
  out from under the cursor. Layout maths being right is not the same as the
  board being legible.
- The blocker was a theme pack with a manifest and no art: `loadThemeFromFiles`
  kept asset paths for files the picked folder didn't contain, so every sprite
  URL resolved against the page and 404'd into a blank board. It now drops a
  path with no file behind it, so the key falls through to the fallback.
- Interim UI state that the engine does not model — a half-built leap chain —
  has to be passed to `layout()` explicitly. The engine is right not to know
  about it, so the UI layer owns handing it across.

A palette block sits behind tiles but never behind pieces: tile art that fails
to load would leave a hole, whereas a piece sprite is a shape with transparent
corners and a block behind it renders as a square.

## Conventions

- TypeScript, strict mode, no emit. Relative imports carry the `.ts` extension
  so Node can run the sources with `--experimental-strip-types`.
- esbuild bundles the browser entry (`src/ui/main.ts` -> `web/app.js`). It is
  the only runtime-adjacent dependency, and it's dev-only: the engine, the
  rules and the test suite still have none.
- Tests use `node:test` with a tiny local `expect` shim (`test/expect.ts`) so
  the suite runs with zero dependencies. If you'd rather use a real test runner,
  swap the two imports at the top of the test file.
- Comments explain *why*, not *what*. Existing comments that record a rule or a
  decision are load-bearing; don't strip them.
