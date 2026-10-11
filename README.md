# Pond Rush

A small turn-based board game: families of pieces race across a pond to a
scoring shore while a hazard picks them off. Built so that both the **rules**
and the **art** are swappable at runtime.

Two independent swap points, which is the whole point of the design:

- **Rulesets are data.** Variants are JSON patches over a base. Users can build
  their own in a UI, save them, and send them to each other as a string.
- **Themes are resource packs.** The engine emits abstract keys
  (`piece.player0`, `tile.home.bench`); a theme maps those to art and text. The
  engine contains no theme-specific vocabulary at all.

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
src/themes/lilypad/ Example theme manifest
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
import/export, theme loader, 27 passing tests, deterministic replay verified
across thousands of simulated games.

Not built yet: the renderer, the theme-editing UI, the variant-editing UI, and
the multiplayer server. `view(state)` is the interface the renderer should be
written against.

## Legal note

The rules and mechanics of a board game aren't copyrightable, and this codebase
contains only original text and original structure. Keep it that way:

- Ship original art as the default theme. It's a real product on its own.
- Never commit a theme that reproduces someone else's trade dress, and never
  host one. A pack passed privately between friends is a different thing from a
  public download.
- Keep other companies' trademarks out of the project name, the UI, the
  repository, and any store listing.
