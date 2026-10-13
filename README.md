# Pond Rush

[![Build and deploy](https://github.com/ghollisjr/pond-rush/actions/workflows/pages.yml/badge.svg)](https://github.com/ghollisjr/pond-rush/actions/workflows/pages.yml)

**[Play it here](https://ghollisjr.github.io/pond-rush/)** — hot seat, four
players on one screen. Press Roll; the Help panel beside the board explains
whatever is in front of you.

A small turn-based board game: families of pieces race across a pond to a
scoring shore while a hazard picks them off. Built so that both the **rules**
and the **art** are swappable at runtime.

Two independent swap points, which is the whole point of the design:

- **Rulesets are data.** Variants are JSON patches over a base. Users can build
  their own in a UI, save them, and send them to each other as a string.
- **Themes are resource packs.** The engine emits abstract keys
  (`piece.player0`, `tile.home.bench`); a theme maps those to art and text. The
  engine contains no theme-specific vocabulary at all. See
  **[docs/theme-packs.md](docs/theme-packs.md)** to make one.

## Playing with other people

There is no server. A game is fully described by three things — variant, seed,
and the moves — and because the engine is pure and `legalMoves` is
deterministic, a move can be written as its *index* in that list rather than
its contents. A 112-move game is 255 characters that way, against 4677 as
JSON, which is the difference between a link you can send and one you cannot.

So: take your turn, press **Copy link**, send it. The next player opens it and
sees the exact board you left. Turn-based, so latency is irrelevant, and
nothing needs hosting.

```
ghollisjr.github.io/pond-rush/#g=v1.standard-4p.1.ACwAAAAIAAAALgAA
                                  └ format
                                     └ variant
                                                └ seed
                                                  └ moves, as varint indices
```

Games are also kept in `localStorage`, so closing the tab and coming back
resumes where you were.

What this does **not** do is enforce anything. Anyone can edit a link, and
nobody is authenticated — the game is as honest as the people playing it. For
friends passing turns that is the right trade. The server in the roadmap is
what replaces it when it is not, and the encoding here is already the wire
format that server would use, so none of it is wasted.

A corrupted or tampered link is rejected rather than played: an index that
is not a legal move cannot be anything but damage, so `replayIndices` throws
and the page starts a new game and says why.

## Playing with other people, properly

`server/` is a small HTTP API that holds rooms and validates every move with
the same `applyMove` the browser uses — one implementation of the rules, not
two. It is shared code plus about 200 lines. See
[server/README.md](server/README.md) to run or deploy it.

The play-by-link mode above needs no server and is not going away: it is what
the GitHub Pages build uses, and it is the fallback whenever no server is
configured.

## Deploying

Every push to `main` runs the suite and the typechecker, bundles
`src/ui/main.ts`, and publishes `web/` to GitHub Pages
(`.github/workflows/pages.yml`). The deploy is gated on the tests: a board that
validates can still be unplayable, so the least CI can do is refuse to ship a
build that does not pass.

`npm run build` writes `dist/`: `index.html`, the default theme pack, and the
bundle under a content-hashed name (`app.<hash>.js`). The hash is why a deploy
cannot be served half-stale — GitHub Pages caches assets for ten minutes, and
a plain `app.js` means a new page can load an old bundle. Hashing does not make
`index.html` itself fresh (Pages caches that too, and the headers are not
ours), but it guarantees the pair is always consistent and that new HTML never
reuses a cached bundle.

Dev is unaffected: `npm run dev` serves `web/` with a plain `app.js`, which is
what `web/index.html` references. The build rewrites that reference, and fails
rather than publishing a page that loads nothing if it cannot find it.

Everything the page loads is referenced by relative path, which is what lets it
serve from a project subpath (`/pond-rush/`) without a base-URL setting.

## Running it

Needs Node 22.6+. The tests and the simulator run with **no install at all** —
Node strips the TypeScript directly.

```bash
node --experimental-strip-types --test test/*.test.ts   # 27 tests
node --experimental-strip-types scripts/simulate.ts 200 # balance harness
```

Or via npm scripts:

```bash
npm test
npm run simulate -- 200
npm install && npm run typecheck   # typecheck needs @types/node
```

## Layout

```
src/rules.ts        Rule schema, board format, variants, validation, persistence
src/pond-engine.ts  Pure engine: state, legal moves, applying moves, scoring
src/theme.ts        Theme manifest types and loaders (URL and local folder)
web/theme/          The default pack: original SVG art. A worked example
src/themes/lilypad/ A deliberately art-less manifest, kept as a test fixture
test/engine.test.ts 27 tests, doubling as executable rules documentation
scripts/simulate.ts Balance harness — plays thousands of games, reports scoring
docs/rules-source.md The source rules, transcribed, with open questions
```

## Architecture

**The engine is pure.** `applyMove(state, move) -> newState`, no mutation, no
I/O. That gives undo, server-side validation, and replay for free.

**Multiplayer is a seed plus a move log.** Dice are derived deterministically
from `(seed, rollCount)`, so clients never roll. To sync a reconnecting player,
send the seed and the log and call `replay()`. To validate a move, call
`applyMove` — it throws on anything illegal. This closes the obvious cheat with
no extra machinery.

**Themes never touch the server.** Game state travels as abstract terms
("player 2's piece moved to 4,1"); each client renders that with whatever pack
it has locally. Two players in the same match can run different themes and
nothing notices. `loadThemeFromFiles()` reads a folder the user picks and turns
assets into `blob:` URLs — nothing is uploaded anywhere.

**Boards are token grids.** A row is a string like `S1 H3s . . . H1s S3`, each
token resolved through a legend. Tokens compose with `+` when a cell is two
things at once. This is what lets a variant reshape the board without code.

### Adding a variant

Most variants are four lines. Add to `BUILT_IN_VARIANTS` in `src/rules.ts`:

```ts
{
  id: "my-variant",
  name: "My Variant",
  description: "What it changes and why.",
  extends: "standard-4p",
  rules: { hazard: { effect: "reset" } },
}
```

`VariantRegistry.resolve()` walks the `extends` chain and folds every patch into
one concrete config. Reach for a code module (`rules.modules`) only when a rule
genuinely can't be expressed as different numbers or flags — none of the
published variants needed one.

Always run `validate(rules, board)` before playing a custom set. It catches
rulesets that can never end, boards where a player can be walled in, and
configurations that are legal but miserable.

## Current state

Working: full rules engine, all published variants, validation, variant
import/export, theme loader, renderer, local hot-seat play with contextual
help, and a generated SVG default theme. 89 passing tests, deterministic
replay verified across thousands of simulated games, and the page driven
through a real browser for six scenarios including a game to completion.

Not built yet: the variant-editing UI and the multiplayer server. The Undo
button already does the server's reconnect trick locally — `replay(seed,
log.slice(0, -1), board, rules)`.

## Legal note

The rules and mechanics of a board game aren't copyrightable, and this codebase
contains only original text and original structure. Keep it that way:

- Ship original art as the default theme. It's a real product on its own.
- Never commit a theme that reproduces someone else's trade dress, and never
  host one. A pack passed privately between friends is a different thing from a
  public download.
- Keep other companies' trademarks out of the project name, the UI, the
  repository, and any store listing.
