// ============================================================================
// ui/help.ts
//
// Explains the game to the person playing it. Three things:
//
//   explainNow()   what is happening this instant and what each option means
//   rulesSheet()   a reference for THIS game, read off the active RuleSet
//   tutorial()     the short version, for someone who has never played
//
// Pure and DOM-free, like hotseat.ts next door: state in, text out. That makes
// the wording testable, and it keeps main.ts free of prose.
//
// Every noun comes from the theme — "piece"/"hazard" under the fallback pack,
// whatever a flavoured pack calls them otherwise. Nothing here hard-codes a
// theme word, and nothing here decides what is legal: the options listed are
// the ones `legalMoves` actually returned.
//
// The rules sheet is generated rather than written out because the ruleset is
// data. Turn on Hop Share and the sheet says so; change the die and the sheet
// counts the new faces. A hand-written page would quietly start lying the
// first time somebody edits a variant.
// ============================================================================

import { legalMoves, type GameState } from "../pond-engine.ts";
import type { Theme } from "../theme.ts";
import {
  confirmableMove,
  rescuablePieces,
  selfTargets,
  type Selection,
} from "./hotseat.ts";

export interface HelpOption {
  /** What to do, in the imperative. */
  label: string;
  /** What it means, and when you would want it. */
  text: string;
}

export interface NowPanel {
  /** The situation, in a few words. */
  headline: string;
  /** What that situation means. */
  detail: string;
  /** What to do next, one entry per thing actually available. */
  options: HelpOption[];
}

export interface HelpSection {
  title: string;
  paras: string[];
}

// ---------------------------------------------------------------------------
// Theme words
// ---------------------------------------------------------------------------

interface Words {
  piece: string;
  pieces: string;
  hazard: string;
  move: string;
  leap: string;
  hazardAction: string;
  home: string;
}

function words(theme: Theme): Words {
  return {
    piece: theme.text("piece.singular", "piece"),
    pieces: theme.text("piece.plural", "pieces"),
    hazard: theme.text("hazard.primary", "hazard"),
    move: theme.text("action.move", "Move"),
    leap: theme.text("action.leap", "Leap"),
    hazardAction: theme.text("action.hazard", "Hazard"),
    home: theme.text("zone.home", "home"),
  };
}

/** Scoring cells on this board, worth the most first. */
function scoringCells(
  state: GameState,
  theme: Theme
): { name: string; points: number }[] {
  const byKey = new Map<string, number>();
  for (const row of state.cells) {
    for (const cell of row) {
      if (cell.home) byKey.set(cell.tileKey, cell.home.points);
    }
  }
  return [...byKey]
    .map(([tileKey, points]) => ({
      // "tile.home.bench" -> the theme's word for that zone.
      name: theme.text(`zone.${tileKey.split(".").pop()}`, tileKey.split(".").pop()!),
      points,
    }))
    .sort((a, b) => b.points - a.points);
}

// ---------------------------------------------------------------------------
// What is happening right now
// ---------------------------------------------------------------------------

