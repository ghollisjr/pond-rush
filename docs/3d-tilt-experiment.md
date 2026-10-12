# Experiment: a tilted, 3D-perspective board

Branch `experiment/3d-tilt`. Not merged.

## What it does

A slider lays the board back from 0° (the flat top-down board) to 65°. The
whole board is one rotated plane: tiles lie flat on it, pieces and the hazard
counter-rotate so they stand up facing the viewer.

No new dependencies, no new art. The existing SVG pack is reused as-is.

## Why it was cheap

The engine, `rules.ts`, `hotseat.ts` and `help.ts` are untouched, and so is
`layout()`'s maths. Positions are grid coordinates everywhere and only the
renderer multiplies by `tileSize`, so a projection is a renderer concern and
nothing above it needs to know. A test asserts this directly: tilting changes
no sprite's `x` or `y`.

The whole change is three things:

1. `Scene.tilt`, carried from `LayoutOptions` and applied by `paint()` as a
   `perspective(...) rotateX(...)` on the container.
2. Pieces and the hazard get `rotateX(-tilt)` with `transform-origin: center
   bottom`, so they hinge up from the back edge of their cell.
3. The hit test.

## The hit test is the interesting part

`coordAt()` inverts the layout maths — `floor(px / tileSize)`. That is only
valid while the board is an unrotated rectangle. Under a perspective
transform, screen position no longer inverts to a grid cell at all, and every
click would land on the wrong square.

The fix needed no maths. `paint()` already stamps `data-r`/`data-c` on every
element, and the browser already hit-tests transformed elements correctly, so
`coordFromElement()` walks up from `event.target` and reads the cell off it.
That is projection-independent: it works flat, tilted, and would work for a
full isometric or WebGL renderer with a raycaster behind it.

`coordAt()` is kept for the flat case and is still tested, but the UI no
longer uses it.

## Two things the first pass got wrong

**The slider was unusable.** `render()` sized the stage padding from the
current tilt, so every step of the drag reflowed the page and moved the slider
out from under the cursor — with a CSS transition on the padding making it
worse. This is the same failure as the HUD line that collapsed when empty and
shifted the buttons: *never let a control's own effect change the layout
around that control.* The stage padding is now a constant and the plane is
shrunk inside the transform instead, which costs no reflow. A test drags
through six tilt values and asserts the slider's rect never moves.

**There was no sense of depth.** A perspective transform alone is not depth:
it squashes the board without telling you anything is above it. Three cheap
fixes did most of the work — a blurred contact shadow under every standing
piece (the single biggest cue, because it puts a piece *on* a cell rather than
over it), a shorter viewer distance (1200px read as merely squashed; 800px
recedes), and a radial gradient behind the plane to act as a horizon.

## What is still unresolved

- **Depth at the back.** At high tilt the far row's pieces crowd into the home
  tiles behind them. Real isometric art with proper depth sorting would fix
  this; billboarded sprites cannot.
- **No elevation.** Everything is on one plane. Pieces do not sit *on* tiles,
  they hinge from them, which reads fine in motion but is not real 3D.
- **The shadow is drawn, not themed.** It is a CSS ellipse under
  `overlay.shadow`, so a pack cannot restyle it. If packs ever want their own,
  it should become a real sprite key.
- **Mobile.** Untested. A tilted board at a phone width may be unusable.

## Verdict

Worth keeping as an option, not as the default. It costs almost nothing and
makes the board read as an object on a table. If the look is wanted properly,
the next step is true isometric — project in `layout()`, sort by `r + c`, and
redraw the pack — which is a bigger job because of the art, not the code.
