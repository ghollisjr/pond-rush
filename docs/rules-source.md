# Source rules

Transcribed from the published rule booklet (the "Play" and "Change" pages),
paraphrased rather than copied. This is the reference the engine implements.
Anything the booklet doesn't settle is listed under Open questions.

## Turn structure

Oldest player goes first; play continues clockwise. On your turn, roll the die
and carry out the action you rolled. One action per turn.

The die has six faces: three showing pips, two showing the leap icon, one
coloured face for the hazard.

### Pip faces — move

Move one of your pieces up to the number of **empty** spaces shown. Movement is
in any direction, **including diagonally**. You may not move into or over a
space occupied by a piece or by the hazard.

Engine notes: implemented as a BFS over destinations, since nothing happens en
route. Diagonals are on by default. There is no restriction toward home in the
standard game — sideways and backwards are both legal.

### Leap faces — jump

Jump one of your pieces in any direction, including diagonally, over one
neighbouring piece and into an empty space beyond. You may then make more jumps
with the same piece, continuing until you can't jump again or you choose to
stop. You may not jump over the hazard.

If none of your pieces can jump, **or you choose not to jump**, you may instead
move one of your pieces one space.

Engine notes: the single-space alternative is always offered, not just when no
jump exists — the booklet makes it a free choice. Every prefix of a chain is
emitted as its own legal move, so a player can stop anywhere.

### Coloured face — hazard

Move the hazard to any space occupied by a piece that is not already home. That
piece is removed from the game and set aside. The hazard stays in that space
until it is moved again. You may not take a piece that is already home.

Engine notes: unlimited range, mandatory when a legal target exists, and the
occupied cell stays blocked afterwards.

## Getting home

Pieces are only home, and only safe from the hazard, once they are moved all
the way across the pond and onto your home shore, rocks, or bench. Your home
bench matches your colour. Only pieces that are home score.

Engine notes: home cells are ordinary board cells with a point value. A piece
that lands on one settles permanently — it can't move again, and it keeps
blocking that cell. That blocking is what makes the high-value cells worth
racing for.

## Winning

The game ends **as soon as one player's pieces are all home or eaten**.

Scoring:

| Cell  | Points |
| ----- | ------ |
| Bench | 3      |
| Rocks | 2      |
| Shore | 1      |

Most points wins. (The booklet illustrates a player scoring 8.)

## Published variants

**Hop Share.** When you roll a pip face you may share the moves between several
pieces — roll a three and you could move one piece one space and another two
spaces, or three pieces one space each. Implemented as
`movement.shareMoves`.

**Stork Escape.** When you roll, you may carry out the action as normal, or skip
it to bring back one of your pieces that was eaten earlier, placing it on your
starting bench. Implemented as `rescue.enabled`.

This one matters more than it looks. Without it, a player whose opponents keep
rolling the hazard face can be removed from the game entirely with nothing they
can do about it, and the simulator confirms the effect is severe. Consider
defaulting it on for friendly play.

**Triple Trouble (3 players).** Rebuild the board so all three families start on
the same side of the pond, with the home shore, rocks, and bench **shared** by
all players. Implemented as `BOARD_3P`, whose home cells use `owner: "any"`.

The booklet also explicitly encourages players to change the rules and invent
their own — which is the entire justification for the variant system.

## Open questions

1. **Board dimensions.** The biggest unknown, and the one that affects
   playability. Current boards are reconstructions consistent with the rules
   but not verified. See CLAUDE.md for why this matters and how to measure it.
2. **Exact composition of a home zone.** Currently five cells per player in a
   1-2-3-2-1 arrangement. The counts of shore, rocks, and bench cells on the
   real board are unconfirmed.
3. **Starting position.** Modelled as a bank of cells on your own side of the
   pond. The booklet's phrase "starting bench" suggests this is right, but
   whether starting cells sit on the board or beside it is unconfirmed.
4. **Pip values.** Assumed 1, 2, and 3 on the three pip faces.
5. **Three-player board shape.** Known to be a rebuild with shared home cells;
   exact geometry unconfirmed.

## Sources

- The rule booklet pages, read directly.
- A contemporary review that independently describes the die composition
  (three pip faces, two leap faces, one hazard face) and confirms the variant
  page exists.
