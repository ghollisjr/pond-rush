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

**A legal move is never hidden, only marked.** Taking your own piece with the
hazard is legal — the booklet says "any space occupied by a piece" — and it is
never forced (0 of 372 hazard rolls had no other target). The board tints
those cells with the `warning` colour and the help says why, rather than
`hazardMoves` quietly dropping them. Removing a legal move is a rules change
and belongs in a `RuleSet` flag, not in the UI.

**Positions are grid coordinates, never pixels.** The renderer multiplies by
`tileSize` from the theme manifest. A theme with chunky 96px tiles and one with
flat 48px tiles must both just work.

This is what let the board be tilted into perspective without touching
anything above the renderer: `Scene.tilt` lays the whole plane back and a test
asserts it moves no sprite's `x` or `y`. It also means **the hit test must not
invert the layout maths.** `coordAt()` does, and is therefore only valid on a
flat board; the UI uses `coordFromElement()`, which reads `data-r`/`data-c`
off whatever the browser hit-tested. That is projection-independent and is
what an isometric or WebGL renderer would use too. Do not route clicks back
through pixel arithmetic.

**The address bar describes the current thing, and nothing else writes to
it.** The URL carried the whole local game and rewrote itself on every move,
which was wrong twice: during an online game it still showed a stale local
link, so copying the URL handed someone an empty game rather than the room;
and rewriting the hash at boot swallowed `#room=` invites before the handler
could read them. Now it names the room when online and is clean otherwise.
Resuming is `localStorage`'s job; a shareable game link is something the
player asks for with a button. Only one link control is ever visible — in a
room, the invite is the only link that means anything.

**A control that cannot work must not look pressable, and a hidden one must
actually be hidden.** Both halves were broken. `Host` and `Join` stayed fully
live while the panel said the server was unreachable, and `Roll` was live in a
room that was still waiting for players — the server refused, so the only
feedback was an error. And `.row { display: flex }` outranks the browser's own
`[hidden] { display: none }`, so *every* `.row[hidden]` on the page was
visible: "Copy invite" and "Leave" showed with no room joined. There is now a
`[hidden] { display: none !important }` rule and a test asserting it.

Auditing this by reading the `hidden` attribute is how the second bug survived
a deliberate audit. Check geometry — `getBoundingClientRect()` — not
attributes.

**A control must never change the layout around itself.** The tilt slider
first sized the board's stage from the current tilt, so dragging it reflowed
the page and moved the slider out from under the cursor. The HUD's face line
had the same bug when it collapsed while empty. Reserve the space as a
constant, and do presentational resizing inside a `transform`, which costs no
reflow.

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
| standard-4p    | ~1.5                   | harsh                         |
| standard-2p    | ~4.6                   | good after shortening to 3 rows |
| triple-trouble | ~5.3                   | plays well                    |
| hop-share      | ~1.4                   | plays; no measurable effect on this number |
| stork-escape   | ~1.5                   | plays                         |
| gap-jump       | ~2.6                   | best of the 4p set — see below |
| house          | ~1.5                   | plays                         |

**These numbers moved once, and the reason matters.** The greedy agent scored
every hazard placement identically, so it ate *its own* pieces on 27% of
hazard turns. Fixing it to prefer the opponent nearest home did not raise the
scores — it lowered them, across the board, because the agents became lethal
to each other instead of to themselves. Four-player is harsher than the
earlier table claimed, not kinder. If you change the agent again, expect every
row to move, and do not compare numbers across agent versions.

**Gap Jump is the most promising answer to four-player harshness.** It lifts
`avgPiecesHome` from ~1.5 to ~2.6 — a 73% improvement that survived the agent
fix — and shortens the game (164 -> 147 turns), without the runaway length
Stork Escape causes under random play. That
is a bigger improvement than either published variant manages, which is worth
knowing before anyone reshapes the 4p board to fix the same problem. It is
also `[PROVISIONAL]` and unverified against the booklet, so treat it as a good
house rule rather than evidence about the real game.

Note Hop Share and Stork Escape barely move this number under greedy play.
Stork Escape's value is that it stops a player being eliminated outright, which
`avgPiecesHome` does not capture — check the random-agent rows for that.

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

Done since: play-by-link. `src/session.ts` encodes a game as
`v1.<variant>.<seed>.<varint move indices>` and replays it. The indices work
because `legalMoves` is a deterministic function of the state, so "the nth
legal option" is a complete description of a move — 255 characters for a
112-move game against 4677 as JSON. That is also why a tampered link is safe:
an index that is not a legal move cannot be misread as a different move, only
rejected. The same encoding is what the server will store, so this is not a
detour around roadmap item 3 — it is the wire format arriving early.

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
3. **Server.** Built, tested, and not yet wired to the browser.
   `src/room.ts` is the rules of a shared game (pure, no HTTP, no clock,
   no storage); `src/server-api.ts` is a plain `Request -> Response` function;
   `server/main.ts` is the only host-specific file and supplies just storage,
   a clock and randomness. Polling, not sockets: turn-based play does not
   notice two seconds, and every response carries the move-log position, which
   makes reconnect identical to a normal fetch rather than a special case.

   Two things carry the security, and both come from decisions made long
   before there was a server. Clients never roll, so a client cannot
   manufacture a good face. And a move is sent as an *index* into
   `legalMoves`, so a client cannot describe an illegal move at all — only
   name one that does not exist, which is rejected by counting. There is no
   parsing of untrusted move objects anywhere. `expect` (the client's belief
   about the move count) makes it compare-and-swap rather than trust.

   The browser side is wired: `src/ui/online.ts` is the API client,
   `src/ui/config.ts` says where the server is, and `main.ts` routes moves
   through it and polls every 2.5s. Online is additive — `net === null` and
   the page is exactly what it was. Verified with two browser profiles against
   the deployed server: host, invite, join, turn gating, and a move appearing
   in the other browser.

   **The server needs a Deno KV database attached, and its absence is
   invisible.** Without one `Deno.openKv` does not exist, each isolate keeps
   rooms in its own memory, and a game vanishes on whichever request happens
   to land elsewhere. `/api/health` reports `storage` and `durable` for
   exactly this reason — check it before debugging anything else.

   Still to do: what happens when a player abandons a game, and whether a
   room should ever be reclaimable. Rooms currently expire after 30 days.

Three bugs that only a browser could show, all from wiring the client to the
server, all green in CI while the page was broken:

- `this.fetcher = fetch` and then `this.fetcher(...)` passes the client as the
  receiver. Browsers refuse that outright ("Illegal invocation"); node does
  not mind, so every network call was broken in the page and passing in the
  suite. Lift a function out of `this` before calling it, and make the test
  double as fussy as the browser.
- `publish()` rewrites `location.hash` at boot, so anything reading the hash
  later sees the current game rather than what the page was opened with. Every
  `#room=` invite was silently swallowed. Capture the opening hash once.
- Hosting a four-player game alone deadlocks two moves in: turn order visits
  every seat, and an empty seat is a turn nobody can take.

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
- A `describe` body that throws does not register its block, and the run
  still prints `fail 0` — only a stray `✖` line gives it away. Check the test
  *count* moved, not just that nothing failed.
- Everything in `src/` must survive `--experimental-strip-types`, which erases
  types without rewriting code. Constructor parameter properties
  (`constructor(readonly x: number)`) are *code*, not types, and fail at run
  time while typechecking cleanly — write the field out. `server/` is excluded
  from `tsc` because it names Deno globals; the logic it wraps lives in `src/`
  and is checked and tested like everything else.