export function explainNow(
  state: GameState,
  sel: Selection,
  theme: Theme
): NowPanel {
  const w = words(theme);
  const moves = legalMoves(state);
  const has = (kind: string) => moves.some((m) => m.kind === kind);
  const options: HelpOption[] = [];

  if (state.phase === "finished") {
    const who =
      state.winners.length > 1
        ? `Players ${state.winners.map((p) => p + 1).join(" and ")} tie`
        : `Player ${state.winners[0] + 1} wins`;
    return {
      headline: who,
      detail:
        `The game ended the moment one player had no ${w.pieces} left in ` +
        `play — every one of them either ${w.home} or eaten. Only ${w.pieces} ` +
        `that got ${w.home} scored.`,
      options: [
        { label: "New game", text: "Pick a variant and a seed, and start again." },
      ],
    };
  }

  if (state.phase === "awaiting_roll") {
    return {
      headline: `Player ${state.turn + 1}'s turn`,
      detail:
        `Roll to find out what you may do. You get one action per turn, and ` +
        `the die decides which: a ${w.move.toLowerCase()}, a ` +
        `${w.leap.toLowerCase()}, or the ${w.hazard}.`,
      options: [
        {
          label: "Roll",
          text:
            `The seed decides every roll in advance, so the same seed always ` +
            `plays out the same way. Undo is therefore safe — it cannot ` +
            `re-roll you a better face.`,
        },
      ],
    };
  }

  // Mid-action. What the face lets you do, then what the board is showing.
  const face = state.pending!;
  let headline: string;
  let detail: string;

  if (face.kind === "move") {
    headline = `${w.move} — ${state.spacesLeft} ${
      state.spacesLeft === 1 ? "space" : "spaces"
    }`;
    detail =
      `Move one ${w.piece} up to ${state.spacesLeft} empty ` +
      `${state.spacesLeft === 1 ? "space" : "spaces"}, in any direction` +
      `${state.rules.movement.diagonals ? ", diagonals included" : ""}. You ` +
      `cannot pass through a ${w.piece} or the ${w.hazard} on the way.`;
    if (state.rules.movement.shareMoves) {
      detail +=
        ` This game has Hop Share on, so you may split those spaces between ` +
        `several ${w.pieces} instead of spending them all on one.`;
    }
  } else if (face.kind === "leap") {
    headline = w.leap;
    detail =
      `Jump one ${w.piece} two spaces into the empty space beyond the cell ` +
      `next to it` +
      `${state.rules.leap.diagonals ? ", diagonals included" : ""}. ` +
      `${state.rules.leap.overGaps
        ? `Gap Jump is on: the cell you clear may be empty, so you do not ` +
          `need a neighbour to jump over — but clearing a gap ends the chain.`
        : state.rules.leap.overOwnOnly
          ? `That cell must hold one of your own ${w.pieces}.`
          : `That cell must hold a ${w.piece} — anyone's will do, so ` +
            `opponents are a staircase.`}` +
      `${state.rules.leap.canLeapHazard ? "" : ` You may not jump the ${w.hazard}.`}`;
    if (state.rules.leap.chaining) {
      detail += ` A landing that sets up another jump lets you keep going.`;
    }
  } else {
    headline = w.hazardAction;
    detail =
      `Move the ${w.hazard} onto any ${w.piece} that is not already ` +
      `${w.home}. That ${w.piece} is ` +
      `${state.rules.hazard.effect === "capture"
        ? "out of the game for good"
        : "sent back to its starting cell"}` +
      `. Every cell you may place it on is lit.`;
    if (state.rules.hazard.blocksCell) {
      detail += ` The ${w.hazard} then blocks that cell until it moves again.`;
    }
  }

  // Board state the player is looking at, which changes what to tell them.
  if (sel.rescuing) {
    options.push({
      label: `Place the ${w.piece}`,
      text: `Click one of the lit starting cells to bring it back.`,
    });
  } else if (sel.path.length) {
    options.push({
      label: "Keep jumping",
      text:
        `The lit cells are the next jumps available from where the chain ` +
        `has reached. Each one is optional.`,
    });
    const stop = confirmableMove(sel);
    if (stop) {
      options.push({
        label: "Stop here",
        text:
          `Ends the chain where it stands. Stopping short is often right — ` +
          `the far cell may be a worse place to be caught.`,
      });
    }
  } else if (sel.piece) {
    options.push({
      label: "Pick a lit cell",
      text: `Those are every landing this ${w.piece} can legally reach.`,
    });
    options.push({
      label: "Click it again",
      text: `Puts the ${w.piece} back down so you can choose another.`,
    });
  } else if (face.kind === "hazard") {
    options.push({
      label: `Place the ${w.hazard}`,
      text: `Click any lit cell. Each one holds a ${w.piece} you may take.`,
    });
    if (selfTargets(state).length) {
      options.push({
        label: "Red cells are yours",
        text:
          `Taking your own ${w.piece} is legal, and almost never worth it: ` +
          `you lose it for good and the ${w.hazard} then blocks the cell.`,
      });
    }
  } else {
    options.push({
      label: `Pick a ${w.piece}`,
      text: `The ones ringed in yellow are yours and can act this turn.`,
    });
  }

  if (rescuablePieces(state).length) {
    options.push({
      label: `Bring one back`,
      text:
        `Stork Escape: give up this turn's action instead to return an eaten ` +
        `${w.piece} to a free starting cell.`,
    });
  }

  if (has("pass")) {
    options.push({
      label: "Pass",
      text: `Do nothing this turn. Always allowed, rarely what you want.`,
    });
  }

  if (state.history.length) {
    options.push({
      label: "Undo",
      text: `Replays the game one move shorter. The roll is part of the log, so undoing far enough takes back the roll too.`,
    });
  }

  return { headline, detail, options };
}

// ---------------------------------------------------------------------------
// The reference sheet, generated from the active ruleset
// ---------------------------------------------------------------------------

export function rulesSheet(state: GameState, theme: Theme): HelpSection[] {
  const w = words(theme);
  const r = state.rules;

  // Describe the die this game is actually using.
  const pips = r.die.filter((f) => f.kind === "move") as { spaces: number }[];
  const leaps = r.die.filter((f) => f.kind === "leap").length;
  const hazards = r.die.filter((f) => f.kind === "hazard").length;
  const pipList = pips.map((f) => f.spaces).join(", ");

  const scoring = scoringCells(state, theme);
  const best = scoring[0];

  const sections: HelpSection[] = [
    {
      title: "The goal",
      paras: [
        `Get your ${w.pieces} across the pond and onto your ${w.home}. Only ` +
          `${w.pieces} that make it there score, and once one arrives it is ` +
          `safe for good — but it also stops moving, and it keeps blocking ` +
          `the cell it sits on.`,
        scoring.length
          ? `Cells are worth: ${scoring
              .map((s) => `${s.name} ${s.points}`)
              .join(", ")}. Most points wins.`
          : `Most points wins.`,
      ],
    },
    {
      title: "Your turn",
      paras: [
        `Roll, then carry out what you rolled. One action per turn.`,
        `This game's die has ${r.die.length} faces: ${pips.length} that move ` +
          `(${pipList}), ${leaps} that ${w.leap.toLowerCase()}, and ` +
          `${hazards} for the ${w.hazard}.`,
      ],
    },
    {
      title: w.move,
      paras: [
        `Move one ${w.piece} up to the number of empty spaces shown, in any ` +
          `direction${r.movement.diagonals ? " including diagonally" : ""}. ` +
          `You may not move into or through an occupied space.`,
        r.movement.shareMoves
          ? `Hop Share is on: you may split the spaces between several ${w.pieces}.`
          : `The whole roll goes to one ${w.piece}.`,
      ],
    },
    {
      title: w.leap,
      paras: [
        `Jump a ${w.piece} two spaces, landing on the empty space beyond the ` +
          `cell next to it` +
          `${r.leap.diagonals ? ", diagonally too" : ""}. ` +
          (r.leap.chaining
            ? `Keep jumping with that same ${w.piece} as long as jumps are ` +
              `there, and stop whenever you like.`
            : `One jump only.`),
        r.leap.overGaps
          ? `Gap Jump: the cell you clear may be empty as well as occupied, ` +
            `so a one-space gap is jumpable with nothing in it — a leap face ` +
            `is never wasted. Clearing a gap ends the chain, though: only a ` +
            `${w.piece} you jump sets up another jump.`
          : `The cell you clear must hold a ${w.piece}.`,
        r.leap.declineToStep
          ? `You may always decline to jump and move one ${w.piece} a single ` +
            `space instead — it is a free choice, not a fallback.`
          : `If you cannot jump, your turn passes.`,
        r.leap.canLeapHazard
          ? `The ${w.hazard} may be jumped.`
          : `The ${w.hazard} may not be jumped.`,
      ],
    },
    {
      title: w.hazard,
      paras: [
        `Move the ${w.hazard} onto any ${w.piece} not already ${w.home} — ` +
          `your own included, though that is rarely wise. ` +
          (r.hazard.effect === "capture"
            ? `That ${w.piece} is removed from the game permanently.`
            : `That ${w.piece} goes back to its starting cell.`),
        r.hazard.homeIsSafe
          ? `${w.pieces[0].toUpperCase()}${w.pieces.slice(1)} that are ${w.home} cannot be taken.`
          : `Nothing is safe, ${w.home} included.`,
        `This is why the race matters: a ${w.piece} still in the water is a ` +
          `${w.piece} that can be lost, and the ${best ? best.name : "best"} ` +
          `cell is the one everybody wants.`,
      ],
    },
    {
      title: "Ending",
      paras: [
        r.victory.endWhen === "any_player_settled"
          ? `The game ends the moment any one player has no ${w.pieces} left ` +
            `in play — all ${w.home} or all eaten. Everyone scores what they ` +
            `have banked at that moment, so a player racing home can end it ` +
            `while you still have ${w.pieces} in the water.`
          : `The game runs until every player has no ${w.pieces} left in play.`,
        r.victory.tiebreak === "shared"
          ? `A tie on points is shared.`
          : `A tie on points goes to the earlier player.`,
      ],
    },
  ];

  if (r.rescue.enabled) {
    sections.splice(5, 0, {
      title: "Stork Escape",
      paras: [
        `Instead of the action you rolled, you may bring one eaten ` +
          `${w.piece} back to a free starting cell.` +
          (r.rescue.maxPerGame === null
            ? ` No limit on how often.`
            : ` Up to ${r.rescue.maxPerGame} times per game.`),
      ],
    });
  }

  return sections;
}

// ---------------------------------------------------------------------------
// First game
// ---------------------------------------------------------------------------

export function tutorial(theme: Theme): HelpSection[] {
  const w = words(theme);
  return [
    {
      title: "1. Roll",
      paras: [
        `Press Roll. The face you get decides your one action for the turn ` +
          `— there is no choosing between them.`,
      ],
    },
    {
      title: `2. Pick a ${w.piece}`,
      paras: [
        `Your ${w.pieces} that can act are ringed in dashed yellow. Click ` +
          `one and the ring goes solid: that is the ${w.piece} in your hand.`,
      ],
    },
    {
      title: "3. Pick a destination",
      paras: [
        `Every cell it can legally reach lights up. Click one to go there. ` +
          `Click the ${w.piece} again instead to put it back down.`,
        `On a ${w.hazard} roll there is no ${w.piece} to pick — the lit ` +
          `cells are the ${w.pieces} you may take, so just click one.`,
      ],
    },
    {
      title: "4. Chains",
      paras: [
        `After a ${w.leap.toLowerCase()} you may be offered another jump ` +
          `from where you landed. Keep clicking to continue, or press ` +
          `"Stop here" to end the chain and your turn.`,
      ],
    },
    {
      title: "5. Get home and stop",
      paras: [
        `A ${w.piece} that lands on your ${w.home} is safe and scores — but ` +
          `it is also finished, and it blocks that cell for everyone. The ` +
          `game ends as soon as one player has nothing left in the water, so ` +
          `do not leave your scoring run too late.`,
      ],
    },
    {
      title: "Stuck?",
      paras: [
        `Help stays open beside the board and describes whatever is in front ` +
          `of you. Undo takes back as far as you like — the dice are fixed by ` +
          `the seed, so you cannot cheat your way to a better roll.`,
      ],
    },
  ];
}
